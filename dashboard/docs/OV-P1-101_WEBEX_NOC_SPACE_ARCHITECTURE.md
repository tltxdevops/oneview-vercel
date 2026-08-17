# OV-P1-101 — Webex NOC Space Architecture (planejamento)

**Tipo:** arquitetura / planejamento (sem implementação)  
**Data:** 2026-08-12  
**Fora de escopo desta entrega:** criar bot Webex, chamar Webex API, implementar consumer/dispatcher, migration, deploy, commit, Theo, browser notifications.

---

## 1. Objetivo

Centralizar **chamados operacionais ServiceNow** em **um único Space privado Webex** para a equipe NOC selecionada, com notificações tipadas e idempotentes.

Canal: **integração server-side direta OneView → Webex** (Bot Token + Room ID).  
Não usar Theo. Não usar browser notification.

---

## 2. Arquitetura alvo

```text
ServiceNow (incident Table API, GET)
        │
        ▼
┌───────────────────────┐
│  Incident Evaluator   │  (Worker VM — novo módulo)
│  - poll / delta SN    │
│  - elegibilidade MVP  │
│  - monta eventos      │
└───────────┬───────────┘
            │ INSERT (idempotent)
            ▼
┌───────────────────────┐
│  integration_outbox   │  PostgreSQL (já existente)
│  action_type=webex_*  │
└───────────┬───────────┘
            │ claim pending
            ▼
┌───────────────────────┐
│  Webex Dispatcher     │  (Worker VM — consumer)
│  - retry / rate limit │
│  - POST messages      │
└───────────┬───────────┘
            │
            ▼
     Webex Space NOC (privado)
```

### Princípios alinhados ao OneView

| Regra | Aplicação |
|---|---|
| Vercel não chama integrações externas “quentes” desnecessárias | Evaluator + Dispatcher no **Worker VM**; BFF só leitura/UI |
| Segredos só server-side | `WEBEX_BOT_TOKEN`, `WEBEX_NOC_ROOM_ID` no worker/secret store — **nunca** no frontend/`VITE_*` |
| Outbox como contrato de integração | Reutilizar `integration_outbox` (já usada por `request_sync` / ACK) |
| ServiceNow read-only no BFF hoje | Poll SN continua **GET-only**; Webex é o único write externo deste card |

### O que **não** entra

- Theo / qualquer bridge Teams→Webex
- `Notification` / Service Worker no browser
- Frontend conhecendo `roomId` ou token
- Criação automática do bot ou do Space (provisionamento manual / ops)

---

## 3. Componentes

### 3.1 Incident Evaluator (produtor)

**Onde:** Worker VM (mesmo padrão dos consumers de outbox / sync).  
**Entrada:** GET ServiceNow `incident` (universo operacional).  
**Saída:** linhas em `integration_outbox`.

Responsabilidades:

1. Descobrir mudanças relevantes (opened / assigned / resolved) desde o último cursor.
2. Aplicar **elegibilidade MVP** (§4).
3. Enriquecer com alerta correlacionado OneView quando existir (`source_event_id` / lookup já definido em SN-P0-16/27).
4. Emitir no máximo um registro outbox por chave de dedup (§6).

Cursor sugerido (estado interno worker, **não** no BFF):

- `last_polled_at` / `sys_updated_on` watermark por ambiente
- Ou watermark composto `(sys_updated_on, sys_id)` para estabilidade

### 3.2 `integration_outbox` (fila)

Tabela já existente. Contrato proposto para Webex:

| Campo | Uso MVP |
|---|---|
| `aggregate_type` | `servicenow_incident` |
| `aggregate_id` | `sys_id` do INC |
| `action_type` | `webex_incident_opened` \| `webex_incident_assigned` \| `webex_incident_resolved` |
| `status` | `pending` → `processing` → `done` \| `failed` |
| `payload` | JSON §5 |
| `idempotency_key` | chave §6 (UNIQUE parcial) |
| `attempts` / `max_attempts` | retry |
| `available_at` / `next_attempt_at` | backoff |
| `result_payload` | response Webex sanitizada (message id), sem token |
| `priority` | numérico (Disaster/P1 > High > Average) |

`INSERT … ON CONFLICT (idempotency_key) DO NOTHING` (ou equivalente ao índice único parcial já usado no projeto).

### 3.3 Webex Dispatcher (consumer)

**Onde:** Worker VM.  
**Entrada:** claim atômico de `pending` com `next_attempt_at <= now()`.  
**Saída:** `POST /v1/messages` (Webex REST) no Space NOC.

Comportamento:

1. Claim (`UPDATE … RETURNING` + lock / `status=processing`).
2. Montar mensagem markdown a partir do payload (sem secrets).
3. Enviar com `Authorization: Bearer <WEBEX_BOT_TOKEN>` e `roomId=<WEBEX_NOC_ROOM_ID>`.
4. Sucesso → `done` + `result_payload={ message_id }`.
5. Falha retryable → `pending`, `attempts++`, `next_attempt_at` backoff.
6. Falha permanente / esgotou tentativas → `failed` + código sanitizado.

---

## 4. Eventos MVP e elegibilidade

### 4.1 Eventos

| Evento lógico | `action_type` | Disparo |
|---|---|---|
| `incident.opened` | `webex_incident_opened` | INC entra no universo elegível (aberto / criado no filtro) |
| `incident.assigned` | `webex_incident_assigned` | Mudança de `assigned_to` (incluindo `null` → pessoa e pessoa → pessoa) |
| `incident.resolved` | `webex_incident_resolved` | Transição para estado Resolvido/Encerrado (`state` 6 / 7 no contrato SN atual) |

Fora do MVP (backlog): `incident.priority_changed`, `incident.reopened`, menções @pessoa, threads por INC.

### 4.2 Elegibilidade MVP

Todos os critérios abaixo (AND):

1. **`contact_type=monitoring`** (universo `/chamados`).
2. **Severidade / prioridade:**
   - Se houver **alerta correlacionado** OneView: severidade ∈ `{ average, high, disaster }` (mesmo gate `INCIDENT_ELIGIBLE_SEVERITIES` do drawer SN-P0-21).
   - Se **não** houver alerta: prioridade ServiceNow operacional equivalente ∈ `{1, 2, 3}`  
     (1 Crítica ≈ Disaster/High, 2 Alta ≈ High, 3 Moderada ≈ Average).  
     Warning/Information (alert) ou prioridade 4–5 (SN) → **não notificar**.
3. **Incluir chamados sem responsável** (`assigned_to` vazio) — não filtrar por assignee.
4. Escopo cliente: **Teletex-only** se o INC puder ser amarrado a `company`/customer do escopo operacional; se ambíguo no MVP, documentar como risco e preferir falhar fechado ou exigir company mapeada (decisão de go-live).

Não-elegível → **não** inserir outbox (silêncio intencional).

---

## 5. Payload outbox / mensagem

### 5.1 Payload canônico (JSON em `integration_outbox.payload`)

```json
{
  "event": "incident.opened",
  "sys_id": "…",
  "number": "INC0…",
  "customer": "…",
  "short_description": "…",
  "state": "2",
  "state_display": "Em andamento",
  "priority": "2",
  "priority_display": "2 - Alta",
  "assigned_to": null,
  "assigned_to_display": null,
  "opened_at": "2026-08-12 10:00:00",
  "source_alert_id": "uuid-or-null",
  "source_event_id": "zabbix-eventid-or-null",
  "oneview_url": "https://oneview…/chamados?number=INC0…",
  "servicenow_url": "https://…/incident.do?sys_id=…"
}
```

Campos obrigatórios MVP: `sys_id`, `number`, `short_description`, `state`, `priority`, `opened_at`, `oneview_url`.  
`source_alert_id` / `source_event_id` quando correlacionado; senão `null`.

### 5.2 Render Webex (dispatcher)

Mensagem curta markdown, uma por evento, por exemplo:

```text
**INC0123456** · Aberto · P2 Alta
Cliente: …
…
Estado: Em andamento · Responsável: (sem responsável)
[Abrir no OneView](…) · [ServiceNow](…)
```

Sem token, sem roomId, sem Basic Auth SN no texto.

---

## 6. Dedup / idempotência

Chaves **exatas** (também `idempotency_key`):

| Evento | Chave |
|---|---|
| opened | `incident.opened:<sys_id>` |
| assigned | `incident.assigned:<sys_id>:<assigned_to>` (`assigned_to` = sys_id ou `none`) |
| resolved | `incident.resolved:<sys_id>` |

Regras:

- Reprocessar o mesmo opened → **no-op** (conflito de idempotency).
- Reassign A→B → nova chave (`…:B`); assigned A→A não reemite.
- Resolved uma vez; reopen futuro = card posterior (`incident.reopened`).
- Dispatcher: mesmo `idempotency_key` nunca envia duas mensagens bem-sucedidas.

---

## 7. Retry, rate limit, falhas

### 7.1 Retry (outbox)

| Parâmetro | MVP sugerido |
|---|---|
| `max_attempts` | 5 |
| Backoff | exponencial: 30s, 2m, 10m, 30m, 2h (+ jitter) |
| Retryable | 429, 5xx, timeout, rede |
| Não retryable | 400/401/403/404 Webex (config/token/room inválidos) → `failed` imediato |

### 7.2 Rate limit

- Limite local no dispatcher: ex. **≤ 5 msg/s** e **≤ 60 msg/min** por room (ajuste fino na implementação).
- Respeitar `Retry-After` em 429 Webex → `next_attempt_at`.
- Avalanche (muitos opened): priorizar Disaster/P1 na claim order (`ORDER BY priority ASC, available_at`).

### 7.3 Observabilidade

- Contadores: pending / processing / failed por `action_type` (já há `v_outbox_backlog`).
- Log estruturado worker: `event=webex_dispatch`, `outbox_id`, `action_type`, `http_status`, **sem** token/room em claro se política exigir mask do room (roomId só em secret store; logs usam hash opcional).
- Alerta ops se `failed` crescer ou `oldest_pending` > N minutos.

---

## 8. Segurança

| Segredo / config | Onde | Frontend |
|---|---|---|
| `WEBEX_BOT_TOKEN` | Worker / secret store | **proibido** |
| `WEBEX_NOC_ROOM_ID` | Worker / secret store | **proibido** |
| `SERVICENOW_*` | Já server-side (BFF/worker) | **proibido** |
| `ONEVIEW_PUBLIC_ORIGIN` | Montar `oneview_url` | só URL pública |

Checklist:

- [ ] Nenhum `VITE_WEBEX_*`
- [ ] Bot membership só no Space NOC privado
- [ ] Room não é “All company”
- [ ] Rotação de token documentada
- [ ] Payload/outbox sem senha SN / Bearer

Provisionamento (ops, fora deste card): criar bot + Space + adicionar bot + membros NOC; entregar token/roomId ao secret store.

---

## 9. Sequência (runtime)

```text
1. Evaluator GET incidents (monitoring + janela/watermark)
2. Para cada INC elegível, detectar transição opened|assigned|resolved
3. INSERT outbox com idempotency_key (§6)
4. Dispatcher CLAIM pending
5. POST Webex messages (roomId env)
6. UPDATE done | retry | failed
```

---

## 10. Fronteiras com o que já existe

| Existente | Relação |
|---|---|
| `integration_outbox` + `request_sync` | Mesmo mecanismo; novos `action_type` |
| SN-P0-16/27 correlation | `source_alert_id` / eventid no payload |
| SN-P0-25 universo monitoring | Mesmo `contact_type=monitoring` |
| SN-P0-33 caller env | Correlation Zabbix usa caller configurável; Webex notifica o **universo** monitoring elegível, não só caller Zabbix |
| OV-P0-100 fallback gate | Notificações **não** usam snapshot; só dados live SN/DB |
| `/chamados` UI | Continua independente; deep link `oneview_url` |

---

## 11. Riscos e decisões em aberto

| Risco / decisão | Notas |
|---|---|
| Volume monitoring PROD | SN-P0-34 medirá AUTO vs universo; calibrar rate limit e elegibilidade |
| INC sem company Teletex | Definir fail-closed vs notificar |
| Assigned `none` → pessoa e pessoa → `none` | MVP: assigned só quando há valor novo; unassign explícito = backlog |
| Clock skew SN `opened_at` / `sys_updated_on` | Preferir `sys_updated_on` no watermark |
| Duplicidade SN DEV/PROD | Só PROD + secrets PROD no worker |

---

## 12. Fases de implementação (próximos cards — não executar agora)

1. **OV-P1-102** — Migration/contrato outbox `webex_*` + testes de idempotency key  
2. **OV-P1-103** — Incident Evaluator (GET SN → outbox), dry-run  
3. **OV-P1-104** — Webex Dispatcher + secrets + rate limit (ainda sem ligar timer prod)  
4. **OV-P1-105** — Go-live controlado: flag `WORKER_WEBEX_NOC_ENABLED=false` default  

Este card (**OV-P1-101**) encerra no desenho acima.

---

## 13. Veredito

Arquitetura fechada para MVP:

**ServiceNow → Incident Evaluator → `integration_outbox` → Webex Dispatcher → Space NOC**

Eventos: `incident.opened` / `assigned` / `resolved`.  
Elegibilidade: monitoring + Average/High/Disaster (ou P1–P3) + unassigned inclusos.  
Dedup, retry e rate limit via outbox.  
Segredos só server-side.  
**Sem Theo, sem browser notification, sem bot criado neste card, sem chamada Webex, sem consumer implementado.**

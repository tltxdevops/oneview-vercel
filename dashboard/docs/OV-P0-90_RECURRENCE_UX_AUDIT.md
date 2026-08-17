# OV-P0-90 — Recurrence UX Audit

**Tipo:** somente leitura / UI planning  
**Data da medição:** 2026-08-12  
**Read model:** OV-P0-87 ([`api/_lib/oneview-recurrence.js`](../api/_lib/oneview-recurrence.js))  
**Fora de escopo desta entrega:** migration, worker, alteração de Monitoramento, mudança de UI/código, deploy, commit.

---

## 1. Baseline UX atual (OV-P0-87)

| Item | Estado |
|---|---|
| Identidade | `data_source_id + source_host_id + source_trigger_id` |
| Episódio | só conta se predecessor tem `resolved_at` e novo `first_seen_at` é posterior |
| `is_recurrent` | `recurrence_count_7d >= 2` |
| Drawer | se recorrente: `Recorrente · N ocorrências em 7 dias` (**N sem cap**) |
| Monitoramento | sem recorrência |

Arquivo UI: [`src/components/oneview/AlertDetailDrawer.tsx`](../src/components/oneview/AlertDetailDrawer.tsx).

---

## 2. Método de medição (read-only)

1. SELECT alertas `status_source = 'active'` com identidade completa.
2. SELECT siblings por identidade (janelas 14d / 30d; caps de volume).
3. Aplicar `buildAlertRecurrenceReadModel` / `selectRecurrenceEpisodes` em processo local.
4. **Sem UPDATE**, sem migration, sem worker.

---

## 3. Resultados

### A) Amostra de ativos mais recentes

- Cap: **8.000** ativos por `first_seen_at DESC`
- Siblings: `first_seen_at >= now()-14d`, cap **50k** rows

| Métrica | Valor |
|---|---|
| Ativos com identidade na amostra | 8.000 |
| `is_recurrent` (`count_7d ≥ 2`) | **0 (0%)** |
| dist `recurrence_count_24h` | `0`: 7.488 · `1`: 512 |
| dist `recurrence_count_7d` | `0`: 2.677 · `1`: 5.323 |
| flapping ≥10/7d | 0 |
| flapping ≥5/24h | 0 |

**Interpretação:** a fatia dos **ativos mais novos** quase só tem o 1º episódio na janela.  
`count_7d = 0` = `first_seen` fora de 7d (ativo longo ainda aberto). Esta amostra **subestima** flapping crônico.

### B) População por identidade (30 dias)

| Métrica | Valor |
|---|---|
| Ativos totais / com identidade | 30.465 / 29.957 |
| Identidades com ≥2 rows (30d) | 4.944 |
| Identidades com ≥2 **episódios** válidos (OV-P0-87) | **2.653** |
| ≥5 episódios | 1.168 |
| ≥10 episódios | 729 |
| Máx. episódios / identidade | **945** (FPS — FAN critical) |

### C) Top / exemplos por severidade (30d, por episódios)

**Average**

| Episódios ~ | Cliente | Problema (resumo) | Host |
|---|---|---|---|
| 945 | FPS | Switch FAN critical | FPS.R1.BLB |
| 670 | Unicap | No SNMP data collection | SW-BLG4-7 |
| 646 | Unicap | No SNMP data collection | SW-BLG4-3 |

**High**

| Episódios ~ | Cliente | Problema (resumo) | Host |
|---|---|---|---|
| 894 | PrefOsasco | Interface Link down | BITTENCOURT… 9200 |
| 434 | FPS | Interface Link down | CE.Rack00.FOZ |
| 185 | FPS | Interface Link down | CE.Rack00.FOZ |

**Disaster**

| Episódios ~ | Cliente | Problema (resumo) | Notas |
|---|---|---|---|
| 2 | Nissan / não classificado | NXAUTOCommunication… | pouco volume |
| 2 | Nissan / não classificado | script_rcinarg… | pouco volume |
| 2 | Protege | Firewall sem comunicação | 1 ativo |

**Warning / Information:** dominam flapping de ICMP latência, speed-change, degradação de link (ex. Teletex VPN ~521; Sanepar routers 280–380).

### D) Padrão extremo operacional

Mesma identidade com **dezenas de ativos concorrentes** (ex. Unicap SNMP `active_now` 57–59; FPS FAN `active_now` 26).  
Risco de UI: N muito alto e leitura como “N problemas distintos” — incorreto.

---

## 4. Proposta de regra visual mínima

**Decisão desta auditoria** — aplicar em card de UI seguinte; **não implementado aqui**.

### 4.1 Quando mostrar

- Somente **drawer/detalhe**, se `is_recurrent === true` (`recurrence_count_7d >= 2`).
- **Nunca** lista Monitoramento neste card.
- Sem identidade → silêncio (empty model).

### 4.2 Janela

- Primária de exibição: **7 dias** (alinhada a `is_recurrent`).
- **24h** não vira texto padrão; só entra na regra de flapping (§4.4).

### 4.3 Limite / cap de exibição

| Valor real `N = recurrence_count_7d` | Exibir |
|---|---|
| 2–9 | número real |
| 10–99 | número real |
| ≥100 | **`99+`** |

Copy base:

- `Recorrente · {n} ocorrências em 7 dias`
- `Recorrente · 99+ ocorrências em 7 dias`

### 4.4 Flapping extremo

Substitui o copy base (ainda só no drawer), se:

- `recurrence_count_24h >= 5` **ou**
- `recurrence_count_7d >= 10`

Copy:

- `Flapping · {n} ocorrências em 7 dias` (mesmo cap `99+`)

Tom: discreto (`text-xs text-muted-foreground`); sem badge novo; sem cor de alarme extra.

### 4.5 Fora de escopo visual (explícito)

- Coluna / chip em Monitoramento
- Ordenação por recorrência
- Persistência / migration / worker

---

## 5. Implicações e riscos

1. Na amostra “ativos novos”, o drawer quase **nunca** acende com a regra atual — esperado para first-seen recente.
2. Em identidades crônicas (30d) há volume real e extremos (100–900+) → **cap obrigatório** antes de expandir UX.
3. Múltiplos `active` na mesma identidade distorcem percepção; UI não deve sugerir N incidentes distintos.
4. Re-medir após recovery automático (OV-P0-86) pode alterar a taxa de episódios válidos.

---

## 6. Entrega deste card

- [x] Medição ativos (amostra 8k) + identidades 30d
- [x] Distribuições 24h / 7d
- [x] Top / exemplos Average · High · Disaster
- [x] Regra visual mínima (quando / janela / cap / flapping)
- [x] Sem mudança de Monitoramento / código / commit / deploy

**Próximo card (UI):** aplicar §4 no `AlertDetailDrawer` + testes de contrato do copy/cap.

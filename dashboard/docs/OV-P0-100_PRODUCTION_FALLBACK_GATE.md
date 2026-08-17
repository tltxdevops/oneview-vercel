# OV-P0-100 — Production Fallback Gate (auditoria + gate)

**Data:** 2026-08-12  
**Tipo:** auditoria do caminho atual + gate de produção (sem remover artefatos)  
**Fora de escopo:** deploy, commit, troca de secrets PROD, exclusão dos JSON de snapshot.

---

## 1. Inventário — artefatos locais de snapshot

| Arquivo | Geração (`generated_at`) | mtime disco | Datasources no arquivo | Alertas | Uso |
|---|---|---|---|---|---|
| `src/lib/oneview-real-snapshot.json` | `2026-07-07T02:39:42.223Z` | 2026-07-06 | castrolanda, fraport-for, teletex-http, zurich | **3000** (zurich 1075 / teletex-http 1180 / castrolanda 745; fraport sem alertas exportados) | Fonte bruta / regeneração (`generate:snapshot`) |
| `src/lib/oneview-real-snapshot.safe.json` | **igual** (`2026-07-07T02:39:42.223Z`) | 2026-08-11 | mesmos 4 | **3000** | **Único** arquivo lido em runtime pelo BFF (`api/_lib/oneview-fallback.js`) |

Observações:

- Snapshot é **multi-datasource** e tem **>1 mês** (em relação a 2026-08-12).
- Em runtime o BFF aplica `scopedSnapshot()` filtrando por `ONEVIEW_PRIMARY_DATA_SOURCE_NAME` (default `teletex-http`) — mas o arquivo embutido continua antigo e multi-cliente.
- `npm run prebuild` / `predev` regenera o `.safe.json` a partir do JSON (ou fallback seguro) — o conteúdo operacional continua datado de julho/2026.
- `src/lib/demo-oneview-data.ts` importa o `.safe.json`, mas **não** entra no caminho de fetch operacional atual (`oneview-api.ts` não o usa). Mantido intacto neste card.

---

## 2. Quando o snapshot é ativado (caminho atual)

Handler canônico: `api/_lib/oneview-response.js` → `createOneViewHandler`.

| Condição | `data_source` | `fallback_code` | HTTP |
|---|---|---|---|
| `ONEVIEW_SNAPSHOT_MODE=true` | `snapshot` | `snapshot_mode` | 200 |
| Live DB desligado + `ONEVIEW_SNAPSHOT_FALLBACK_ENABLED=true` + rota `fallbackSafe` | `snapshot` | `live_database_disabled` | 200 |
| `unsafe_database_user` + fallback on | `snapshot` | `unsafe_database_user` | 200 |
| Erro de DB (timeout/unavailable/…) + fallback on + `fallbackSafe` | `snapshot` | `database_*` / `database_unavailable` | 200 |
| Qualquer caso acima **sem** fallback (flag false / rota não safe) | `database` | código do erro | **503** |
| Snapshot mode/fallback falha ao ler JSON | `snapshot` | `snapshot_unavailable` | 503 |

Rotas `fallbackSafe: true` (todas as rotas OneView GET listadas em `oneview-config.js`): health, dashboard-summary, grafana-summary, alerts, attention-required, alert-detail, alert-history, history, operations-health, clients-summary, data-sources, sync-logs.

Default de config **já era** `ONEVIEW_SNAPSHOT_FALLBACK_ENABLED=false` — mas produção ainda podia servir snapshot se a flag fosse ligada por engano.

---

## 3. Risco em produção

1. Servir dados de **jul/2026**, multi-cliente (mesmo com scope Teletex no filtro).
2. UI trata `data_source=snapshot` como contingência “desatualizada”, não como falha operacional clara.
3. Operador pode interpretar cópia antiga como fila real.

**Decisão OV-P0-100:** em runtime de produção, **nunca** servir snapshot como fonte/fallback — falhar fechado com estado explícito.

---

## 4. Gate implementado (sem remover artefatos)

- `isOneViewProductionRuntime(env)`: `VERCEL_ENV=production` **ou** `ONEVIEW_RUNTIME_ENV=production`.
- Em produção: `snapshotMode` e `snapshotFallbackEnabled` forçados a `false` mesmo se envs pedirem `true`.
- Código de fallback + JSON **permanecem** para local/dev/preview.
- FE: códigos `database_*` / `live_database_disabled` / `snapshot_unavailable` / `unsafe_database_user` → mensagem **"Dados temporariamente indisponíveis"**.

---

## 5. Verificação

- Testes: `tests/ov-p0-100-production-fallback-gate.test.mjs` (+ regressão BFF).
- Build local (`npm run build`) sem deploy/commit.

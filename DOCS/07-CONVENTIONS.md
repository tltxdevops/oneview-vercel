# OneView — Convenções de trabalho

## Escopo

- Trabalhar **Teletex only** até liberação explícita.
- Não alterar produção/timer/migrations sem card e evidência.
- Não commit/deploy sem pedido explícito do responsável.

## Código

- BFF OneView: `dashboard/api/oneview/*` + `dashboard/api/_lib/oneview-*.js`
- Frontend V1: `Index.tsx`, `Alerts.tsx`, `Historico.tsx`, `oneview-api.ts`
- Filtro de cliente/fonte: **server-side primeiro**
- Preferir query param `datasource` = `data_sources.name` (já usado no BFF)

## Segurança

- Nunca colar secrets em Markdown versionado ou chat
- Não logar tokens Zabbix / connection strings
- Revisar export ChatGPT antes de qualquer push

## Deploy

- Alterações em `dashboard/` → commit → Action → Vercel
- Validar local (`npm run lint`, `npm run test:bff`, build) antes de push quando houver mudança de código

## Cursor

- Contexto diário: `DOCS/0*.md` + `dashboard/docs/CURRENT_STATE_AUDIT.md`
- Bruto: `DOCS/ONEVIEW_CONVERSA_COMPLETA_*.md` só para minerar

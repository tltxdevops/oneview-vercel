# OneView — Master context (Cursor)

Leia nesta ordem:

1. `@DOCS/01-PROJECT_BRIEF.md`
2. `@DOCS/02-ARCHITECTURE.md`
3. `@DOCS/03-VMS-AND-INFRA.md`
4. `@DOCS/05-TODAY-P0-CARDS.md`
5. `@DOCS/06-ROADMAP.md`
6. `@dashboard/docs/CURRENT_STATE_AUDIT.md`

Regras:

- Escopo atual: **somente Teletex**
- Não alterar produção/timer/migrations sem evidência
- Não inventar `data_source_id` / nome da fonte — confirmar no banco (OV-P0-01)
- Conversa bruta: `DOCS/ONEVIEW_CONVERSA_COMPLETA_2026-07-29.md` (arquivo morto)

Infra resumida:

- Vercel (código em `dashboard/`, deploy via Action)
- DB VM `192.168.254.4` + PgBouncer
- Worker/Grafana VM `192.168.252.24` (confirmar vs `.254.24`)

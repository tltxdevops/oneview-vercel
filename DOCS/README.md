# OneView — Base de contexto (Cursor)

Documentação destilada da conversa ChatGPT + plano operacional atual.

## Fonte bruta (arquivo morto)

| Arquivo | Uso |
|---|---|
| `ONEVIEW_CONVERSA_COMPLETA_2026-07-29.md` | Export textual completo (não usar como contexto permanente) |
| `CONTEXTO ONEVIEW COMPLETO/` | Cópia + export Markdown/JSON do ChatGPT |

## Docs destilados (usar no dia a dia)

| Arquivo | Conteúdo |
|---|---|
| [01-PROJECT_BRIEF.md](./01-PROJECT_BRIEF.md) | O que é o OneView, problema, escopo V1 |
| [02-ARCHITECTURE.md](./02-ARCHITECTURE.md) | Fluxo Zabbix → Worker → PG → PgBouncer → Vercel |
| [03-VMS-AND-INFRA.md](./03-VMS-AND-INFRA.md) | VMs, IPs, papéis, PgBouncer |
| [04-DECISIONS.md](./04-DECISIONS.md) | Decisões tomadas e rejeitadas |
| [05-TODAY-P0-CARDS.md](./05-TODAY-P0-CARDS.md) | Cards reais de hoje (OV-P0-01…15) |
| [06-ROADMAP.md](./06-ROADMAP.md) | Ordem de execução e próximos passos |
| [07-CONVENTIONS.md](./07-CONVENTIONS.md) | Regras de trabalho / segurança / deploy |
| [08-OPEN_QUESTIONS.md](./08-OPEN_QUESTIONS.md) | Pendências a confirmar |

## Auditoria de código

| Arquivo | Conteúdo |
|---|---|
| [`../dashboard/docs/CURRENT_STATE_AUDIT.md`](../dashboard/docs/CURRENT_STATE_AUDIT.md) | Auditoria somente leitura Teletex (OV-P0-03) |

## Como usar no Cursor

1. Referencie docs com `@DOCS/05-TODAY-P0-CARDS.md`, `@dashboard/docs/CURRENT_STATE_AUDIT.md`, etc.
2. Não anexe a conversa completa em toda mensagem.
3. Escopo de hoje: **somente Teletex** — não Castrolanda, Zurich ou Fraport.

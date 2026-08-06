# OneView — VMs e infraestrutura

> Confirmar IPs em sessão SSH antes de qualquer alteração. Valores abaixo vêm da conversa + relato operacional atual.

## Mapa das VMs

| Papel | IP (referência) | Apelido / notas |
|---|---|---|
| **DB VM** | `192.168.254.4` | PostgreSQL + PgBouncer |
| **Worker / Zabbix / Grafana** | `192.168.252.24` (também citado como `.254.24`) | Apelidada “VM Grafana”; Worker OneView; **não** é banco |
| **Vercel** | SaaS | Frontend + BFF; commit → Action → deploy |

## Papéis por VM

### DB VM (`192.168.254.4`)

- PostgreSQL oficial OneView
- PgBouncer `:6432` para Vercel
- Migrations, backup, restore
- Console administrativo PgBouncer (somente leitura nas medições P0)

### Worker VM (`192.168.252.24` — confirmar)

- Grafana (histórico operacional na conversa: `cta-mzbx`)
- Worker de sync OneView → PostgreSQL
- Timers/systemd `oneview*`
- **Não** hospeda PostgreSQL OneView
- Acesso `:5432` da DB VM restrito a este host (+ admins)

### Vercel

- Root do app: `dashboard/`
- Lê/grava via PgBouncer
- Auth Microsoft SSO (domínio Teletex)

## Fluxo de deploy

```text
Código local (dashboard)
  → git commit + push
  → GitHub Action
  → Deploy Vercel
```

## PgBouncer — checagens (OV-P0-07 / 08)

Somente leitura / sem colar secrets:

- `SHOW VERSION|POOLS|STATS|CLIENTS|SERVERS`
- Porta, firewall, TLS, `sslmode`, pool mode, limites
- Latência dos endpoints `/api/alerts*`, `/api/oneview/*`, `/api/data-sources`

## Segurança

- Não colar senhas, connection strings, tokens, `.env`, usuários PgBouncer em chat/docs versionados
- Rotacionar qualquer secret que tenha aparecido na conversa ChatGPT
- Preferir arquivar export bruto fora do git se contiver secrets

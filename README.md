# OneView Vercel

Entregavel da camada Vercel do OneView.

## Onde roda

- Vercel.
- Deploy a partir de `dashboard/`.
- Leitura do PostgreSQL somente via PgBouncer em `192.168.254.4:6432`.
- Usuario esperado no banco: `oneview_app`.

## Responsabilidade

- Frontend React/Vite.
- Vercel Functions em `dashboard/api`.
- Endpoints HTTP leves para consultar dados prontos.
- Health checks da API, banco, Worker, Data Sources e outbox.

Esta entrega nao consulta Zabbix e nao executa sincronizacao.

## Configuracao

Configure as variaveis do arquivo `.env.example` no projeto da Vercel.

Obrigatorio:

```env
DATABASE_URL=postgresql://oneview_app:<PASSWORD>@192.168.254.4:6432/oneview
POSTGRES_SSL=false
PG_POOL_MAX=5
```

Nao inclua URLs administrativas, variaveis de Worker, variaveis de migration,
segredos de origem ou credenciais Zabbix neste projeto.

## Build e deploy

```bash
cd dashboard
npm ci
npm run build
vercel deploy --prod
```

## Health checks

```bash
curl https://<projeto-vercel>/api/health
curl https://<projeto-vercel>/api/health/db
curl https://<projeto-vercel>/api/health/worker
curl https://<projeto-vercel>/api/health/outbox
```

## Rollback

Use o rollback nativo da Vercel para promover o deployment anterior. Nao altere
Worker ou banco durante rollback da camada Vercel.

# OneView Vercel

Camada visual React/Vite do OneView. Deploy executado a partir de `dashboard/`.

## Apresentação por snapshot real

Ative a apresentação isolada com:

```env
NEXT_PUBLIC_DEMO_MODE=true
```

Nesse modo, a interface operacional original usa o snapshot exportado diretamente
do PostgreSQL OneView depois do sync do Worker. Não chama Zabbix, não conecta ao
PostgreSQL privado, não carrega configuração SSO e não executa ACK real. O arquivo
local é `dashboard/.env.local` e permanece ignorado pelo Git.

O snapshot-fonte fica em `dashboard/src/lib/oneview-real-snapshot.json`. Antes de
dev, teste ou build, uma allowlist gera `oneview-real-snapshot.safe.json`, sem
payload bruto ou campos sensíveis. O dashboard mostra o total de 655, os 100
alertas exportados e os quatro sync logs. `/alertas` mantém filtros locais;
`/config` mostra os dois datasources em read-only. O snapshot seguro também
elimina `api_url`, hostnames/IPs internos, `payload_raw` e `payload_normalized`.
Hosts exibidos usam aliases neutros gerados no build.

## BFF OneView

Rotas explícitas em `dashboard/api/oneview/`:

- `GET /api/oneview/health`
- `GET /api/oneview/dashboard-summary`
- `GET /api/oneview/grafana-summary`
- `GET /api/oneview/alerts`
- `GET /api/oneview/clients-summary`

Todas exigem token Microsoft validado server-side. Estado inicial:

```env
ONEVIEW_LIVE_API_ENABLED=false
ONEVIEW_SNAPSHOT_FALLBACK_ENABLED=true
```

Com live desligado, retornam snapshot e `X-OneView-Data-Source: snapshot`.
Quando habilitada, `ONEVIEW_API_BASE_URL`, `CF_ACCESS_CLIENT_ID` e
`CF_ACCESS_CLIENT_SECRET` devem existir somente nas variáveis server-side da
Vercel. Falhas 502/503/504 e timeout podem usar fallback; 401/403 nunca usam.

Para retornar ao fluxo real, defina `NEXT_PUBLIC_DEMO_MODE=false` ou remova a
variável. O fluxo real existente e as Vercel Functions permanecem preservados.

## Variáveis na Vercel

Para a apresentação, configure somente `NEXT_PUBLIC_DEMO_MODE=true` em
Production, Preview e Development. Não adicione token, senha, `DATABASE_URL` ou
credencial Zabbix ao deployment da apresentação.

Os secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID` e `VERCEL_PROJECT_ID` pertencem ao
GitHub Actions, não ao frontend nem ao repositório.

## Build e validação

```bash
cd dashboard
npm ci
npm run test:bff
npm run test:demo
npm run build
```

`test:demo` valida o código da apresentação e executa o build de produção. O
lint global (`npm run lint`) ainda contém débitos preexistentes do fluxo real.

## Deploy

O workflow `.github/workflows/deploy-vercel.yml` replica o fluxo do repositório
principal: `vercel pull` → `vercel build` → `vercel deploy --prebuilt`. Push na
`main` publica em produção; outras branches geram preview.

## Fluxo real preservado

Com o modo de apresentação desativado, permanecem disponíveis frontend, autenticação, Vercel
Functions e health checks existentes. Essa configuração não deve consultar
Zabbix diretamente; sincronização continua responsabilidade do Worker separado.

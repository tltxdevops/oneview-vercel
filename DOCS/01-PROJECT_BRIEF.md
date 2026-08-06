# OneView — Project Brief

## O que é

Aplicação para centralizar alertas e informações do NOC, reduzindo a quantidade de telas (vários Zabbix, Grafana, dashboards por cliente).

## Problema

Monitoramento fragmentado: muitos clientes, vários Zabbix e dashboards. Operação não escala.

## Objetivo V1 (foco atual)

Operação **somente Teletex** com dados reais:

- Home operacional (resumo, atenção necessária, prioritários, eventos, saúde)
- Alertas utilizáveis (views + filtros essenciais + drawer)
- Histórico V1 limpo (só eventos relevantes ao operador)
- Sync Zabbix → Worker → PostgreSQL → BFF Vercel → Frontend
- ACK interno (com comentário) onde permitido
- ServiceNow preparado, sem números fictícios

## Fora de escopo agora

- Castrolanda, Zurich, Fraport e demais clientes
- Apagar fontes/alertas antigos
- Alterar migrations sem necessidade
- Filtro só no CSS/React sem enforcement no BFF/SQL
- Integração ServiceNow completa (apenas preparação visual/docs)

## Stack de entrega

| Camada | Tecnologia |
|---|---|
| Frontend + BFF | React/Vite + Vercel Functions (`dashboard/`) |
| Deploy | Commit local → GitHub Action → Vercel |
| Banco | PostgreSQL na DB VM |
| Pool | PgBouncer `:6432` (Vercel → DB) |
| Coleta | Worker na VM Zabbix/Grafana |
| Origem | API Zabbix (tokens por data source) |

## Critérios de negócio herdados

- Total de alarmes ativos
- Por criticidade / status operacional / cliente-serviço-ambiente
- Top ativos, não reconhecidos, maior duração
- Tempo médio de ACK e de normalização

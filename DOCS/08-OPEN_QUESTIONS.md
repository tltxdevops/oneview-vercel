# OneView — Perguntas abertas

## Bloqueantes para hoje

1. Qual é o valor real de `data_sources.name` da Teletex? (`teletex-http` vs outros)
2. Qual o UUID `data_sources.id`?
3. Qual `client_name` / `customer_key` associados?
4. IP definitivo da Worker/Grafana: `192.168.252.24` ou `192.168.254.24`?
5. Nome real do unit/timer systemd OneView na Worker VM?

## Técnicos

6. Existe mais de uma fonte Teletex no banco?
7. Comentário de ACK Zabbix: ainda incompleto na API? (matriz P0-13)
8. Política OV-P0-02: bloquear `?datasource=outro` (400) ou ignorar e forçar Teletex?
9. TLS obrigatório Vercel → PgBouncer já está ok em produção?
10. Snapshot fallback deve ser regenerado só com Teletex?

## Produto / apresentação

11. ServiceNow: só card “em preparação” ou já mostrar campo vazio no drawer?
12. Coluna “Chamado” na lista: placeholder até integração?
13. Histórico: “Detalhes técnicos” colapsado default — ok para NOC?

/**
 * Write executor placeholder. It is not wired to a route and it never calls Zabbix.
 * Installing or deploying this file must not create a maintenance window.
 */
export function executeMaintenanceCreate() {
  const error = new Error("maintenance_writes_disabled");
  error.code = "maintenance_writes_disabled";
  throw error;
}

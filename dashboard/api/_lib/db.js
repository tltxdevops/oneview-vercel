import { getOneViewDbConfig, getOneViewDbPool, logOneViewDbPoolMetric } from "./oneview-db.js";

export function getPool() {
  return getOneViewDbPool(getOneViewDbConfig());
}

export async function query(text, params = []) {
  return getPool().query({ text, values: params });
}

export async function transaction(callback) {
  const config = getOneViewDbConfig();
  const pool = getOneViewDbPool(config);
  const startedAt = Date.now();
  let client;
  let began = false;
  let failure;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    began = true;
    // PgBouncer rejects startup timeout parameters; constrain only this transaction.
    await client.query(
      "select set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)",
      [String(config.statementTimeoutMs), String(config.idleInTransactionTimeoutMs)],
    );
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    failure = error;
    if (client && began) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (client) client.release(failure);
    logOneViewDbPoolMetric({ operation: "legacy_transaction", durationMs: Date.now() - startedAt, error: failure, poolInstance: pool });
  }
}

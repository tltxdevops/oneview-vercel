import { getOneViewDbConfig, getOneViewDbPool } from "./oneview-db.js";

export function getPool() {
  return getOneViewDbPool(getOneViewDbConfig());
}

export async function query(text, params = []) {
  return getPool().query({ text, values: params });
}

export async function transaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

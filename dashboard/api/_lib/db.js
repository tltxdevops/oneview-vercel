import pg from "pg";

const { Pool } = pg;

let pool;

function assertVercelDatabaseConfig(connectionString) {
  const parsed = new URL(connectionString);
  if (parsed.username !== "oneview_app") {
    throw new Error("Vercel DATABASE_URL must use database role oneview_app");
  }
  if (parsed.hostname !== "192.168.254.4") {
    throw new Error("Vercel DATABASE_URL must point to PgBouncer host 192.168.254.4");
  }
  if (parsed.port !== "6432") {
    throw new Error("Vercel DATABASE_URL must use PgBouncer port 6432");
  }
}

export function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (connectionString.startsWith("sqlite")) {
    throw new Error("Vercel API requires PostgreSQL DATABASE_URL");
  }
  assertVercelDatabaseConfig(connectionString);
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX || 5),
      ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
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

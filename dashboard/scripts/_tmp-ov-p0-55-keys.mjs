import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

const sslMode = String(process.env.ONEVIEW_DB_SSLMODE || "require").toLowerCase();
const ssl = sslMode === "disable"
  ? undefined
  : (process.env.ONEVIEW_DB_SSL_REJECT_UNAUTHORIZED === "false" ? { rejectUnauthorized: false } : true);

const client = new pg.Client({
  host: process.env.ONEVIEW_DB_HOST,
  port: Number(process.env.ONEVIEW_DB_PORT || 443),
  database: process.env.ONEVIEW_DB_NAME,
  user: process.env.ONEVIEW_DB_USER || "oneview_vercel_readonly",
  password: process.env.POSTGRES_READONLY_PASSWORD,
  ssl,
});

await client.connect();
const { rows } = await client.query(`
  select customer_name, customer_key, customer_source, count(*)::int as n
    from alerts a
    join data_sources ds on ds.id = a.data_source_id
   where lower(ds.name) = 'teletex-http'
     and (
       lower(coalesce(customer_name,'')) ~ '(havan|ebanx|triunfante)'
       or lower(coalesce(customer_key,'')) ~ '(havan|ebanx|triunfante)'
     )
   group by 1,2,3
   order by n desc
`);
console.log(JSON.stringify({
  rows,
  write_env_present: {
    ONEVIEW_DB_WRITE_USER: Boolean(process.env.ONEVIEW_DB_WRITE_USER),
    POSTGRES_APP_PASSWORD: Boolean(process.env.POSTGRES_APP_PASSWORD),
    ONEVIEW_DB_WRITE_PASSWORD: Boolean(process.env.ONEVIEW_DB_WRITE_PASSWORD),
    POSTGRES_ACTIONS_PASSWORD: Boolean(process.env.POSTGRES_ACTIONS_PASSWORD),
  },
}, null, 2));
await client.end();

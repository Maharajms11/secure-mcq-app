import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

function buildConnectionString() {
  return config.databaseUrl;
}

function describeConnectionTarget(connectionString) {
  try {
    const u = new URL(connectionString);
    return `${u.username || "unknown"}@${u.hostname || "unknown"}:${u.port || "5432"}${u.pathname || ""}`;
  } catch {
    return "unparseable_connection_string";
  }
}

function buildPoolConfig() {
  const resolvedConnectionString = buildConnectionString();
  const base = {
    ssl: config.dbSsl ? { rejectUnauthorized: config.dbSslRejectUnauthorized } : undefined
  };

  try {
    const u = new URL(resolvedConnectionString);
    const database = (u.pathname || "/postgres").replace(/^\//, "") || "postgres";
    return {
      ...base,
      host: u.hostname,
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
      database
    };
  } catch {
    return {
      ...base,
      connectionString: resolvedConnectionString
    };
  }
}

const resolvedConnectionString = buildConnectionString();
const poolConfig = buildPoolConfig();
console.log(`[db] target=${describeConnectionTarget(resolvedConnectionString)}`);

export const pool = new Pool({
  ...poolConfig
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

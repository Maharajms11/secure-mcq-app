import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

function buildConnectionString() {
  const raw = config.databaseUrl;
  try {
    const u = new URL(raw);
    const sslMode = (u.searchParams.get("sslmode") || "").toLowerCase();
    // pg parser recently changed sslmode behavior; this keeps libpq-compatible "require" semantics.
    if (sslMode === "require" && !u.searchParams.has("uselibpqcompat")) {
      u.searchParams.set("uselibpqcompat", "true");
    }
    return u.toString();
  } catch {
    return raw;
  }
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
const hasPgOverrides = ["PGUSER", "PGPASSWORD", "PGHOST", "PGPORT", "PGDATABASE"].some((k) => !!process.env[k]);
console.log(`[db] target=${describeConnectionTarget(resolvedConnectionString)}`);
console.log(`[db] pg_env_overrides_present=${hasPgOverrides ? "yes" : "no"}`);

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

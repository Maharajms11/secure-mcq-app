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
      user: u.username || "",
      password: u.password || "",
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
const passwordValue = String(poolConfig.password || "");
const passwordDiagnostics = {
  len: passwordValue.length,
  hasAsterisk: passwordValue.includes("*"),
  hasBrackets: passwordValue.includes("[") || passwordValue.includes("]"),
  hasLeadingSpace: /^\s/.test(passwordValue),
  hasTrailingSpace: /\s$/.test(passwordValue),
  looksLikePlaceholder: /\[YOUR-?PASSWORD\]/i.test(passwordValue)
};
console.log(`[db] target=${describeConnectionTarget(resolvedConnectionString)}`);
console.log(`[db] pool_user=${poolConfig.user || "from_connection_string"}`);
console.log(`[db] pg_env_overrides_present=${hasPgOverrides ? "yes" : "no"}`);
console.log(`[db] password_diag=${JSON.stringify(passwordDiagnostics)}`);

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

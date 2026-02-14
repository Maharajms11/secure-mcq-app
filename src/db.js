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

export const pool = new Pool({
  connectionString: buildConnectionString(),
  ssl: config.dbSsl ? { rejectUnauthorized: config.dbSslRejectUnauthorized } : undefined
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

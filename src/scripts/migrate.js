import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { config } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationDir = path.resolve(__dirname, "../../sql");

try {
  const files = (await fs.readdir(migrationDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (!files.length) {
    console.log("[migrate] No SQL files found.");
  } else {
    console.log(`[migrate] sql_files=${files.length} db_url_source=${process.env.APP_DATABASE_URL ? "APP_DATABASE_URL" : process.env.DATABASE_URL ? "DATABASE_URL" : "default"} ssl=${config.dbSsl}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const file of files) {
        const migrationFile = path.join(migrationDir, file);
        const sql = await fs.readFile(migrationFile, "utf8");
        await client.query(sql);
        console.log(`[migrate] applied=${file}`);
      }
      await client.query("COMMIT");
      console.log("Migration complete.");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
} catch (err) {
  console.error("[migrate] failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

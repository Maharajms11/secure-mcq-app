import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { pool } from "./db.js";
import { redis } from "./redis.js";
import authPlugin from "./plugins/auth.js";
import assessmentRoutes from "./routes/assessment.js";
import adminRoutes from "./routes/admin.js";

const app = Fastify({ logger: true });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.resolve(__dirname, "../index.html");

await app.register(cors, { origin: true, credentials: false });
await app.register(jwt, { secret: config.jwtSecret });
await app.register(authPlugin);

await app.register(assessmentRoutes, { prefix: "/api" });
await app.register(adminRoutes, { prefix: "/api" });

// Serve the client app at the root so the Render URL works for testers.
app.get("/", async (request, reply) => {
  const html = await fs.readFile(indexPath, "utf8");
  reply.type("text/html; charset=utf-8");
  return html;
});

app.get("/index.html", async (request, reply) => {
  const html = await fs.readFile(indexPath, "utf8");
  reply.type("text/html; charset=utf-8");
  return html;
});

app.setErrorHandler((err, request, reply) => {
  request.log.error(err);
  if (!reply.sent) {
    reply.code(500).send({ error: "internal_server_error" });
  }
});

const close = async () => {
  await app.close();
  await pool.end();
  redis.disconnect();
  process.exit(0);
};

process.on("SIGINT", close);
process.on("SIGTERM", close);

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`API listening on ${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

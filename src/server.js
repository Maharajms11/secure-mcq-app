import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { config } from "./config.js";
import { pool } from "./db.js";
import { redis } from "./redis.js";
import authPlugin from "./plugins/auth.js";
import assessmentRoutes from "./routes/assessment.js";
import adminRoutes from "./routes/admin.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true, credentials: false });
await app.register(jwt, { secret: config.jwtSecret });
await app.register(authPlugin);

await app.register(assessmentRoutes, { prefix: "/api" });
await app.register(adminRoutes, { prefix: "/api" });

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

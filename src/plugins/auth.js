export default async function authPlugin(fastify) {
  fastify.decorate("adminAuth", async function adminAuth(request, reply) {
    try {
      await request.jwtVerify();
      if (request.user?.role !== "admin") {
        return reply.code(403).send({ error: "forbidden" });
      }
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  fastify.decorate("sessionAuth", async function sessionAuth(request, reply) {
    try {
      await request.jwtVerify();
      if (request.user?.role !== "session") {
        return reply.code(403).send({ error: "forbidden" });
      }
      const routeToken = String(request.params?.token || "");
      if (!routeToken || request.user?.sessionToken !== routeToken) {
        return reply.code(403).send({ error: "session_token_mismatch" });
      }
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
}

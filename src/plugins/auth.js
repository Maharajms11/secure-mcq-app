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

  fastify.decorate("clientAuth", async function clientAuth(request, reply) {
    try {
      await request.jwtVerify();
      if (request.user?.role !== "client") {
        return reply.code(403).send({ error: "forbidden" });
      }
      const tokenFromPath = String(request.params?.token || "");
      const tokenFromJwt = String(request.user?.sessionToken || "");
      if (!tokenFromPath || tokenFromPath !== tokenFromJwt) {
        return reply.code(403).send({ error: "session_forbidden" });
      }
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
}

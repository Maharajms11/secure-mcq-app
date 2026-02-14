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
}

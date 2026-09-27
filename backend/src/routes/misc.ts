import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.ts';
import { now } from '../config.ts';
import { coursesForUser, type Ctx } from '../context.ts';

export async function miscRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get('/health', async () => ({
    ok: true,
    now: now(),
    db: ctx.store.ephemeral ? 'in-memory (dev)' : 'mongodb',
    activeSessions: ctx.engine.sessions.size,
    wsClients: ctx.hub.clientCount(),
  }));
  app.get('/time', async () => ({ now: now() }));
  app.get('/courses', { preHandler: requireUser(ctx.lookupUser) }, async (req) => coursesForUser(ctx.store, req.user!));
  app.get<{ Params: { id: string } }>(
    '/courses/:id/students',
    { preHandler: requireUser(ctx.lookupUser, ['professor', 'admin']) },
    async (req, reply) => {
      const course = await ctx.store.courses.findOne({ _id: req.params.id });
      if (!course) return reply.code(404).send({ error: 'not_found' });
      const users = await ctx.store.users
        .find({ _id: { $in: course.studentIds } }, { projection: { _id: 1, name: 1, studentNumber: 1, platform: 1, deviceId: 1 } })
        .sort({ name: 1 })
        .toArray();
      return users.map((u) => ({ userId: u._id, name: u.name, studentNumber: u.studentNumber, platform: u.platform, registered: !!u.deviceId }));
    },
  );
}

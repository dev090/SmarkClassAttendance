import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.ts';
import type { AttendanceConfig } from '../config.ts';
import type { Ctx } from '../context.ts';
import type { ManualState } from '../engine.ts';
import { buildSnapshot, buildSummary } from '../snapshot.ts';

export async function sessionRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { store, engine } = ctx;
  const staff = requireUser(ctx.lookupUser, ['professor', 'admin']);
  const anyUser = requireUser(ctx.lookupUser);

  app.get('/sessions/active', { preHandler: anyUser }, async () => {
    return [...engine.sessions.values()].map((rt) => ({
      id: rt.id,
      courseId: rt.courseId,
      courseCode: rt.courseCode,
      courseName: rt.courseName,
      roomId: rt.roomId,
      startedAt: rt.startedAt,
      scheduledEnd: rt.scheduledEnd,
      demo: rt.demo,
    }));
  });

  app.get<{ Querystring: { courseId?: string; limit?: string } }>('/sessions', { preHandler: staff }, async (req) => {
    const limit = Math.min(200, Number(req.query.limit ?? 50));
    const sessions = await store.sessions
      .find(req.query.courseId ? { courseId: req.query.courseId } : {})
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();
    const ids = sessions.map((s) => s._id);
    const [courses, attendedRows] = await Promise.all([
      store.coursesById([...new Set(sessions.map((s) => s.courseId))]),
      store.attendance
        .aggregate<{ _id: string; n: number }>([
          { $match: { sessionId: { $in: ids }, $or: [{ presentSeconds: { $gt: 0 } }, { 'manual.state': 'present' }] } },
          { $group: { _id: '$sessionId', n: { $sum: 1 } } },
        ])
        .toArray(),
    ]);
    const attended = new Map(attendedRows.map((r) => [r._id, r.n]));
    return sessions.map((s) => {
      const c = courses.get(s.courseId);
      return {
        id: s._id,
        courseId: s.courseId,
        courseCode: c?.code ?? s.courseId,
        courseName: c?.name ?? '',
        roomId: s.roomId,
        startedAt: s.startedAt,
        scheduledEnd: s.scheduledEnd,
        endedAt: s.endedAt,
        status: s.status,
        demo: s.demo,
        enrolled: c?.studentIds.length ?? 0,
        attended: attended.get(s._id) ?? 0,
      };
    });
  });

  app.post<{ Body: { courseId?: string; demo?: boolean; config?: Partial<AttendanceConfig>; durationMinutes?: number } }>(
    '/sessions/start',
    { preHandler: staff },
    async (req, reply) => {
      const { courseId, demo, config, durationMinutes } = req.body ?? {};
      if (!courseId) return reply.code(400).send({ error: 'courseId required' });
      try {
        const rt = await engine.startSession({ courseId, startedBy: req.user!.id, demo, config, durationMinutes });
        ctx.hub.sessionStarted(rt.id);
        return await buildSnapshot(store, engine, rt.id);
      } catch (e) {
        const msg = (e as Error).message;
        const code = msg === 'course_not_found' ? 404 : msg === 'room_busy' ? 409 : 500;
        return reply.code(code).send({ error: msg });
      }
    },
  );

  app.post<{ Params: { id: string } }>('/sessions/:id/end', { preHandler: staff }, async (req, reply) => {
    try {
      await engine.endSession(req.params.id, req.user!.id);
      void ctx.hub.sessionEnded(req.params.id);
      return await buildSummary(store, engine, req.params.id);
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>('/sessions/:id', { preHandler: anyUser }, async (req, reply) => {
    const snap = await buildSnapshot(store, engine, req.params.id);
    return snap ?? reply.code(404).send({ error: 'not_found' });
  });

  app.get<{ Params: { id: string } }>('/sessions/:id/summary', { preHandler: staff }, async (req, reply) => {
    const summary = await buildSummary(store, engine, req.params.id);
    return summary ?? reply.code(404).send({ error: 'not_found' });
  });

  app.patch<{ Params: { id: string }; Body: Partial<AttendanceConfig> }>('/sessions/:id/config', { preHandler: staff }, async (req, reply) => {
    try {
      await engine.updateConfig(req.params.id, req.body ?? {});
      return await buildSnapshot(store, engine, req.params.id);
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string; userId: string }; Body: { state?: ManualState | null; note?: string } }>(
    '/sessions/:id/attendance/:userId/override',
    { preHandler: staff },
    async (req, reply) => {
      const state = req.body?.state ?? null;
      if (state !== null && !['present', 'absent', 'excused'].includes(state)) {
        return reply.code(400).send({ error: 'state must be present|absent|excused|null' });
      }
      try {
        await engine.setOverride(req.params.id, req.params.userId, state, req.user!.id, req.body?.note ?? null);
        return await buildSnapshot(store, engine, req.params.id);
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );
}

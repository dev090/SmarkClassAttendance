import type { FastifyInstance } from 'fastify';
import { requireUser, signToken, verifyPassword } from '../auth.ts';
import { now } from '../config.ts';
import { coursesForUser, type Ctx } from '../context.ts';
import { effectiveState } from '../engine.ts';
import { newSecret } from '../store.ts';

export async function authRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { store } = ctx;

  app.post<{ Body: { email?: string; password?: string; deviceId?: string; platform?: string } }>('/auth/login', async (req, reply) => {
    const { email, password, deviceId, platform } = req.body ?? {};
    if (!email || !password) return reply.code(400).send({ error: 'email and password required' });
    const row = await store.users.findOne({ email: email.toLowerCase().trim() });
    if (!row || !verifyPassword(password, row.passwordHash)) return reply.code(401).send({ error: 'invalid credentials' });

    let secret = row.secret;
    let migrated = false;
    if (row.role === 'student') {
      // One device per student: a login from a new deviceId rotates the secret so the old phone stops being counted.
      if (deviceId && row.deviceId && row.deviceId !== deviceId) {
        secret = newSecret();
        migrated = true;
      }
      if (!secret) secret = newSecret();
    }
    const user = { id: row._id, role: row.role, name: row.name, email: row.email };
    // run the device update and the course lookup concurrently: every Atlas round trip costs ~100 ms
    const [courses] = await Promise.all([
      coursesForUser(store, user),
      row.role === 'student'
        ? store.users
            .updateOne({ _id: row._id }, { $set: { secret, deviceId: deviceId ?? row.deviceId, platform: platform ?? row.platform } })
            .then(() => (migrated || !row.secret ? ctx.resolver.invalidate() : undefined))
        : Promise.resolve(),
    ]);
    return {
      token: signToken(row._id, row.role),
      user: { ...user, studentNumber: row.studentNumber },
      secret: row.role === 'student' ? secret : undefined,
      deviceMigrated: migrated,
      serverTime: now(),
      courses,
    };
  });

  app.get('/me', { preHandler: requireUser(ctx.lookupUser) }, async (req) => {
    const user = req.user!;
    return { user, courses: await coursesForUser(store, user), serverTime: now() };
  });

  /** For the student app's "You're in class" screen. */
  app.get<{ Querystring: { beacon?: string } }>('/me/status', { preHandler: requireUser(ctx.lookupUser, ['student']) }, async (req) => {
    const uid = req.user!.id;
    if (req.query.beacon) req.log.info({ uid, beacon: req.query.beacon.slice(0, 200) }, 'app beacon status');
    for (const rt of ctx.engine.sessions.values()) {
      const s = rt.students.get(uid);
      if (!s) continue;
      return {
        activeSession: {
          id: rt.id,
          courseCode: rt.courseCode,
          courseName: rt.courseName,
          roomId: rt.roomId,
          startedAt: rt.startedAt,
          scheduledEnd: rt.scheduledEnd,
        },
        attendance: {
          state: s.state,
          effectiveState: effectiveState(s),
          arrivalAt: s.arrivalAt,
          lastSeen: s.lastSeen,
          presentSeconds: Math.round(s.presentSeconds),
          late: s.late,
          confidence: s.confidence,
        },
        serverTime: now(),
      };
    }
    return { activeSession: null, attendance: null, serverTime: now() };
  });
}

import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.ts';
import { now } from '../config.ts';
import type { Ctx } from '../context.ts';
import type { EvidenceKind } from '../engine.ts';

const proximityRssi: Record<string, number> = { immediate: -50, near: -65, far: -80, unknown: -90 };

/**
 * iPhone path. Two flavours of evidence:
 *  - event "range" (default): the app is on screen and measured a beacon (major, minor, proximity, rssi)
 *  - event "enter" / "exit": iOS region monitoring woke the app in the background (major only)
 */
export async function presenceRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.post<{ Body: { major?: number; minor?: number; proximity?: string; rssi?: number; scannerId?: string; event?: string } }>(
    '/presence/ios',
    { preHandler: requireUser(ctx.lookupUser, ['student']) },
    async (req, reply) => {
      const b = req.body ?? {};
      if (b.event === 'stop') {
        // Student stopped detection or signed out: treat as leaving every class they are currently in.
        const results: unknown[] = [];
        for (const rt of ctx.engine.sessions.values()) {
          if (!rt.students.has(req.user!.id)) continue;
          const sc = await ctx.store.scanners.findOne({ roomId: rt.roomId }, { sort: { beaconMinor: 1 } });
          results.push(
            ctx.engine.ingest({
              scannerId: sc?._id ?? 'app',
              roomId: rt.roomId,
              userId: req.user!.id,
              rssi: -100,
              at: now(),
              source: 'IOS_BEACON',
              kind: 'region_exit',
            }),
          );
        }
        req.log.info({ uid: req.user!.id, kind: 'stop', results }, 'ios presence');
        return { ok: true, kind: 'stop', sessions: results.length };
      }
      const kind: EvidenceKind = b.event === 'enter' ? 'region_enter' : b.event === 'exit' ? 'region_exit' : 'ranging';
      let scanner = b.scannerId ? await ctx.store.scanners.findOne({ _id: b.scannerId }) : null;
      if (!scanner && typeof b.major === 'number') {
        const room = await ctx.store.rooms.findOne({ beaconMajor: b.major });
        if (room) {
          scanner =
            typeof b.minor === 'number' ? await ctx.store.scanners.findOne({ roomId: room._id, beaconMinor: b.minor }) : null;
          // region events carry no minor: attribute them to the room's first scanner
          scanner ??= await ctx.store.scanners.findOne({ roomId: room._id }, { sort: { beaconMinor: 1 } });
        }
      }
      if (!scanner) return reply.code(404).send({ error: 'unknown beacon' });
      const rssi = typeof b.rssi === 'number' && b.rssi < 0 ? b.rssi : (proximityRssi[b.proximity ?? 'unknown'] ?? -90);
      const r = ctx.engine.ingest({
        scannerId: scanner._id,
        roomId: scanner.roomId,
        userId: req.user!.id,
        rssi,
        at: now(),
        source: 'IOS_BEACON',
        kind,
      });
      req.log.info({ uid: req.user!.id, kind, major: b.major, minor: b.minor, rssi, result: r }, 'ios presence');
      return r.ok ? { ok: true, sessionId: r.sessionId, state: r.state, kind } : { ok: false, reason: r.reason, kind };
    },
  );
}

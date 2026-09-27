import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireUser, verifyScannerSignature } from '../auth.ts';
import { config, now } from '../config.ts';
import type { Ctx } from '../context.ts';
import type { Source } from '../engine.ts';
import { listScanners } from '../snapshot.ts';
import type { ScannerDoc } from '../store.ts';

declare module 'fastify' {
  interface FastifyRequest {
    scanner?: ScannerDoc;
  }
}

export async function scannerRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { store, engine, resolver } = ctx;

  /** Signed-request guard for ESP32s: x-scanner-id, x-timestamp, x-signature = HMAC(secret, ts + "." + rawBody). */
  const requireScanner = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const id = req.headers['x-scanner-id'];
    const ts = req.headers['x-timestamp'];
    const sig = req.headers['x-signature'];
    if (typeof id !== 'string' || typeof ts !== 'string' || typeof sig !== 'string') {
      reply.code(401).send({ error: 'missing scanner auth headers', now: now() });
      return;
    }
    const scanner = await store.scanners.findOne({ _id: id });
    if (!scanner || !verifyScannerSignature(scanner.secret, ts, req.rawBody ?? '', sig)) {
      reply.code(401).send({ error: 'bad scanner signature', now: now() });
      return;
    }
    req.scanner = scanner;
  };

  app.post<{ Body: { detections?: Array<{ token?: string; rssi?: number; max?: number; n?: number; ts?: number; src?: string }> } }>(
    '/detections',
    { preHandler: requireScanner },
    async (req) => {
      const scanner = req.scanner!;
      const t = now();
      const list = Array.isArray(req.body?.detections) ? req.body.detections : [];
      let accepted = 0;
      let unknown = 0;
      let notEnrolled = 0;
      const seenUsers = new Set<string>();
      for (const d of list) {
        if (typeof d.token !== 'string' || typeof d.rssi !== 'number') continue;
        const resolved = resolver.resolve(d.token);
        if (!resolved) {
          unknown++;
          continue;
        }
        // trust the scanner's timestamp if plausible: up to 10 min old (offline buffer replay), never in the future
        const at = typeof d.ts === 'number' && d.ts <= t + 15 && d.ts >= t - 600 ? d.ts : t;
        const source: Source = d.src === 'sim' ? 'SIMULATOR' : 'BLE_ANDROID';
        const r = engine.ingest({
          scannerId: scanner._id,
          roomId: scanner.roomId,
          userId: resolved.userId,
          rssi: d.rssi,
          maxRssi: typeof d.max === 'number' ? d.max : undefined,
          count: typeof d.n === 'number' ? d.n : undefined,
          at,
          source,
        });
        if (r.ok) {
          accepted++;
          seenUsers.add(resolved.userId);
        } else if (r.reason === 'not_enrolled') notEnrolled++;
      }
      // a detection batch also counts as a sign of life
      void store.scanners.updateOne({ _id: scanner._id }, { $set: { lastHeartbeat: t }, $setOnInsert: {} }).catch(() => {});
      const active = engine.activeForRoom(scanner.roomId);
      return { accepted, unknown, notEnrolled, users: seenUsers.size, active: !!active, sessionId: active?.id ?? null, now: t };
    },
  );

  app.post<{ Body: { wifiRssi?: number; uptime?: number; fw?: string; buffered?: number; ip?: string } }>(
    '/scanners/heartbeat',
    { preHandler: requireScanner },
    async (req) => {
      const scanner = req.scanner!;
      const b = req.body ?? {};
      await store.scanners.updateOne(
        { _id: scanner._id },
        {
          $set: {
            lastHeartbeat: now(),
            wifiRssi: b.wifiRssi ?? null,
            fw: b.fw ?? null,
            ip: b.ip ?? req.ip,
            buffered: b.buffered ?? null,
            uptime: b.uptime ?? null,
          },
        },
      );
      ctx.hub.broadcastScanners(await listScanners(store));
      const active = engine.activeForRoom(scanner.roomId);
      if (active) ctx.hub.markDirty(active.id);
      const room = await store.rooms.findOne({ _id: scanner.roomId });
      return {
        ok: true,
        now: now(),
        active: !!active,
        sessionId: active?.id ?? null,
        // scanners may relax when nothing is happening
        flushIntervalMs: active ? 3000 : 15000,
        heartbeatIntervalMs: 30000,
        beacon: { uuid: config.beaconUuid, major: room?.beaconMajor ?? null, minor: scanner.beaconMinor },
      };
    },
  );

  app.get('/scanners', { preHandler: requireUser(ctx.lookupUser) }, async () => listScanners(store));
}

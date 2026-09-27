import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import type { AuthUser } from './auth.ts';
import { config } from './config.ts';
import type { Ctx } from './context.ts';
import { Engine } from './engine.ts';
import { Hub } from './realtime.ts';
import { authRoutes } from './routes/auth.ts';
import { miscRoutes } from './routes/misc.ts';
import { presenceRoutes } from './routes/presence.ts';
import { scannerRoutes } from './routes/scanners.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { buildSnapshot } from './snapshot.ts';
import { Store } from './store.ts';
import { TokenResolver } from './tokens.ts';

export async function buildServer(opts: { mongoUri?: string; logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? 'info' } });
  const logErr = (e: unknown): void => app.log.error(e);

  const store = await Store.connect(opts.mongoUri, (m) => app.log.info(m));
  const engine = new Engine(store, logErr);
  const resolver = new TokenResolver(store, logErr);
  await resolver.refresh();
  resolver.start();
  const hub = new Hub((id) => buildSnapshot(store, engine, id), 300, logErr);
  engine.onChange = (id) => hub.markDirty(id);
  const resumed = await engine.resumeActiveSessions();
  if (resumed) app.log.info(`Resumed ${resumed} active session(s) from MongoDB`);

  const lookupUser = async (uid: string): Promise<AuthUser | null> => {
    const r = await store.users.findOne({ _id: uid }, { projection: { _id: 1, role: 1, name: 1, email: 1 } });
    return r ? { id: r._id, role: r.role, name: r.name, email: r.email } : null;
  };
  const ctx: Ctx = { store, engine, hub, resolver, lookupUser };

  await app.register(cors, { origin: true });
  await app.register(websocket);

  // Keep the raw body so scanner signatures can be verified byte-for-byte.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body || (body as string).trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  await app.register(
    async (api) => {
      await authRoutes(api, ctx);
      await sessionRoutes(api, ctx);
      await scannerRoutes(api, ctx);
      await presenceRoutes(api, ctx);
      await miscRoutes(api, ctx);
    },
    { prefix: '/api/v1' },
  );

  app.get('/ws', { websocket: true }, (socket) => hub.add(socket));

  if (existsSync(config.dashboardDist)) {
    await app.register(fastifyStatic, { root: config.dashboardDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      return reply.sendFile('index.html');
    });
  }

  const timer = setInterval(() => {
    try {
      engine.tick();
    } catch (e) {
      logErr(e);
    }
  }, config.tickMs);
  app.addHook('onClose', async () => {
    clearInterval(timer);
    resolver.stop();
    await store.close();
  });

  return { app, ctx };
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const { app } = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  const ips = lanAddresses();
  app.log.info(`SmartClass backend on http://localhost:${config.port}  (LAN: ${ips.map((ip) => `http://${ip}:${config.port}`).join(', ') || 'none'})`);
  app.log.info('Point ESP32 firmware SERVER_URL at one of the LAN addresses above.');
  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

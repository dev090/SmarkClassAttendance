/**
 * SmartClass simulator — fake ESP32 scanners + fake student phones, so the whole pipeline
 * (token → signed detections → backend engine → live dashboard) can be demoed with zero hardware.
 *
 *   pnpm sim                         # 5 students, 4 scanners in ITC317, "demo" scenario, auto-starts a demo class
 *   pnpm sim -- --scenario steady    # everyone sits still
 *   pnpm sim -- --students john,sarah --scanners ITC317-A,ITC317-C --no-start
 *   pnpm sim -- --server http://192.168.1.23:4000
 *
 * Real phones and real ESP32s can run at the same time: the simulator defaults to students that
 * have no physical phone (john, sarah, maya, liam, zoe) and never sends a deviceId, so it never
 * rotates anybody's secret.
 */
import { createHmac } from 'node:crypto';

// ------------------------------------------------------------------ args
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (!a.startsWith('--')) continue;
  const [k, v] = a.slice(2).split('=');
  if (v !== undefined) args.set(k!, v);
  else if (process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')) args.set(k!, process.argv[++i]!);
  else args.set(k!, 'true');
}
const SERVER = args.get('server') ?? process.env.SMARTCLASS_SERVER ?? 'http://localhost:4000';
const STUDENTS = (args.get('students') ?? 'john,sarah,maya,liam,zoe').split(',').filter(Boolean);
const SCANNERS = (args.get('scanners') ?? 'ITC317-A,ITC317-B,ITC317-C,ITC317-D').split(',').filter(Boolean);
const SCENARIO = args.get('scenario') ?? 'demo';
const AUTO_START = !args.has('no-start') && args.get('start') !== 'false';
const COURSE = args.get('course') ?? 'SWE4203';
const SPEED = Number(args.get('speed') ?? 1);
const FLUSH_MS = 3000;

// ------------------------------------------------------------------ helpers
const log = (...m: unknown[]): void => console.log(new Date().toISOString().slice(11, 19), ...m);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const nowSec = (): number => Math.floor(Date.now() / 1000);
const deriveToken = (secretHex: string, window: number): string =>
  createHmac('sha256', Buffer.from(secretHex, 'hex')).update(`smartclass:v1:${window}`).digest('hex').slice(0, 16).toUpperCase();
const sign = (secret: string, ts: number, body: string): string => createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SERVER}/api/v1${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`${path} → ${res.status} ${body.error ?? ''}`);
  return body;
}

async function scannerPost<T>(scannerId: string, path: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload);
  const ts = nowSec();
  return api<T>(path, {
    method: 'POST',
    body,
    headers: { 'x-scanner-id': scannerId, 'x-timestamp': String(ts), 'x-signature': sign(`scanner-secret-${scannerId}`, ts, body) },
  });
}

// ------------------------------------------------------------------ classroom geometry
type Zone = 'front-left' | 'front-right' | 'back-left' | 'back-right' | 'front' | 'back' | 'outside';
const ZONE_XY: Record<Exclude<Zone, 'outside'>, [number, number]> = {
  'front-left': [0, 0],
  'front-right': [1, 0],
  'back-left': [0, 1],
  'back-right': [1, 1],
  front: [0.5, 0],
  back: [0.5, 1],
};
const scannerZone = (id: string): Exclude<Zone, 'outside'> => {
  const suffix = id.split('-').pop();
  return suffix === 'A' ? 'front-left' : suffix === 'B' ? 'front-right' : suffix === 'C' ? 'back-left' : suffix === 'D' ? 'back-right' : 'front';
};
const gauss = (): number => (Math.random() + Math.random() + Math.random() - 1.5) * 2;

/** RSSI a scanner would see for a phone in `zone`; 1 grid unit ≈ 6 m; log-distance path loss + noise */
function rssiFor(zone: Zone, scanner: string): number | null {
  if (zone === 'outside') return null;
  const [px, py] = ZONE_XY[zone];
  const [sx, sy] = ZONE_XY[scannerZone(scanner)];
  const meters = Math.max(1, Math.hypot(px - sx, py - sy) * 6);
  const rssi = -42 - 25 * Math.log10(meters) + gauss() * 2;
  return Math.round(Math.max(-98, Math.min(-35, rssi)));
}

/** packets heard per 3 s flush: Android advertises every 100 ms; weaker signals lose more packets */
function packetsFor(rssi: number): number {
  const quality = Math.max(0.05, Math.min(1, (rssi + 95) / 45));
  return Math.max(1, Math.round(30 * quality + gauss() * 2));
}

// ------------------------------------------------------------------ scenarios: (student index, seconds since start) → zone
type Scenario = (i: number, t: number, n: number) => Zone;
const zonesCycle: Zone[] = ['front-left', 'front-right', 'back-left', 'back-right'];
const scenarios: Record<string, Scenario> = {
  /** the demo-day script: staggered arrivals, one moves to the back, one leaves and comes back */
  demo: (i, t) => {
    const arrive = 5 + i * 12;
    if (t < arrive) return 'outside';
    if (i === 0) return t > 60 && t < 130 ? 'back-right' : 'front-left';
    if (i === 1) return t > 90 && t < 150 ? 'outside' : 'front-right';
    if (i === 2) return 'back-left';
    if (i === 3) return t > 200 ? 'outside' : 'front-right';
    return zonesCycle[i % 4]!;
  },
  /** everyone present, tiny jitter only */
  steady: (i, t) => (t < 3 ? 'outside' : zonesCycle[i % 4]!),
  /** constant churn: good for stress-testing state transitions */
  chaos: (i, t) => {
    const period = 40 + i * 7;
    const phase = Math.floor(t / period);
    return phase % 3 === 2 ? 'outside' : zonesCycle[(i + phase) % 4]!;
  },
};

// ------------------------------------------------------------------ main
interface Student {
  name: string;
  secret: string;
  userId: string;
}

async function main(): Promise<void> {
  const scenario = scenarios[SCENARIO];
  if (!scenario) throw new Error(`unknown scenario "${SCENARIO}" (demo|steady|chaos)`);
  log(`server ${SERVER}`);

  const students: Student[] = [];
  for (const name of STUDENTS) {
    const email = name.includes('@') ? name : `${name}@unb.ca`;
    const r = await api<{ secret: string; user: { id: string } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'password', platform: 'android' }),
    });
    students.push({ name, secret: r.secret, userId: r.user.id });
  }
  log(`phones: ${students.map((s) => s.name).join(', ')}`);
  log(`scanners: ${SCANNERS.join(', ')}`);

  if (AUTO_START) {
    const prof = await api<{ token: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'prof@unb.ca', password: 'password' }) });
    const active = await api<Array<{ id: string; courseId: string }>>('/sessions/active', { headers: { authorization: `Bearer ${prof.token}` } });
    if (active.some((s) => s.courseId === COURSE)) log(`class ${COURSE} already running`);
    else {
      await api('/sessions/start', {
        method: 'POST',
        headers: { authorization: `Bearer ${prof.token}` },
        body: JSON.stringify({ courseId: COURSE, demo: true, durationMinutes: 20 }),
      });
      log(`started demo class ${COURSE}`);
    }
  }

  const start = Date.now();
  let lastHeartbeat = 0;
  const lastZone = new Map<string, Zone>();
  for (;;) {
    const t = ((Date.now() - start) / 1000) * SPEED;
    const window = Math.floor(nowSec() / 60);

    if (Date.now() - lastHeartbeat > 30_000) {
      lastHeartbeat = Date.now();
      await Promise.all(
        SCANNERS.map((id) =>
          scannerPost(id, '/scanners/heartbeat', { fw: 'sim', wifiRssi: -50 - Math.round(Math.random() * 15), uptime: Math.round(t), buffered: 0 }).catch((e) =>
            log(`heartbeat ${id} failed: ${(e as Error).message}`),
          ),
        ),
      );
    }

    for (const scannerId of SCANNERS) {
      const detections: Array<{ token: string; rssi: number; max: number; n: number; ts: number; src: string }> = [];
      students.forEach((s, i) => {
        const zone = scenario(i, t, students.length);
        if (lastZone.get(s.name) !== zone) {
          lastZone.set(s.name, zone);
          if (scannerId === SCANNERS[0]) log(`${s.name} → ${zone}`);
        }
        const rssi = rssiFor(zone, scannerId);
        if (rssi === null) return;
        const n = packetsFor(rssi);
        detections.push({ token: deriveToken(s.secret, window), rssi, max: Math.min(-35, rssi + 3), n, ts: nowSec(), src: 'sim' });
      });
      if (detections.length === 0) continue;
      try {
        const r = await scannerPost<{ accepted: number; unknown: number; active: boolean }>(scannerId, '/detections', { detections });
        if (!r.active && Math.round(t) % 15 === 0) log(`(no active class in ${scannerId}'s room — start one in the dashboard)`);
      } catch (e) {
        log(`detections ${scannerId} failed: ${(e as Error).message}`);
      }
    }
    await sleep(FLUSH_MS / SPEED);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { randomBytes } from 'node:crypto';
import { MongoClient, type Collection, type Db, type ObjectId } from 'mongodb';
import type { Role } from './auth.ts';
import { hashPassword } from './auth.ts';
import type { AttendanceConfig } from './config.ts';
import { now } from './config.ts';

// ------------------------------------------------------------------ documents
export interface UserDoc {
  _id: string;
  email: string;
  passwordHash: string;
  name: string;
  studentNumber: string | null;
  role: Role;
  /** 32 random bytes (hex) — the BLE token seed; rotates on device migration */
  secret: string | null;
  platform: string | null;
  deviceId: string | null;
  createdAt: number;
}

export interface RoomDoc {
  _id: string;
  name: string;
  beaconMajor: number | null;
}

export interface CourseDoc {
  _id: string;
  code: string;
  name: string;
  professorId: string;
  roomId: string;
  schedule: string | null;
  durationMinutes: number;
  studentIds: string[];
}

export interface ScannerDoc {
  _id: string;
  roomId: string;
  zone: string;
  secret: string;
  beaconMinor: number | null;
  lastHeartbeat: number | null;
  wifiRssi: number | null;
  fw: string | null;
  ip: string | null;
  buffered: number | null;
  uptime: number | null;
}

export interface SessionDoc {
  _id: string;
  courseId: string;
  roomId: string;
  startedAt: number;
  scheduledEnd: number;
  endedAt: number | null;
  status: 'active' | 'ended';
  demo: boolean;
  config: AttendanceConfig;
  startedBy: string | null;
}

export interface ManualDoc {
  state: 'present' | 'absent' | 'excused';
  by: string;
  at: number;
  note: string | null;
}

export interface AttendanceDoc {
  /** `${sessionId}:${userId}` */
  _id: string;
  sessionId: string;
  userId: string;
  state: string;
  firstSeen: number | null;
  lastSeen: number | null;
  arrivalAt: number | null;
  departureAt: number | null;
  presentSeconds: number;
  awaySeconds: number;
  awayEpisodes: number;
  observations: number;
  late: boolean;
  veryLate: boolean;
  leftEarly: boolean;
  confidence: number;
  zone: string | null;
  manual: ManualDoc | null;
  /** iOS region monitoring says the phone is inside the room (background presence) */
  regionInside?: boolean;
  updatedAt: number;
}

export interface DetectionWindowDoc {
  /** `${sessionId}:${userId}:${scannerId}:${windowStart}` */
  _id: string;
  sessionId: string;
  userId: string;
  scannerId: string;
  windowStart: number;
  count: number;
  rssiSum: number;
  rssiMax: number;
  source: string;
}

export interface EventDoc {
  _id?: ObjectId;
  sessionId: string;
  userId: string | null;
  type: string;
  at: number;
  /** strictly increasing within a process, used for ordering ties in `at` */
  seq: number;
  data: Record<string, unknown>;
}

export interface OccupancyDoc {
  /** `${sessionId}:${at}` */
  _id: string;
  sessionId: string;
  at: number;
  present: number;
  away: number;
}

export const newId = (prefix: string): string => `${prefix}_${randomBytes(6).toString('hex')}`;
export const newSecret = (): string => randomBytes(32).toString('hex');

// ------------------------------------------------------------------ store
export class Store {
  readonly client: MongoClient;
  readonly db: Db;
  readonly users: Collection<UserDoc>;
  readonly rooms: Collection<RoomDoc>;
  readonly courses: Collection<CourseDoc>;
  readonly scanners: Collection<ScannerDoc>;
  readonly sessions: Collection<SessionDoc>;
  readonly attendance: Collection<AttendanceDoc>;
  readonly detectionWindows: Collection<DetectionWindowDoc>;
  readonly events: Collection<EventDoc>;
  readonly occupancy: Collection<OccupancyDoc>;
  /** set when the in-memory fallback is used */
  readonly ephemeral: boolean;
  private stopFallback: (() => Promise<void>) | null = null;
  private seq = Date.now();
  private readonly chains = new Map<string, Promise<unknown>>();

  private constructor(client: MongoClient, dbName: string, ephemeral: boolean) {
    this.client = client;
    this.db = client.db(dbName);
    this.ephemeral = ephemeral;
    this.users = this.db.collection<UserDoc>('users');
    this.rooms = this.db.collection<RoomDoc>('rooms');
    this.courses = this.db.collection<CourseDoc>('courses');
    this.scanners = this.db.collection<ScannerDoc>('scanners');
    this.sessions = this.db.collection<SessionDoc>('sessions');
    this.attendance = this.db.collection<AttendanceDoc>('attendance');
    this.detectionWindows = this.db.collection<DetectionWindowDoc>('detection_windows');
    this.events = this.db.collection<EventDoc>('events');
    this.occupancy = this.db.collection<OccupancyDoc>('occupancy_samples');
  }

  /**
   * Connects to MONGODB_URI. If it is unset and nothing listens on localhost:27017,
   * starts an in-memory MongoDB (dev only — data is lost on restart).
   */
  static async connect(uri?: string, log: (msg: string) => void = console.log): Promise<Store> {
    const explicit = uri ?? process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB ?? 'smartclass';
    const target = explicit ?? 'mongodb://127.0.0.1:27017';
    try {
      const client = new MongoClient(target, { serverSelectionTimeoutMS: explicit ? 8000 : 1500 });
      await client.connect();
      await client.db(dbName).command({ ping: 1 });
      const store = new Store(client, dbName, false);
      await store.ensureIndexes();
      await store.seedIfEmpty();
      log(`MongoDB connected: ${redact(target)} / ${dbName}`);
      return store;
    } catch (e) {
      if (explicit) {
        const msg = (e as Error).message ?? String(e);
        if (/tlsv1 alert internal error|Server selection timed out|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
          log(
            'MongoDB connection failed. If this is Atlas, the most common cause is the Network Access allowlist: ' +
              'Atlas → Network Access → Add IP Address → "Allow access from anywhere" (0.0.0.0/0) for the hackathon, ' +
              'or add this laptop\'s public IP. Also check the username/password in MONGODB_URI.',
          );
        }
        throw e;
      }
      log('No MongoDB on localhost:27017 and MONGODB_URI not set — starting in-memory MongoDB (dev only, data not persisted).');
      const { MongoMemoryServer } = await import('mongodb-memory-server-core');
      const mem = await MongoMemoryServer.create();
      const client = new MongoClient(mem.getUri(), { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      const store = new Store(client, dbName, true);
      store.stopFallback = async () => {
        await mem.stop();
      };
      await store.ensureIndexes();
      await store.seedIfEmpty();
      log(`In-memory MongoDB at ${mem.getUri()}`);
      return store;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
    if (this.stopFallback) await this.stopFallback();
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Serialises async writes per key so a stale attendance state can never overwrite a newer one. */
  serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(key, next.catch(() => undefined));
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }

  async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.users.createIndex({ email: 1 }, { unique: true }),
      this.users.createIndex({ role: 1 }),
      this.courses.createIndex({ professorId: 1 }),
      this.courses.createIndex({ studentIds: 1 }),
      this.scanners.createIndex({ roomId: 1 }),
      this.sessions.createIndex({ status: 1 }),
      this.sessions.createIndex({ courseId: 1, startedAt: -1 }),
      this.attendance.createIndex({ sessionId: 1 }),
      this.detectionWindows.createIndex({ sessionId: 1, userId: 1 }),
      this.events.createIndex({ sessionId: 1, seq: -1 }),
      this.occupancy.createIndex({ sessionId: 1, at: 1 }),
    ]);
  }

  /** Dev / hackathon seed. Everything uses password "password". Scanner secrets are readable on purpose. */
  async seedIfEmpty(): Promise<void> {
    if ((await this.users.estimatedDocumentCount()) > 0) return;
    const t = now();
    const pw = hashPassword('password');
    const user = (id: string, email: string, name: string, role: Role, studentNumber: string | null): UserDoc => ({
      _id: id,
      email,
      passwordHash: pw,
      name,
      studentNumber,
      role,
      secret: role === 'student' ? newSecret() : null,
      platform: null,
      deviceId: null,
      createdAt: t,
    });
    const students: Array<[string, string, string, string]> = [
      ['usr_devansh', 'devansh@unb.ca', 'Devansh Prabhakar', '3701234'],
      ['usr_arsh', 'arsh@unb.ca', 'Arsh Singh', '3701235'],
      ['usr_param', 'param@unb.ca', 'Param Patel', '3701236'],
      ['usr_john', 'john@unb.ca', 'John Carter', '3701237'],
      ['usr_sarah', 'sarah@unb.ca', 'Sarah Chen', '3701238'],
      ['usr_maya', 'maya@unb.ca', 'Maya Okafor', '3701239'],
      ['usr_liam', 'liam@unb.ca', 'Liam Murphy', '3701240'],
      ['usr_zoe', 'zoe@unb.ca', 'Zoe Martin', '3701241'],
    ];
    await this.users.insertMany([
      user('prof_ada', 'prof@unb.ca', 'Prof. Ada Lovelace', 'professor', null),
      user('admin', 'admin@unb.ca', 'Admin', 'admin', null),
      ...students.map(([id, email, name, num]) => user(id, email, name, 'student', num)),
    ]);
    await this.rooms.insertMany([
      { _id: 'ITC317', name: 'ITC 317', beaconMajor: 317 },
      { _id: 'ITC120', name: 'ITC 120', beaconMajor: 120 },
    ]);
    const scanner = (id: string, roomId: string, zone: string, minor: number): ScannerDoc => ({
      _id: id,
      roomId,
      zone,
      secret: `scanner-secret-${id}`,
      beaconMinor: minor,
      lastHeartbeat: null,
      wifiRssi: null,
      fw: null,
      ip: null,
      buffered: null,
      uptime: null,
    });
    await this.scanners.insertMany([
      scanner('ITC317-A', 'ITC317', 'front-left', 1),
      scanner('ITC317-B', 'ITC317', 'front-right', 2),
      scanner('ITC317-C', 'ITC317', 'back-left', 3),
      scanner('ITC317-D', 'ITC317', 'back-right', 4),
      scanner('ITC120-A', 'ITC120', 'front', 1),
    ]);
    await this.courses.insertMany([
      {
        _id: 'SWE4203',
        code: 'SWE 4203',
        name: 'Software Evolution',
        professorId: 'prof_ada',
        roomId: 'ITC317',
        schedule: 'Mon/Wed 10:00–11:20',
        durationMinutes: 80,
        studentIds: students.map(([id]) => id),
      },
      {
        _id: 'CS3503',
        code: 'CS 3503',
        name: 'Computer Networks',
        professorId: 'prof_ada',
        roomId: 'ITC120',
        schedule: 'Tue/Thu 13:00–14:20',
        durationMinutes: 80,
        studentIds: students.slice(0, 5).map(([id]) => id),
      },
    ]);
  }

  // ------------------------------------------------------------------ helpers used by several modules
  async roomsById(): Promise<Map<string, RoomDoc>> {
    return new Map((await this.rooms.find().toArray()).map((r) => [r._id, r]));
  }

  async coursesById(ids?: string[]): Promise<Map<string, CourseDoc>> {
    const list = await this.courses.find(ids ? { _id: { $in: ids } } : {}).toArray();
    return new Map(list.map((c) => [c._id, c]));
  }
}

function redact(uri: string): string {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

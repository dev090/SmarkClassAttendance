import { DEMO_CONFIG, REAL_CONFIG, config, now, type AttendanceConfig } from './config.ts';
import { newId, type AttendanceDoc, type Store } from './store.ts';

export type State = 'unknown' | 'detected' | 'present' | 'away' | 'left';
export type ManualState = 'present' | 'absent' | 'excused';
export type Source = 'BLE_ANDROID' | 'IOS_BEACON' | 'SIMULATOR';
/** ranging = a reading with RSSI; region_enter/exit = iOS background region monitoring events */
export type EvidenceKind = 'ranging' | 'region_enter' | 'region_exit';

export interface Reading {
  scannerId: string;
  rssi: number;
  at: number;
  source: Source;
}

export interface StudentInfo {
  userId: string;
  name: string;
  studentNumber: string | null;
  platform: string | null;
}

export interface Manual {
  state: ManualState;
  by: string;
  at: number;
  note: string | null;
}

export interface StudentRuntime {
  info: StudentInfo;
  state: State;
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
  zoneVotes: string[];
  readings: Reading[];
  scannersSeen: Set<string>;
  maxRssi: number;
  manual: Manual | null;
  /** iOS says the phone is inside the room's beacon region (no continuous readings expected) */
  regionInside: boolean;
  dirty: boolean;
}

export interface SessionRuntime {
  id: string;
  courseId: string;
  courseCode: string;
  courseName: string;
  roomId: string;
  startedAt: number;
  scheduledEnd: number;
  endedAt: number | null;
  status: 'active' | 'ended';
  demo: boolean;
  config: AttendanceConfig;
  students: Map<string, StudentRuntime>;
  scannerZones: Map<string, string>;
  /** registered devices heard in the room that are not enrolled in this course */
  visitors: Map<string, number>;
  lastTick: number;
  lastOccupancySample: number;
}

export interface Evidence {
  scannerId: string;
  roomId: string;
  userId: string;
  /** average (or single) RSSI of this observation */
  rssi: number;
  /** strongest RSSI in the aggregated batch, defaults to rssi */
  maxRssi?: number;
  /** number of BLE packets this evidence aggregates (scanners batch per flush), defaults to 1 */
  count?: number;
  at: number;
  source: Source;
  kind?: EvidenceKind;
}

export type IngestResult =
  | { ok: true; sessionId: string; state: State }
  | { ok: false; reason: 'no_active_session' | 'not_enrolled' };

/**
 * The attendance brain. All hot-path work (ingest, tick) is synchronous on in-memory state;
 * MongoDB writes are fire-and-forget through the store (serialised per document), so a burst of
 * BLE packets never blocks on the database.
 */
export class Engine {
  /** active sessions only */
  readonly sessions = new Map<string, SessionRuntime>();
  private readonly byRoom = new Map<string, string>();
  private readonly lastRoomByUser = new Map<string, { roomId: string; at: number }>();
  private readonly store: Store;
  private readonly log: (e: unknown) => void;

  onChange: (sessionId: string) => void = () => {};
  onEnded: (sessionId: string) => void = () => {};

  constructor(store: Store, log: (e: unknown) => void = (e) => console.error(e)) {
    this.store = store;
    this.log = log;
  }

  // ------------------------------------------------------------------ sessions
  activeForRoom(roomId: string): SessionRuntime | undefined {
    const id = this.byRoom.get(roomId);
    return id ? this.sessions.get(id) : undefined;
  }

  async startSession(opts: {
    courseId: string;
    startedBy: string;
    demo?: boolean;
    config?: Partial<AttendanceConfig>;
    durationMinutes?: number;
  }): Promise<SessionRuntime> {
    const course = await this.store.courses.findOne({ _id: opts.courseId });
    if (!course) throw new Error('course_not_found');
    if (this.byRoom.has(course.roomId)) throw new Error('room_busy');

    const t = now();
    const cfg: AttendanceConfig = { ...(opts.demo ? DEMO_CONFIG : REAL_CONFIG), ...(opts.config ?? {}) };
    const id = newId('sess');
    await this.store.sessions.insertOne({
      _id: id,
      courseId: course._id,
      roomId: course.roomId,
      startedAt: t,
      scheduledEnd: t + (opts.durationMinutes ?? course.durationMinutes) * 60,
      endedAt: null,
      status: 'active',
      demo: !!opts.demo,
      config: cfg,
      startedBy: opts.startedBy,
    });
    const rt = (await this.loadSessionRuntime(id))!;
    this.register(rt);
    this.logEvent(rt, null, 'session_started', { by: opts.startedBy, demo: !!opts.demo });
    this.onChange(id);
    return rt;
  }

  /** Called at boot: re-attach any session that was active when the server last stopped. */
  async resumeActiveSessions(): Promise<number> {
    const rows = await this.store.sessions.find({ status: 'active' }, { projection: { _id: 1 } }).toArray();
    for (const { _id } of rows) {
      const rt = await this.loadSessionRuntime(_id);
      if (rt) this.register(rt);
    }
    return rows.length;
  }

  private register(rt: SessionRuntime): void {
    this.sessions.set(rt.id, rt);
    this.byRoom.set(rt.roomId, rt.id);
  }

  async endSession(id: string, by: string): Promise<SessionRuntime> {
    const rt = this.sessions.get(id);
    if (!rt) throw new Error('session_not_active');
    const t = now();
    this.tickSession(rt, t);
    const writes: Promise<void>[] = [];
    for (const s of rt.students.values()) {
      if (s.state === 'left' || s.state === 'away') s.leftEarly = (s.departureAt ?? t) < rt.scheduledEnd - 300;
      if (s.state === 'detected') s.state = 'unknown';
      writes.push(this.persistStudent(rt, s));
    }
    rt.status = 'ended';
    rt.endedAt = t;
    this.sessions.delete(id);
    this.byRoom.delete(rt.roomId);
    await Promise.all(writes);
    await this.store.sessions.updateOne({ _id: id }, { $set: { status: 'ended', endedAt: t } });
    this.logEvent(rt, null, 'session_ended', { by });
    this.onEnded(id);
    return rt;
  }

  async updateConfig(id: string, partial: Partial<AttendanceConfig>): Promise<SessionRuntime> {
    const rt = this.sessions.get(id);
    if (!rt) throw new Error('session_not_active');
    rt.config = { ...rt.config, ...partial };
    await this.store.sessions.updateOne({ _id: id }, { $set: { config: rt.config } });
    this.logEvent(rt, null, 'config_changed', partial as Record<string, unknown>);
    this.onChange(id);
    return rt;
  }

  /** Builds a runtime from MongoDB for any session (active or ended). Does not register it. */
  async loadSessionRuntime(id: string): Promise<SessionRuntime | null> {
    const row = await this.store.sessions.findOne({ _id: id });
    if (!row) return null;
    const course = await this.store.courses.findOne({ _id: row.courseId });
    if (!course) return null;
    const [scanners, users, att] = await Promise.all([
      this.store.scanners.find({ roomId: row.roomId }, { projection: { _id: 1, zone: 1 } }).toArray(),
      this.store.users
        .find({ _id: { $in: course.studentIds } }, { projection: { _id: 1, name: 1, studentNumber: 1, platform: 1 } })
        .sort({ name: 1 })
        .toArray(),
      this.store.attendance.find({ sessionId: id }).toArray(),
    ]);

    const rt: SessionRuntime = {
      id: row._id,
      courseId: course._id,
      courseCode: course.code,
      courseName: course.name,
      roomId: row.roomId,
      startedAt: row.startedAt,
      scheduledEnd: row.scheduledEnd,
      endedAt: row.endedAt,
      status: row.status,
      demo: row.demo,
      config: { ...REAL_CONFIG, ...row.config },
      students: new Map(),
      scannerZones: new Map(scanners.map((s) => [s._id, s.zone])),
      visitors: new Map(),
      lastTick: now(),
      lastOccupancySample: 0,
    };

    const attByUser = new Map(att.map((a) => [a.userId, a]));
    for (const u of users) {
      const s = this.blankStudent({ userId: u._id, name: u.name, studentNumber: u.studentNumber, platform: u.platform });
      const a = attByUser.get(u._id);
      if (a) {
        s.state = a.state as State;
        s.firstSeen = a.firstSeen;
        s.lastSeen = a.lastSeen;
        s.arrivalAt = a.arrivalAt;
        s.departureAt = a.departureAt;
        s.presentSeconds = a.presentSeconds;
        s.awaySeconds = a.awaySeconds;
        s.awayEpisodes = a.awayEpisodes;
        s.observations = a.observations;
        s.late = a.late;
        s.veryLate = a.veryLate;
        s.leftEarly = a.leftEarly;
        s.confidence = a.confidence;
        s.zone = a.zone;
        s.manual = a.manual;
        s.regionInside = a.regionInside ?? false;
      }
      rt.students.set(u._id, s);
    }
    return rt;
  }

  private blankStudent(info: StudentInfo): StudentRuntime {
    return {
      info,
      state: 'unknown',
      firstSeen: null,
      lastSeen: null,
      arrivalAt: null,
      departureAt: null,
      presentSeconds: 0,
      awaySeconds: 0,
      awayEpisodes: 0,
      observations: 0,
      late: false,
      veryLate: false,
      leftEarly: false,
      confidence: 0,
      zone: null,
      zoneVotes: [],
      readings: [],
      scannersSeen: new Set(),
      maxRssi: -127,
      manual: null,
      regionInside: false,
      dirty: false,
    };
  }

  // ------------------------------------------------------------------ evidence
  ingest(ev: Evidence): IngestResult {
    let rt = this.activeForRoom(ev.roomId);
    if (!rt && config.singleRoomDemo && this.sessions.size === 1) rt = [...this.sessions.values()][0];
    if (!rt) return { ok: false, reason: 'no_active_session' };

    const s = rt.students.get(ev.userId);
    if (!s) {
      rt.visitors.set(ev.userId, ev.at);
      return { ok: false, reason: 'not_enrolled' };
    }

    if (ev.kind === 'region_exit') {
      // iOS confirmed the phone left the room's beacon area: the student was present until now.
      s.regionInside = false;
      s.lastSeen = Math.max(s.lastSeen ?? 0, ev.at);
      if (s.state === 'present') {
        s.state = 'away';
        s.awayEpisodes += 1;
        s.departureAt = ev.at;
        this.logEvent(rt, ev.userId, 'away', { since: ev.at, reason: 'region_exit', scannerId: ev.scannerId });
      } else if (s.state === 'detected') {
        s.state = 'unknown';
        s.firstSeen = null;
        s.observations = 0;
        this.logEvent(rt, ev.userId, 'lost', { reason: 'region_exit' });
      }
      s.dirty = true;
      this.onChange(rt.id);
      return { ok: true, sessionId: rt.id, state: s.state };
    }
    // Any evidence from the phone itself (region enter or a live reading) means the phone is in the room.
    // The flag makes silence tolerable: if the app is killed, the student stays present until iOS reports
    // the exit, the app reports it, or the class-long safety timer expires.
    if (ev.source === 'IOS_BEACON') s.regionInside = true;

    // Replay / cloning heuristic: same device heard in two rooms within a minute.
    const prev = this.lastRoomByUser.get(ev.userId);
    if (prev && prev.roomId !== ev.roomId && ev.at - prev.at < 60) {
      this.logEvent(rt, ev.userId, 'duplicate_room', { otherRoom: prev.roomId });
    }
    this.lastRoomByUser.set(ev.userId, { roomId: ev.roomId, at: ev.at });

    // a region-enter event is already debounced by iOS: count it as enough observations to confirm presence
    s.observations += ev.kind === 'region_enter' ? rt.config.minObservations : Math.min(50, Math.max(1, Math.floor(ev.count ?? 1)));
    s.lastSeen = Math.max(s.lastSeen ?? 0, ev.at);
    s.scannersSeen.add(ev.scannerId);
    s.maxRssi = Math.max(s.maxRssi, ev.maxRssi ?? ev.rssi);
    s.readings.push({ scannerId: ev.scannerId, rssi: ev.rssi, at: ev.at, source: ev.source });
    if (s.readings.length > config.readingsRingSize) s.readings.splice(0, s.readings.length - config.readingsRingSize);
    this.aggregateWindow(rt, ev);

    const from = s.state;
    switch (s.state) {
      case 'unknown':
        s.state = 'detected';
        s.firstSeen = ev.at;
        this.logEvent(rt, ev.userId, 'detected', { scannerId: ev.scannerId, rssi: ev.rssi });
        break;
      case 'away':
      case 'left':
        s.state = 'present';
        s.departureAt = null;
        this.logEvent(rt, ev.userId, 'returned', { scannerId: ev.scannerId, from });
        break;
      default:
        break;
    }
    s.dirty = true;
    this.onChange(rt.id);
    return { ok: true, sessionId: rt.id, state: s.state };
  }

  /** Per-minute aggregate instead of storing every packet. */
  private aggregateWindow(rt: SessionRuntime, ev: Evidence): void {
    const windowStart = Math.floor(ev.at / 60) * 60;
    const _id = `${rt.id}:${ev.userId}:${ev.scannerId}:${windowStart}`;
    void this.store.detectionWindows
      .updateOne(
        { _id },
        {
          $inc: { count: Math.max(1, Math.floor(ev.count ?? 1)), rssiSum: ev.rssi * Math.max(1, Math.floor(ev.count ?? 1)) },
          $max: { rssiMax: ev.maxRssi ?? ev.rssi },
          $setOnInsert: { sessionId: rt.id, userId: ev.userId, scannerId: ev.scannerId, windowStart, source: ev.source },
        },
        { upsert: true },
      )
      .catch(this.log);
  }

  // ------------------------------------------------------------------ manual
  async setOverride(sessionId: string, userId: string, state: ManualState | null, by: string, note: string | null): Promise<void> {
    const rt = this.sessions.get(sessionId);
    if (!rt) throw new Error('session_not_active');
    const s = rt.students.get(userId);
    if (!s) throw new Error('student_not_enrolled');
    s.manual = state ? { state, by, at: now(), note } : null;
    await this.persistStudent(rt, s);
    this.logEvent(rt, userId, 'manual_override', { state, by, note });
    this.onChange(rt.id);
  }

  // ------------------------------------------------------------------ tick
  tick(): void {
    const t = now();
    for (const rt of this.sessions.values()) this.tickSession(rt, t);
  }

  private tickSession(rt: SessionRuntime, t: number): void {
    const dt = Math.max(0, t - rt.lastTick);
    rt.lastTick = t;
    const cfg = rt.config;
    let changed = false;

    for (const s of rt.students.values()) {
      const sinceSeen = s.lastSeen === null ? Infinity : t - s.lastSeen;
      const before = s.state;
      // a locked iPhone inside the region sends nothing until iOS reports the exit
      const silenceLimit = s.regionInside ? cfg.regionStaleSeconds : cfg.awayGraceSeconds;

      switch (s.state) {
        case 'detected': {
          const confirmed =
            s.observations >= cfg.minObservations && t - (s.firstSeen ?? t) >= cfg.presentConfirmationSeconds;
          if (confirmed) {
            s.state = 'present';
            s.arrivalAt = s.firstSeen;
            s.presentSeconds += t - (s.firstSeen ?? t);
            const lateBy = (s.arrivalAt ?? t) - rt.startedAt;
            s.late = lateBy > cfg.lateThresholdSeconds;
            s.veryLate = lateBy > cfg.veryLateThresholdSeconds;
            this.logEvent(rt, s.info.userId, 'present', { arrivalAt: s.arrivalAt, late: s.late, veryLate: s.veryLate });
          } else if (sinceSeen > silenceLimit) {
            // heard once or twice, then vanished: treat as a false positive
            s.state = 'unknown';
            s.firstSeen = null;
            s.observations = 0;
            this.logEvent(rt, s.info.userId, 'lost', {});
          }
          break;
        }
        case 'present': {
          s.presentSeconds += dt;
          if (sinceSeen > silenceLimit) {
            s.state = 'away';
            s.awayEpisodes += 1;
            s.departureAt = s.lastSeen;
            s.regionInside = false;
            // seconds between last detection and now were counted as present; move them to away
            s.presentSeconds = Math.max(0, s.presentSeconds - sinceSeen);
            s.awaySeconds += sinceSeen;
            this.logEvent(rt, s.info.userId, 'away', { since: s.lastSeen });
          }
          break;
        }
        case 'away': {
          s.awaySeconds += dt;
          if (sinceSeen > cfg.leftThresholdSeconds) {
            s.state = 'left';
            this.logEvent(rt, s.info.userId, 'left', { since: s.lastSeen });
          }
          break;
        }
        case 'left':
        case 'unknown':
          break;
      }

      if (s.state === 'present' || s.state === 'detected') this.updateZone(rt, s, t);
      const conf = this.confidence(rt, s, t);
      if (conf !== s.confidence) {
        s.confidence = conf;
        s.dirty = true;
      }
      if (before !== s.state || s.state === 'present' || s.state === 'away') s.dirty = true;
      if (s.dirty) {
        void this.persistStudent(rt, s);
        changed = true;
      }
    }

    if (t - rt.lastOccupancySample >= cfg.occupancySampleSeconds) {
      rt.lastOccupancySample = t;
      let present = 0;
      let away = 0;
      for (const s of rt.students.values()) {
        const eff = effectiveState(s);
        if (eff === 'present') present++;
        else if (eff === 'away') away++;
      }
      void this.store.occupancy
        .updateOne({ _id: `${rt.id}:${t}` }, { $set: { sessionId: rt.id, at: t, present, away } }, { upsert: true })
        .catch(this.log);
      changed = true;
    }

    if (changed) this.onChange(rt.id);
  }

  private updateZone(rt: SessionRuntime, s: StudentRuntime, t: number): void {
    const cutoff = t - config.zoneWindowSeconds;
    const acc = new Map<string, { sum: number; n: number }>();
    for (const r of s.readings) {
      if (r.at < cutoff) continue;
      const a = acc.get(r.scannerId) ?? { sum: 0, n: 0 };
      a.sum += r.rssi;
      a.n += 1;
      acc.set(r.scannerId, a);
    }
    if (acc.size === 0) return;
    let best: string | null = null;
    let bestAvg = -Infinity;
    for (const [scannerId, a] of acc) {
      const avg = a.sum / a.n;
      if (avg > bestAvg) {
        bestAvg = avg;
        best = scannerId;
      }
    }
    if (!best) return;
    // a scanner from another room (single-board demo) is mapped onto this room's first zone
    const candidate = rt.scannerZones.get(best) ?? [...rt.scannerZones.values()][0] ?? best;
    s.zoneVotes.push(candidate);
    if (s.zoneVotes.length > config.zoneVotes) s.zoneVotes.splice(0, s.zoneVotes.length - config.zoneVotes);

    if (s.zone === null) {
      s.zone = candidate;
      s.dirty = true;
      return;
    }
    if (candidate !== s.zone) {
      const votes = s.zoneVotes.filter((z) => z === candidate).length;
      if (votes >= config.zoneVoteThreshold) {
        this.logEvent(rt, s.info.userId, 'zone', { from: s.zone, to: candidate });
        s.zone = candidate;
        s.dirty = true;
      }
    }
  }

  private confidence(rt: SessionRuntime, s: StudentRuntime, t: number): number {
    if (s.state === 'unknown') return 0;
    const elapsed = Math.max(1, Math.min(t, rt.scheduledEnd) - rt.startedAt);
    const duration = Math.min(40, (s.presentSeconds / elapsed) * 40);
    const observations = Math.min(25, (s.observations / 30) * 25);
    const scanners = s.scannersSeen.size >= 3 ? 15 : s.scannersSeen.size === 2 ? 10 : 5;
    const signal = s.maxRssi > -60 ? 10 : s.maxRssi > -75 ? 6 : 2;
    const continuity = Math.max(0, 10 - 3 * s.awayEpisodes);
    return Math.round(duration + observations + scanners + signal + continuity);
  }

  // ------------------------------------------------------------------ persistence (write-behind)
  private persistStudent(rt: SessionRuntime, s: StudentRuntime): Promise<void> {
    s.dirty = false;
    const doc: AttendanceDoc = {
      _id: `${rt.id}:${s.info.userId}`,
      sessionId: rt.id,
      userId: s.info.userId,
      state: s.state,
      firstSeen: s.firstSeen,
      lastSeen: s.lastSeen,
      arrivalAt: s.arrivalAt,
      departureAt: s.departureAt,
      presentSeconds: s.presentSeconds,
      awaySeconds: s.awaySeconds,
      awayEpisodes: s.awayEpisodes,
      observations: s.observations,
      late: s.late,
      veryLate: s.veryLate,
      leftEarly: s.leftEarly,
      confidence: s.confidence,
      zone: s.zone,
      manual: s.manual,
      regionInside: s.regionInside,
      updatedAt: now(),
    };
    const { _id, ...body } = doc;
    return this.store
      .serial(_id, () => this.store.attendance.replaceOne({ _id }, body, { upsert: true }))
      .then(() => undefined, this.log);
  }

  private logEvent(rt: SessionRuntime, userId: string | null, type: string, data: Record<string, unknown>): void {
    void this.store.events
      .insertOne({ sessionId: rt.id, userId, type, at: now(), seq: this.store.nextSeq(), data: data ?? {} })
      .catch(this.log);
  }
}

export function effectiveState(s: StudentRuntime): State | 'excused' | 'absent' {
  if (s.manual) return s.manual.state === 'present' ? 'present' : s.manual.state;
  return s.state;
}

export const confidenceLabel = (c: number): 'high' | 'medium' | 'low' | 'none' =>
  c >= 70 ? 'high' : c >= 40 ? 'medium' : c > 0 ? 'low' : 'none';

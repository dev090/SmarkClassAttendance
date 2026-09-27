import { config, now } from './config.ts';
import { confidenceLabel, effectiveState, type Engine, type SessionRuntime, type StudentRuntime } from './engine.ts';
import type { ScannerDoc, Store } from './store.ts';

export interface ScannerView {
  id: string;
  roomId: string;
  zone: string;
  online: boolean;
  lastHeartbeat: number | null;
  wifiRssi: number | null;
  fw: string | null;
  ip: string | null;
  buffered: number | null;
  uptime: number | null;
  beaconMinor: number | null;
}

export function scannerView(r: ScannerDoc, t = now()): ScannerView {
  return {
    id: r._id,
    roomId: r.roomId,
    zone: r.zone,
    online: r.lastHeartbeat !== null && t - r.lastHeartbeat <= config.scannerOnlineSeconds,
    lastHeartbeat: r.lastHeartbeat,
    wifiRssi: r.wifiRssi,
    fw: r.fw,
    ip: r.ip,
    buffered: r.buffered,
    uptime: r.uptime,
    beaconMinor: r.beaconMinor,
  };
}

export async function listScanners(store: Store, roomId?: string): Promise<ScannerView[]> {
  const rows = await store.scanners.find(roomId ? { roomId } : {}).sort({ _id: 1 }).toArray();
  const t = now();
  return rows.map((r) => scannerView(r, t));
}

function studentView(s: StudentRuntime, t: number) {
  const recent = new Map<string, { rssi: number; lastSeen: number }>();
  for (const r of s.readings) {
    if (t - r.at > 60) continue;
    const cur = recent.get(r.scannerId);
    if (!cur || r.at >= cur.lastSeen) recent.set(r.scannerId, { rssi: r.rssi, lastSeen: r.at });
  }
  return {
    userId: s.info.userId,
    name: s.info.name,
    studentNumber: s.info.studentNumber,
    platform: s.info.platform,
    state: s.state,
    effectiveState: effectiveState(s),
    firstSeen: s.firstSeen,
    lastSeen: s.lastSeen,
    arrivalAt: s.arrivalAt,
    departureAt: s.departureAt,
    presentSeconds: Math.round(s.presentSeconds),
    awaySeconds: Math.round(s.awaySeconds),
    awayEpisodes: s.awayEpisodes,
    observations: s.observations,
    late: s.late,
    veryLate: s.veryLate,
    leftEarly: s.leftEarly,
    confidence: s.confidence,
    confidenceLabel: confidenceLabel(s.confidence),
    zone: s.zone,
    scanners: [...recent.entries()].map(([scannerId, v]) => ({ scannerId, rssi: v.rssi, lastSeen: v.lastSeen })),
    manual: s.manual,
    regionInside: s.regionInside,
  };
}

export type StudentView = ReturnType<typeof studentView>;

const TIMELINE_TYPES = ['present', 'away', 'left', 'returned', 'lost'];

export async function buildSnapshot(store: Store, engine: Engine, sessionId: string) {
  const rt: SessionRuntime | null = engine.sessions.get(sessionId) ?? (await engine.loadSessionRuntime(sessionId));
  if (!rt) return null;
  const t = now();

  const [occupancy, eventDocs, timelineDocs, scanners] = await Promise.all([
    store.occupancy.find({ sessionId }, { projection: { _id: 0, at: 1, present: 1, away: 1 } }).sort({ at: 1 }).toArray(),
    store.events.find({ sessionId }).sort({ seq: -1 }).limit(100).toArray(),
    store.events
      .find({ sessionId, userId: { $ne: null }, type: { $in: TIMELINE_TYPES } }, { projection: { _id: 0, userId: 1, type: 1, at: 1 } })
      .sort({ seq: 1 })
      .toArray(),
    listScanners(store, rt.roomId),
  ]);

  const students = [...rt.students.values()].map((s) => studentView(s, t));
  const counts = { enrolled: students.length, present: 0, away: 0, left: 0, detected: 0, absent: 0, late: 0, excused: 0 };
  const zoneCounts = new Map<string, number>();
  for (const zone of new Set(rt.scannerZones.values())) zoneCounts.set(zone, 0);
  for (const s of students) {
    switch (s.effectiveState) {
      case 'present':
        counts.present++;
        if (s.zone) zoneCounts.set(s.zone, (zoneCounts.get(s.zone) ?? 0) + 1);
        break;
      case 'away':
        counts.away++;
        break;
      case 'left':
        counts.left++;
        break;
      case 'detected':
        counts.detected++;
        break;
      case 'excused':
        counts.excused++;
        break;
      default:
        counts.absent++;
    }
    if (s.late && s.effectiveState === 'present') counts.late++;
  }

  const nameOf = (uid: string | null): string | null => (uid ? (rt.students.get(uid)?.info.name ?? null) : null);

  return {
    now: t,
    session: {
      id: rt.id,
      courseId: rt.courseId,
      courseCode: rt.courseCode,
      courseName: rt.courseName,
      roomId: rt.roomId,
      startedAt: rt.startedAt,
      scheduledEnd: rt.scheduledEnd,
      endedAt: rt.endedAt,
      status: rt.status,
      demo: rt.demo,
      config: rt.config,
    },
    counts,
    visitors: [...rt.visitors.values()].filter((at) => t - at < 120).length,
    students,
    zones: [...zoneCounts.entries()].map(([zone, count]) => ({ zone, count })),
    scanners,
    occupancy,
    events: eventDocs.map((e) => ({ at: e.at, userId: e.userId, name: nameOf(e.userId), type: e.type, data: e.data })),
    timeline: timelineDocs as Array<{ userId: string; type: string; at: number }>,
  };
}

export type Snapshot = NonNullable<Awaited<ReturnType<typeof buildSnapshot>>>;

/** Per-student totals + attendance percentage, for the end-of-class summary and history. */
export async function buildSummary(store: Store, engine: Engine, sessionId: string) {
  const snap = await buildSnapshot(store, engine, sessionId);
  if (!snap) return null;
  const end = snap.session.endedAt ?? Math.min(snap.now, snap.session.scheduledEnd);
  const duration = Math.max(1, end - snap.session.startedAt);
  const students = snap.students.map((s) => {
    const pct = s.effectiveState === 'excused' ? null : Math.min(100, Math.round((s.presentSeconds / duration) * 100));
    const verdict =
      s.effectiveState === 'excused'
        ? 'excused'
        : s.manual?.state === 'absent'
          ? 'absent'
          : s.manual?.state === 'present'
            ? 'attended'
            : pct === null
              ? 'excused'
              : pct >= 75
                ? 'attended'
                : pct >= 50
                  ? 'partial'
                  : 'absent';
    return { ...s, attendancePercent: pct, verdict };
  });
  const attended = students.filter((s) => s.verdict === 'attended').length;
  const arrivals = students.map((s) => s.arrivalAt).filter((a): a is number => a !== null);
  const peak = snap.occupancy.reduce<{ at: number; present: number } | null>(
    (best, o) => (best === null || o.present > best.present ? { at: o.at, present: o.present } : best),
    null,
  );
  return {
    session: snap.session,
    durationSeconds: duration,
    counts: snap.counts,
    attendanceRate: students.length ? Math.round((attended / students.length) * 100) : 0,
    averageArrival: arrivals.length ? Math.round(arrivals.reduce((a, b) => a + b, 0) / arrivals.length) : null,
    lateArrivals: students.filter((s) => s.late).length,
    earlyDepartures: students.filter((s) => s.leftEarly).length,
    peakOccupancy: peak,
    zones: snap.zones,
    students,
  };
}

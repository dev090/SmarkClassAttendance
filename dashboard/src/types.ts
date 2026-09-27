// Mirrors backend/src/snapshot.ts
export type State = 'unknown' | 'detected' | 'present' | 'away' | 'left';
export type EffectiveState = State | 'excused' | 'absent';

export interface AttendanceConfig {
  presentConfirmationSeconds: number;
  minObservations: number;
  awayGraceSeconds: number;
  leftThresholdSeconds: number;
  lateThresholdSeconds: number;
  veryLateThresholdSeconds: number;
  occupancySampleSeconds: number;
}

export interface SessionInfo {
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
}

export interface StudentView {
  userId: string;
  name: string;
  studentNumber: string | null;
  platform: string | null;
  state: State;
  effectiveState: EffectiveState;
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
  confidenceLabel: 'high' | 'medium' | 'low' | 'none';
  zone: string | null;
  scanners: Array<{ scannerId: string; rssi: number; lastSeen: number }>;
  manual: { state: 'present' | 'absent' | 'excused'; by: string; at: number; note: string | null } | null;
}

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

export interface Snapshot {
  now: number;
  session: SessionInfo;
  counts: { enrolled: number; present: number; away: number; left: number; detected: number; absent: number; late: number; excused: number };
  visitors: number;
  students: StudentView[];
  zones: Array<{ zone: string; count: number }>;
  scanners: ScannerView[];
  occupancy: Array<{ at: number; present: number; away: number }>;
  events: Array<{ at: number; userId: string | null; name: string | null; type: string; data: Record<string, unknown> }>;
  timeline: Array<{ userId: string; type: string; at: number }>;
}

export interface Summary {
  session: SessionInfo;
  durationSeconds: number;
  counts: Snapshot['counts'];
  attendanceRate: number;
  averageArrival: number | null;
  lateArrivals: number;
  earlyDepartures: number;
  peakOccupancy: { at: number; present: number } | null;
  zones: Snapshot['zones'];
  students: Array<StudentView & { attendancePercent: number | null; verdict: 'attended' | 'partial' | 'absent' | 'excused' }>;
}

export interface Course {
  id: string;
  code: string;
  name: string;
  roomId: string;
  roomName: string;
  schedule: string | null;
  durationMinutes: number;
  enrolled: number;
}

export interface SessionRow {
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
  enrolled: number;
  attended: number;
}

export interface User {
  id: string;
  role: 'student' | 'professor' | 'admin';
  name: string;
  email: string;
}

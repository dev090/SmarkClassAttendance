import path from 'node:path';

export interface AttendanceConfig {
  presentConfirmationSeconds: number;
  minObservations: number;
  awayGraceSeconds: number;
  leftThresholdSeconds: number;
  lateThresholdSeconds: number;
  veryLateThresholdSeconds: number;
  /** how often to store an occupancy sample */
  occupancySampleSeconds: number;
  /**
   * iPhones in the background only report region enter/exit (no continuous readings). While iOS says the
   * phone is inside the room, silence is tolerated for this long before the student is marked away.
   */
  regionStaleSeconds: number;
}

export const REAL_CONFIG: AttendanceConfig = {
  presentConfirmationSeconds: 60,
  minObservations: 3,
  awayGraceSeconds: 180,
  leftThresholdSeconds: 600,
  lateThresholdSeconds: 300,
  veryLateThresholdSeconds: 1200,
  occupancySampleSeconds: 30,
  regionStaleSeconds: 5400, // a closed iPhone stays present until iOS reports the exit or the class ends
};

export const DEMO_CONFIG: AttendanceConfig = {
  presentConfirmationSeconds: 6,
  minObservations: 2,
  awayGraceSeconds: 12,
  leftThresholdSeconds: 40,
  lateThresholdSeconds: 60,
  veryLateThresholdSeconds: 180,
  occupancySampleSeconds: 5,
  regionStaleSeconds: 3600,
};

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? path.join(import.meta.dirname, '../data/smartclass.db'),
  authSecret: process.env.AUTH_SECRET ?? 'dev-auth-secret-change-me',
  /** bearer token lifetime */
  authTtlSeconds: 60 * 60 * 24 * 30,
  /** allowed clock skew for signed scanner requests */
  scannerSkewSeconds: 300,
  /** scanner considered offline after this many seconds without heartbeat */
  scannerOnlineSeconds: 75,
  /** engine tick period */
  tickMs: 2000,
  /** BLE token window */
  tokenWindowSeconds: 60,
  /** how many readings to keep in memory per student */
  readingsRingSize: 80,
  /** window (s) used for zone estimation */
  zoneWindowSeconds: 20,
  zoneVotes: 10,
  zoneVoteThreshold: 7,
  /** path of the built dashboard, served if present */
  dashboardDist: path.join(import.meta.dirname, '../../dashboard/dist'),
  /** SmartClass iBeacon UUID (fixed) */
  beaconUuid: '5C0A7A1D-5C1A-4C1A-B1E5-000000000001',
  /**
   * Hackathon convenience: with a single ESP32 shared across "rooms", evidence heard in a room with no
   * class counts for the ONLY active class. Off by default — in production evidence must match the room.
   */
  singleRoomDemo: process.env.SINGLE_ROOM_DEMO === 'true',
};

let clockOffsetSeconds = 0;
/** unix seconds; tests can shift it with _advanceClock */
export const now = (): number => Math.floor(Date.now() / 1000) + clockOffsetSeconds;
export const nowMs = (): number => Date.now() + clockOffsetSeconds * 1000;
export function _advanceClock(seconds: number): void {
  clockOffsetSeconds += seconds;
}

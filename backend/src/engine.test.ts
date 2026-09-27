import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { _advanceClock, now } from './config.ts';
import { Engine, type Evidence } from './engine.ts';
import { Store } from './store.ts';
import { deriveToken, TokenResolver } from './tokens.ts';

let store: Store;
before(async () => {
  delete process.env.MONGODB_URI; // always test against a throwaway database
  process.env.MONGODB_DB = `smartclass_test_${Date.now()}`;
  store = await Store.connect(undefined, () => {});
});
after(async () => {
  // the engine writes behind (fire-and-forget); let the last inserts land before tearing the store down
  await new Promise((r) => setTimeout(r, 500));
  if (!store.ephemeral) await store.db.dropDatabase();
  await store.close();
});

test('deriveToken is deterministic, 16 upper-case hex chars, and changes per window', () => {
  const secret = 'ab'.repeat(32);
  const a = deriveToken(secret, 1000);
  assert.match(a, /^[0-9A-F]{16}$/);
  assert.equal(a, deriveToken(secret, 1000));
  assert.notEqual(a, deriveToken(secret, 1001));
  assert.notEqual(a, deriveToken('cd'.repeat(32), 1000));
});

test('TokenResolver resolves current, previous and next window and rejects stale tokens', async () => {
  const resolver = new TokenResolver(store, () => {});
  await resolver.refresh();
  const u = (await store.users.findOne({ _id: 'usr_devansh' }))!;
  const w = Math.floor(now() / 60);
  for (const win of [w - 1, w, w + 1]) assert.equal(resolver.resolve(deriveToken(u.secret!, win))?.userId, 'usr_devansh');
  assert.equal(resolver.resolve(deriveToken(u.secret!, w - 2)), null);
  assert.equal(resolver.resolve(deriveToken(u.secret!, w + 2)), null);
  assert.equal(resolver.resolve('0000000000000000'), null);
});

test('attendance state machine: detected → present → away → left → returned, late flag, zones, end summary', async () => {
  const engine = new Engine(store, (e) => assert.fail(String(e)));
  const rt = await engine.startSession({
    courseId: 'SWE4203',
    startedBy: 'prof_ada',
    demo: true,
    durationMinutes: 30,
    config: { presentConfirmationSeconds: 4, minObservations: 2, awayGraceSeconds: 6, leftThresholdSeconds: 12, lateThresholdSeconds: 60 },
  });
  const ev = (rssi: number, scannerId = 'ITC317-A'): Evidence => ({
    scannerId,
    roomId: 'ITC317',
    userId: 'usr_devansh',
    rssi,
    at: now(),
    source: 'SIMULATOR',
  });
  const s = rt.students.get('usr_devansh')!;

  // a student who is not enrolled in the course is reported as a visitor, not an error
  assert.deepEqual(engine.ingest({ ...ev(-60), userId: 'usr_zoe', roomId: 'ITC120' }), { ok: false, reason: 'no_active_session' });

  assert.equal(engine.ingest(ev(-60)).ok, true);
  assert.equal(s.state, 'detected');
  _advanceClock(3);
  engine.ingest(ev(-58));
  engine.tick();
  assert.equal(s.state, 'detected', 'not yet confirmed: 3 s < 4 s');
  _advanceClock(2);
  engine.tick();
  assert.equal(s.state, 'present');
  assert.equal(s.late, false);
  assert.equal(s.zone, 'front-left');
  assert.ok(s.presentSeconds >= 5, `present seconds credited from first detection (${s.presentSeconds})`);

  // moves to the back: strongest scanner flips; zone changes only after enough consistent votes
  for (let i = 0; i < 8; i++) {
    _advanceClock(1);
    engine.ingest(ev(-80, 'ITC317-A'));
    engine.ingest(ev(-50, 'ITC317-C'));
    engine.tick();
  }
  assert.equal(s.zone, 'back-left');
  assert.equal(s.state, 'present');

  _advanceClock(7);
  engine.tick();
  assert.equal(s.state, 'away');
  assert.equal(s.awayEpisodes, 1);
  _advanceClock(6);
  engine.tick();
  assert.equal(s.state, 'left');
  engine.ingest(ev(-50));
  assert.equal(s.state, 'present', 'detection after LEFT brings the student back');

  // a second student arriving after the late threshold is flagged late
  _advanceClock(60);
  engine.ingest({ ...ev(-55), userId: 'usr_arsh' });
  _advanceClock(5);
  engine.ingest({ ...ev(-55), userId: 'usr_arsh' });
  engine.tick();
  const arsh = rt.students.get('usr_arsh')!;
  assert.equal(arsh.state, 'present');
  assert.equal(arsh.late, true);

  await engine.setOverride(rt.id, 'usr_sarah', 'excused', 'prof_ada', 'sick');
  await engine.endSession(rt.id, 'prof_ada');
  assert.equal(engine.sessions.size, 0);

  // Devansh was last heard 65+ s before the class ended (> leftThreshold), so the final tick marks him LEFT,
  // and leaving 25+ min before the scheduled end counts as an early departure.
  const saved = await store.attendance.findOne({ _id: `${rt.id}:usr_devansh` });
  assert.equal(saved?.state, 'left');
  assert.equal(saved?.leftEarly, true);
  assert.equal(saved?.awayEpisodes, 2);
  assert.ok((saved?.awaySeconds ?? 0) > 0);
  const excused = await store.attendance.findOne({ _id: `${rt.id}:usr_sarah` });
  assert.equal(excused?.manual?.state, 'excused');
  const types = (await store.events.find({ sessionId: rt.id, userId: 'usr_devansh' }).sort({ seq: 1 }).toArray()).map((e) => e.type);
  assert.deepEqual(types.filter((t) => t !== 'zone'), ['detected', 'present', 'away', 'left', 'returned', 'away', 'left']);
  assert.ok(types.includes('zone'));
});

test('iOS region monitoring: enter keeps a silent (locked) phone present, exit marks away immediately', async () => {
  const engine = new Engine(store, (e) => assert.fail(String(e)));
  const rt = await engine.startSession({
    courseId: 'SWE4203',
    startedBy: 'prof_ada',
    demo: true,
    config: { presentConfirmationSeconds: 4, minObservations: 2, awayGraceSeconds: 6, leftThresholdSeconds: 12, regionStaleSeconds: 120 },
  });
  const base = { scannerId: 'ITC317-A', roomId: 'ITC317', userId: 'usr_param', rssi: -90, source: 'IOS_BEACON' as const };
  const s = rt.students.get('usr_param')!;

  assert.equal(engine.ingest({ ...base, at: now(), kind: 'region_enter' }).ok, true);
  assert.equal(s.state, 'detected');
  assert.equal(s.regionInside, true);
  _advanceClock(5);
  engine.tick();
  assert.equal(s.state, 'present', 'one enter event is enough evidence to confirm');

  // 60 s of silence would normally mean AWAY (grace 6 s) — but iOS still says inside
  _advanceClock(60);
  engine.tick();
  assert.equal(s.state, 'present');

  engine.ingest({ ...base, at: now(), kind: 'region_exit' });
  assert.equal(s.state, 'away', 'exit flips to away without waiting for the grace period');
  assert.equal(s.regionInside, false);
  _advanceClock(13);
  engine.tick();
  assert.equal(s.state, 'left');

  engine.ingest({ ...base, at: now(), kind: 'region_enter' });
  assert.equal(s.state, 'present', 're-entering brings the student back');

  // a plain reading from the phone also re-arms the sticky flag (Stop → Start → app swiped away must stay present)
  engine.ingest({ ...base, at: now(), kind: 'region_exit' });
  assert.equal(s.regionInside, false);
  engine.ingest({ ...base, at: now(), rssi: -60, kind: 'ranging' });
  assert.equal(s.regionInside, true);
  _advanceClock(60);
  engine.tick();
  assert.equal(s.state, 'present', 'silence after a live reading does not mean away for an iPhone');
  await engine.endSession(rt.id, 'prof_ada');
});

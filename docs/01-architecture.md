# 01 — Architecture

## Principle: ESP32 = sensor, backend = brain

The ESP32 never decides who is present. It only reports *"I heard token X at RSSI Y at time Z"*.
All identity resolution, attendance state, late/left logic, confidence and zone estimation live in the backend.

```
┌──────────────────────┐        ┌──────────────────┐        ┌───────────────────────────┐
│  Student Flutter app │  BLE   │   ESP32 scanner  │  HTTP  │          Backend          │
│                      │──────▶ │  (1..4 per room) │──────▶ │  Fastify + MongoDB + ws   │
│  login → secret      │        │  scan, RSSI,     │ signed │  token → user             │
│  token = HMAC(min)   │        │  batch, heartbeat│  JSON  │  attendance state machine │
│  advertise token     │        │  iBeacon (iOS)   │        │  zones / confidence       │
└──────────────────────┘        └──────────────────┘        └─────────────┬─────────────┘
         ▲  iBeacon (iOS path)          │                                 │ WebSocket snapshots
         └──────────────────────────────┘                                 ▼
                                                                ┌───────────────────┐
                                                                │ Professor dashboard│
                                                                │ Vite + React       │
                                                                └───────────────────┘
```

## Components

### Student app (Flutter)
* Login once → receives `userToken` (API auth) + `secret` (32 random bytes, per device registration).
* Every minute computes `token = HMAC_SHA256(secret, "smartclass:v1:" + floor(unixNow/60))[0..8]`.
* **Android**: advertises the token in BLE manufacturer data (company id `0xFFFF`, magic `SC`). Foreground service keeps it alive.
* **iOS**: cannot be reliably scanned by an ESP32 in background (Apple moves service UUIDs to the overflow area, drops local name). So the direction is reversed: the ESP32 advertises an iBeacon and the iPhone reports it. On screen the app *ranges* (RSSI every second → zones). Locked / in the background the app stays alive (low-power location keep-alive, needs "Always") so its own scanning continues; it reports **lost** after 3 empty scans and re-reports when the beacon is back. iOS region **enter/exit** events are the fallback if the app is killed. Server rule: any reading from an iPhone sets `regionInside`, so a killed app keeps the student present until an exit is reported or the class-long safety timer expires; **Stop detection / sign out** send an explicit `stop` (→ away).
* Shows: Bluetooth OK / account OK / device OK, current class, "You're in class since 10:01".

### ESP32 firmware (PlatformIO / Arduino / NimBLE)
* Wi-Fi → `GET /api/v1/time` for clock sync (works on a hotspot with no internet — no NTP dependency).
* Continuous passive BLE scan, duplicates allowed. Filters manufacturer data `FF FF 'S' 'C' ver token[8] flags`.
* Buffers detections and flushes every ~3 s as one signed batch: `POST /api/v1/detections`.
* Heartbeat every 30 s: `POST /api/v1/scanners/heartbeat` (Wi-Fi RSSI, uptime, fw version, buffered count).
* Optional: simultaneous iBeacon advertising for the iOS path (UUID fixed, major = room, minor = scanner index).
* Ring buffer of ~600 detections survives short Wi-Fi drops.

### Backend (Node 26 / TypeScript / Fastify / MongoDB / ws)
* **Auth**: email + password (scrypt). Signed bearer tokens (HMAC, no external JWT lib).
* **Token resolver**: for windows `w-1, w, w+1`, precompute token → userId for every student. Refreshed each minute, O(1) lookup.
* **Scanner auth**: `x-scanner-id`, `x-timestamp`, `x-signature = HMAC_SHA256(scannerSecret, timestamp + "." + rawBody)`. ±300 s skew.
* **Detection pipeline**: batch → resolve token → check active session for the scanner's room → check enrolment → feed `StudentRuntime` (ring buffer of recent readings per scanner) → aggregate into per-minute windows in MongoDB (never store every packet).
* **Storage** (`store.ts`): collections `users`, `rooms`, `courses` (with `studentIds`), `scanners`, `sessions`, `attendance` (`_id = sessionId:userId`), `detection_windows`, `events`, `occupancy_samples`. Writes from the hot path are fire-and-forget and serialised per document; reads happen only on session start/end and snapshot building. `MONGODB_URI` unset → in-memory MongoDB for development.
* **Attendance engine** (`engine.ts`): a tick every 2 s per active session runs the state machine below, accumulates present/away seconds, late & leftEarly flags, confidence score, zone estimate, occupancy samples, timeline events.
* **Realtime hub**: any change marks the session dirty; a debounced (300 ms) full snapshot is broadcast to all WebSocket clients subscribed to that session. Snapshots are small (≤ a few hundred students) — simple and hard to get wrong under demo pressure.
* **iOS path**: `POST /api/v1/presence/ios` (bearer user token) is normalized into the same `PresenceEvidence` shape as an ESP32 detection.

### Dashboard (Vite / React / TS)
* Start / end class (normal or **demo mode** timings), live count, state breakdown, student list with arrival/last-seen/confidence, zone heatmap (front/back × left/right from scanner placements), occupancy sparkline, timeline bars, event feed, manual overrides, scanner health.

## Attendance state machine

```
 UNKNOWN ──first detection──▶ DETECTED ──≥N obs & ≥confirm s──▶ PRESENT
    ▲                           │                                 │
    └──no detection > grace─────┘                                 │ no detection > awayGrace
                                                                  ▼
                       PRESENT ◀──detected again (RETURNED)──── AWAY
                                                                  │ no detection > leftThreshold
                                                                  ▼
                       PRESENT ◀──detected again (RETURNED)──── LEFT
```

| Config key                    | Default (real) | Demo mode |
|-------------------------------|---------------:|----------:|
| `presentConfirmationSeconds`  | 60             | 6         |
| `minObservations`             | 3              | 2         |
| `awayGraceSeconds`            | 180            | 12        |
| `leftThresholdSeconds`        | 600            | 40        |
| `lateThresholdSeconds`        | 300            | 60        |
| `veryLateThresholdSeconds`    | 1200           | 180       |
| `regionStaleSeconds` (iOS bg) | 5400           | 3600      |

All thresholds are stored on the session document so a professor/admin can change policy without redeploying.

## Zones & heatmap
Each scanner has a `zone` label (`front-left`, `front-right`, `back-left`, `back-right`, or just `front`/`back`).
For each student every tick: average RSSI per scanner over the last 20 s → strongest scanner = candidate zone.
Switch zones only when ≥70 % of the last 10 candidates agree (prevents bouncing). Heatmap = count of PRESENT students per zone.
This is *approximate density*, never seat-level positioning — RSSI indoors is noisy (bodies, bags, orientation).

## Confidence (internal score → shown as High / Medium / Low)
```
duration     up to 40   presentSeconds / elapsedSessionSeconds
observations up to 25   observations / 30
scanners     5 / 10 / 15 for 1 / 2 / 3+ distinct scanners
signal       10 / 6 / 2  for maxRSSI > -60 / > -75 / else
continuity   10 − 3 × awayEpisodes (min 0)
```

## What this system does and does not prove
It verifies that the **registered device** is in the room during the active class. It cannot prove the human is.
Pitch it honestly as *device-presence-assisted attendance* and keep manual overrides (MARK PRESENT / ABSENT / EXCUSED, recorded with `modifiedBy`).

## Privacy story
Collected: temporary anonymous BLE identifiers, presence in an enrolled classroom, timestamps, approximate zone — only during an active class.
Not collected: names/IDs over the air, Bluetooth MAC addresses, GPS, internet traffic, messages.

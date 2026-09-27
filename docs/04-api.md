# 04 — HTTP / WebSocket API (base `/api/v1`)

All JSON. Times are unix **seconds** unless noted.

## Public
| Method | Path        | Body / Notes                                     |
|--------|-------------|--------------------------------------------------|
| GET    | `/health`   | `{ ok, now }`                                    |
| GET    | `/time`     | `{ now }` — used by ESP32 + phones for clock sync |

## Auth (users)
| Method | Path           | Body → Response |
|--------|----------------|-----------------|
| POST   | `/auth/login`  | `{ email, password, deviceId?, platform? }` → `{ token, user, secret? (students only), courses[] }` |
| GET    | `/me`          | bearer → `{ user, courses[] }` |
| GET    | `/me/status`   | bearer (student) → `{ activeSession?, attendance? }` for the app's "You're in class" screen |

Bearer tokens: `Authorization: Bearer <token>`.

## Scanners (ESP32) — signed
Headers: `x-scanner-id`, `x-timestamp` (unix s), `x-signature` = hex HMAC_SHA256(scannerSecret, `${timestamp}.${rawBody}`)

| Method | Path                    | Body → Response |
|--------|-------------------------|-----------------|
| POST   | `/detections`           | `{ detections: [{ token: hex16, rssi (avg), max?, n? (packets aggregated), ts? }] }` → `{ accepted, unknown, notEnrolled, users, active, sessionId, now }` |
| POST   | `/scanners/heartbeat`   | `{ wifiRssi?, uptime?, fw?, buffered?, ip? }` → `{ ok, now, active, sessionId, scanIntervalMs }` |

## Professor / admin — bearer (role professor|admin)
| Method | Path                                     | Body → Response |
|--------|------------------------------------------|-----------------|
| GET    | `/courses`                               | courses the professor teaches, with room + enrolment count |
| GET    | `/scanners`                              | all scanners with online flag |
| GET    | `/sessions/active`                       | active sessions |
| GET    | `/sessions?courseId=`                    | past sessions (history) |
| POST   | `/sessions/start`                        | `{ courseId, demo?: boolean, config?: Partial<Config>, durationMinutes? }` → session |
| POST   | `/sessions/:id/end`                      | → session summary |
| GET    | `/sessions/:id`                          | full snapshot (same shape as the WebSocket message) |
| GET    | `/sessions/:id/summary`                  | per-student totals, attendance %, late, leftEarly |
| POST   | `/sessions/:id/attendance/:userId/override` | `{ state: 'present'|'absent'|'excused'|null, note? }` (null clears override) |
| PATCH  | `/sessions/:id/config`                   | partial config update |

## iOS presence — bearer (student)
| POST | `/presence/ios` | `{ event?: 'range'|'enter'|'exit', major, minor?, proximity?, rssi? }` → `{ ok, sessionId, state, kind }`. `range` = on-screen reading; `enter`/`exit` = iOS background region events (major only); `stop` (no other fields) = student stopped detection / signed out → treated as leaving every class they are in. While a student is `regionInside`, silence is tolerated for `regionStaleSeconds` instead of `awayGraceSeconds`; `exit` marks away immediately. |

## WebSocket `/ws`
Client → server: `{ "type": "subscribe", "sessionId": "..." }` or `{ "type": "subscribe", "sessionId": "active" }`.
Server → client:
* `{ type: 'snapshot', snapshot }` — full state, debounced 300 ms after any change
* `{ type: 'scanners', scanners }` — on heartbeat changes
* `{ type: 'session_ended', sessionId }`

### Snapshot shape
```ts
{
  session: { id, courseId, courseCode, courseName, roomId, startedAt, scheduledEnd, endedAt, status, demo, config },
  counts: { enrolled, present, away, left, detected, absent, late, excused },
  students: [{ userId, name, studentNumber, platform, state, effectiveState, firstSeen, lastSeen, arrivalAt, departureAt,
               presentSeconds, awaySeconds, awayEpisodes, observations, late, veryLate, leftEarly, confidence, confidenceLabel,
               zone, scanners: [{ scannerId, zone, rssi, lastSeen }], manual: { state, by, at, note } | null }],
  zones: [{ zone, count }],
  scanners: [{ id, roomId, zone, online, lastHeartbeat, wifiRssi, fw, ip }],
  occupancy: [{ at, present, away }],
  events: [{ at, userId, name, type, data }]        // last 100
}
```

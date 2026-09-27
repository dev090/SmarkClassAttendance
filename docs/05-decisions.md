# 05 — Decisions log

| # | Decision | Why | Revisit when |
|---|----------|-----|--------------|
| D1 | **Self-hosted Node backend + MongoDB** (team choice; Atlas for persistence, `mongodb-memory-server` fallback for dev) instead of Firebase | Team already uses MongoDB/Atlas (Compass + mongosh installed). The engine keeps hot state in memory and writes behind (serialised per document), so a burst of BLE packets never waits on the database. Realtime is a 150-line WebSocket hub. | **Demo network:** Atlas needs internet. If the demo runs on a phone hotspot without internet, run a local `mongod` (`brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community`) and set `MONGODB_URI=mongodb://127.0.0.1:27017`. |
| D2 | **Token = HMAC(secret, minute)** with no session component | Phone doesn't need to know the active class; works even if the app is offline. Server precomputes tokens for w-1..w+1 for all students → O(1) lookup. | If student count > ~50k (precompute cost). |
| D3 | **Manufacturer data (0xFFFF + 'SC')** instead of a service UUID | Fits in 31 bytes with an 8-byte token; 0xFFFF is the SIG testing id; no risk of colliding with real services. | Never for hackathon. |
| D4 | **ESP32 syncs clock from the server**, not NTP | Hotspots often have no internet; server time is what matters for signatures anyway. | — |
| D5 | **Full-snapshot broadcasts** instead of per-field deltas | Snapshots are tiny; eliminates an entire class of dashboard desync bugs during a demo. | > 500 students per session. |
| D6 | **Hybrid iOS path (ESP32 iBeacon → iPhone)** | Apple hides backgrounded peripherals' service UUIDs from non-Apple scanners. Beacon region monitoring is the documented, supported way. | — |
| D7 | **Demo-mode timings** stored on the session | Judges won't wait 10 minutes for LEFT. Real classes use the real thresholds. | — |
| D8 | **Aggregate detections per minute** in MongoDB (`detection_windows`, `$inc` upserts); raw packets live only in a memory ring buffer; the ESP32 itself aggregates per token per 3 s flush | Hundreds of packets/minute/student would bloat the DB; the engine only needs recent readings. | — |
| D9 | **Attendance % thresholds are policy** (≥75 attended / 50–74 partial / <50 absent) | Configurable; the university sets policy, not the system. | — |
| D10 | **Arduino framework (C-style) for the ESP32**, sketch opens in Arduino IDE, PlatformIO wrapper for CLI builds | Team programs the ESP32 in C with the Arduino IDE. NimBLE-Arduino gives concurrent scan + iBeacon advertise. | ESP-IDF only if a feature needs it. |
| D11 | **Runtime config over serial → NVS** (`wifi`, `server`, `scanner`, `save`) | Four scanners with different ids/secrets and any hotspot can be configured without recompiling. | — |
| D12 | **BLE init before Wi-Fi, modem sleep on** | The Wi-Fi/BT coexistence module aborts (`coex_core_enable`) if Wi-Fi power save is off when BT starts — found and fixed on real hardware. | — |

# 02 — Milestones (build in this order, demo after every one)

Legend: ☐ todo · ◐ in progress · ☑ done

| #   | Milestone                                                                                   | Demo you can show                                   | Status |
|-----|---------------------------------------------------------------------------------------------|-----------------------------------------------------|:------:|
| M0  | Repo scaffold, docs, decisions                                                              | —                                                   | ☑ |
| M1  | Backend core: MongoDB collections + seed, auth, courses, sessions start/end, scanner HMAC auth, `/detections` ingest, token resolver | `curl` a detection → attendance row appears | ☑ |
| M2  | Attendance engine: state machine, present/away seconds, late, confidence, zones, events, occupancy | Snapshot JSON flips DETECTED → PRESENT → AWAY → LEFT | ☑ |
| M3  | Realtime hub + dashboard: login, start class (demo mode), live list, counts, heatmap, timeline, overrides, scanner health | Laptop shows live class | ☑ |
| M4  | Simulator: fake scanners + fake students, scripted scenario (arrive, move zones, leave, return) | Full end-to-end demo with **zero hardware**       | ☑ |
| M5  | ESP32 firmware: Wi-Fi, server time sync, NimBLE scan + filter, batch POST w/ HMAC (http or https), heartbeat, ring buffer, iBeacon, serial config console | Real ESP32 shows up as **online** in dashboard | ☑ flashed on the ESP32-D0WD-V3 (MAC 44:1d:64:e3:e0:14), boots + scans; **needs `wifi <ssid> <pass>` over serial** |
| M6  | Flutter app: login, token derivation, Android BLE advertising (foreground), status screen  | Real Android phone → real ESP32 → **Devansh PRESENT** | ◐ Flutter 3.47 installed on the Mac, iOS/Android projects generated, `flutter analyze` + tests clean; waiting on a physical phone (no Android phone in the team yet) |
| M7  | Android background: foreground service so advertising survives screen-off                  | Phone in pocket still counted                       | ☐ |
| M8  | iOS reverse-beacon path: ESP32 iBeacon → `flutter_beacon` ranging/monitoring → `/presence/ios` | **Demo phone (iPhone) shows PRESENT** | ☑ **verified end to end 2026-09-26**: iPhone 13 Pro Max → ESP32 beacon → `/presence/ios` via Cloudflare tunnel → dashboard shows Devansh PRESENT (front-left, -72 dBm). Background (screen-off) now uses per-room iOS region monitoring (enter/exit → `/presence/ios`), backend keeps locked phones present until exit (2026-09-27) |
| M9  | Multi-ESP32 in one room, tune zone smoothing with real RSSI                                | Heatmap moves when a person walks front → back      | ☐ |
| M10 | Analytics + history: past sessions, attendance %, arrival patterns, CSV export             | "Attendance rate 92 %, peak occupancy 10:17"        | ◐ summary view + CSV export + history done; arrival-pattern charts todo |
| M11 | Polish + demo script + pitch                                                                | 3 phones, 3 ESP32s, 1 laptop, judges walk in        | ☐ |

## Next hardware steps (ESP32 is flashed; beacon on; Wi-Fi not yet set)

The demo network turned out to be the hard part: campus Wi-Fi isolates clients, so phones reach the backend through `pnpm tunnel` (public https URL). The ESP32 can use that same URL (`server https://…trycloudflare.com`) once it is on any Wi-Fi with internet — reflash with the current firmware first (https support added 2026-09-26 late).
1. Put laptop + ESP32 on the same network (a phone hotspot is the reliable choice; campus Wi-Fi usually blocks device-to-device traffic).
2. Serial monitor (115200, newline): `wifi <ssid> <password>` → `save` → `reboot`. If the laptop IP changed: `server http://<new-ip>:4000` → `save`.
3. Dashboard → Scanners → **ITC317-A turns green** within 30 s (heartbeat). LED: slow blink = connected, solid = class active.
4. Flash the other boards with `scanner ITC317-B scanner-secret-ITC317-B` etc. over serial (same firmware binary).
5. Run `mobile/setup.sh` + `flutter run` on an Android phone, sign in as `devansh@unb.ca`, tap **Start broadcasting**.
6. Start class in demo mode → Devansh flips DETECTED → PRESENT within ~10 s. Serial `stats` shows `adv=` climbing.

## iPhone demo path (what happens on stage)
ESP32 advertises iBeacon `5C0A7A1D-…0001` major 317 minor 1 → iPhone app ranges it → `POST /presence/ios` every 3 s (bearer token) →
backend ingests it exactly like an ESP32 report (source `IOS_BEACON`) → dashboard shows the student DETECTED → PRESENT. Walking away stops the
posts → AWAY → LEFT; coming back → RETURNED. The Wi-Fi/ESP32→backend link is **not** needed for this path (only the phone needs to reach the backend).

## Demo-day script (M11)
Use the ESP32 **BOOT button** (or `pnpm esp32 range out|in`) to simulate a student walking out and back without moving.

Start class → 0/3 → person 1 walks in → DETECTED… → PRESENT → person 2 → 2/3 → heatmap front → one walks to the back → heatmap shifts →
one walks out → AWAY (30 s) → LEFT (90 s) → walks back → RETURNED → End class → summary (minutes present, late, attendance %).

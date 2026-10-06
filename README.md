# SmartClass — automatic, privacy-first classroom attendance

Students walk into class with their phone in their pocket; the professor's dashboard shows them **present** within
seconds, **away** when they step out, **returned** when they're back. No QR codes, no check-ins, no app to open.

```
                 Bluetooth (10 m)                    internet
 Android phone ──rotating code──▶  ESP32 board  ──────────────▶ ┐
 iPhone        ◀──"room 317"────── (Bluetooth room sign)        │   Backend (Node + MongoDB)
     └──────────── "I'm next to room 317" ──────────────────────┘        │ live WebSocket
                                                                 Professor dashboard (web)
```

* The **ESP32** is a Bluetooth "room sign" and sensor. It never decides anything.
* The **backend** turns codes into students, applies the rules (present / away / left / late) and stores everything in MongoDB.
* The **dashboard** shows the live class, a seat heatmap, timeline, summary and CSV export.
* Nothing personal goes over Bluetooth: no names, no IDs, no tracking of where anyone goes.

---

## 1. What you need

| For | Install |
|-----|---------|
| Backend + dashboard | Node 26+, pnpm (`npm i -g pnpm`) |
| Database | A MongoDB Atlas URI (free tier). Without one the backend starts an in-memory DB (data lost on restart). |
| Phones on any network | `brew install cloudflared` (free, no account) |
| iPhone app | macOS with Xcode, Flutter SDK (`brew install --cask flutter`), CocoaPods, an Apple ID signed into Xcode |
| ESP32 board | Arduino IDE with the *esp32* board package and the *NimBLE-Arduino* library |
| Board helper (optional) | Python 3 + `pip3 install pyserial` |

---

## 2. Run the server and dashboard (laptop)

```bash
git clone <repo> && cd HackathonBT
pnpm install
cp backend/.env.example backend/.env      # paste MONGODB_URI=… (Atlas) — or leave it empty for the in-memory DB
pnpm dev                                  # backend on :4000, dashboard on :5173
```

Open **http://localhost:5173** and sign in as `prof@unb.ca` / `password`.

Atlas note: in Atlas → *Network Access* add your IP (or `0.0.0.0/0` for the hackathon), otherwise the backend fails with a
TLS "internal error".

### Give the backend a public address (needed for phones)

Phones on cellular or campus Wi-Fi cannot reach your laptop directly. In a second terminal:

```bash
pnpm tunnel        # prints  https://<random-words>.trycloudflare.com  and writes it into the app's default
```

That URL is the **Server URL** for the phone app and the ESP32. It changes every time the tunnel restarts, and the
tunnel dies whenever the laptop changes network — just run `pnpm tunnel` again. The helper writes the new address into
`mobile/lib/core/app_config.dart` (rebuild the app to get it prefilled), or type it into the app's sign-in screen.

---

## 3. Try it with no hardware at all

```bash
pnpm sim           # 5 fake students walk into room ITC 317, a demo class starts by itself
```

Watch the dashboard: students appear, one moves to the back, one leaves and returns. `pnpm sim -- --scenario chaos` for churn.

---

## 4. The ESP32 board

**Flash once** (Arduino IDE): open `firmware/SmartClassScanner/SmartClassScanner.ino`. Board *ESP32 Dev Module*,
Partition Scheme *Huge APP (3MB No OTA)*, Upload Speed *460800*, Port `/dev/cu.usbserial-*`. Upload.

**Configure over the serial console** (Arduino Serial Monitor at 115200, "Newline" line ending), or with
`pnpm esp32 <command>` from the laptop:

```
beacon 317 1        # which room this board is (317 = SWE 4203's room, 120 = CS 3503's room)
server https://<your-tunnel>.trycloudflare.com
scanner ITC317-A scanner-secret-ITC317-A
wifi <hotspot-name> <password>   # only needed for Android phones / the "online" dot on the dashboard
save
reboot
```

`stats` and `show` print the board's state. LED: fast blink = no Wi-Fi (fine for iPhone demos), slow blink = online, solid =
class running, off = simulated "out of range".

**Simulate walking out** without moving: press the **BOOT** button on the board (or `pnpm esp32 range out`). Press again
(or `pnpm esp32 range in`) to come back.

For the iPhone path the board needs **only power** — any USB charger works.

---

## 5. The iPhone app

1. `cd mobile && ./setup.sh` (first time only: generates the iOS project). Then `open ios/Runner.xcworkspace`.
2. In Xcode: Runner target → *Signing & Capabilities* → pick your team. Product → Scheme → Edit Scheme → Run → untick
   **Debug executable** (otherwise the first launch can stall for minutes).
3. Plug in the iPhone (Developer Mode on, "Trust this computer"), select it in the toolbar, press **▶ Run**.
4. On the phone: the Server URL is prefilled; sign in as a student (`devansh@unb.ca` / `password`).
5. A card will block the app until the required settings are granted: Location **Always** (so a locked phone is still
   counted), Bluetooth on. Follow the buttons; the app re-checks when you come back from Settings.

Seeded students (password `password`): devansh, arsh, param, john, sarah, maya, liam, zoe — all `@unb.ca`.

Android phones: `flutter run` on the phone; the app broadcasts to the board instead of listening (the board needs Wi-Fi for this).

---

## 6. Demo script (2 minutes)

1. Dashboard → **Start class** on SWE 4203 (leave *Demo mode* on: present after 6 s, away after 12 s, left after 40 s).
   Make sure the board is set to that class's room (`beacon 317 1`); with a single class running the server also
   accepts the board whatever room it says.
2. Open the app once on the phone, then lock it and put it in your pocket. Dashboard: **Present**, front zone.
3. Press **BOOT** on the board (= you left the room). Dashboard: **Away** in ~5–10 s, **Left** 40 s later.
4. Press **BOOT** again. Dashboard: **Returned / Present** in a few seconds — phone still locked.
5. Click the student's row: arrival time, minutes present, confidence, scanners heard, manual overrides.
6. **End class**: attendance %, late arrivals, early departures, peak occupancy, **Export CSV**.

---

## 7. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Backend: `tlsv1 alert internal error` | Atlas → Network Access → allow your IP / `0.0.0.0/0` |
| App: "Could not reach the server" | Tunnel restarted → new URL; update `mobile/lib/core/app_config.dart` and rebuild |
| Xcode: "Launching Runner is taking longer than expected" | Click *Stop* and tap the app icon on the phone, or untick *Debug executable* in the Run scheme |
| Xcode: "Build Succeeded" but nothing on the phone | The destination was *Any iOS Device*; select the phone |
| Xcode build hangs at the Flutter step | A stray Flutter process holds the lock: `pkill -f dartvm` |
| Student never appears | Board room ≠ class room (`pnpm esp32 beacon 317 1`), or the phone's Location isn't *Always* |
| Board not found on USB | `ls /dev/cu.usbserial*` — the name changes with the USB port |
| Disk full during iOS builds | Xcode keeps ~6–11 GB of symbols per iPhone model in `~/Library/Developer/Xcode/iOS DeviceSupport` |

Where to look: the backend log prints every phone's own status line (`grep 'app beacon status'`) and every presence event.

---

## 8. Repo layout

| Folder | What |
|--------|------|
| `backend/` | Fastify API, token resolver, attendance engine, WebSocket hub, MongoDB store (`pnpm test` runs the engine tests) |
| `dashboard/` | React dashboard (Vite) |
| `simulator/` | Fake scanners + phones |
| `firmware/` | ESP32 sketch (`SmartClassScanner/`), `esp32ctl.py`, PlatformIO wrapper |
| `mobile/` | Flutter app (iOS beacon path, Android broadcast path, requirements gate) |
| `docs/` | Architecture, BLE protocol, API, milestones, decisions |

Useful scripts (repo root): `pnpm dev`, `pnpm sim`, `pnpm tunnel`, `pnpm esp32 …`, `pnpm test`, `pnpm build && pnpm start`
(serves the built dashboard from the backend on :4000).

## 9. Honest limits / next steps

* The system verifies a **device** is in the room, not a person; professors keep manual overrides.
* Android background broadcasting (foreground service) and the ESP32-on-Wi-Fi path are written but not yet field-tested.
* The backend runs on a laptop behind a temporary tunnel; deploying it to a cloud host gives a fixed address.

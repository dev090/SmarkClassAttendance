# SmartClass student app (Flutter)

Logs in once, receives a per-device secret, and broadcasts a rotating anonymous BLE token that the
classroom ESP32s hear. Shows "You're in class" once the backend confirms presence.

## Setup (once)
```bash
cd mobile
./setup.sh          # flutter create . + permission patches + pub get
flutter run         # Android phone with USB debugging on, or an iPhone (see iOS notes)
```

### iOS notes
* Xcode needs the iOS device platform: `xcodebuild -downloadPlatform iOS` (or Xcode → Settings → Components). Without it builds fail with
  *"iOS 26.5 is not installed"*.
* Xcode must be signed in to an Apple ID (Xcode → Settings → Accounts). A free personal team works for running on your own iPhone
  (the app expires after 7 days; re-run `flutter run`). Set the team once: `open ios/Runner.xcworkspace` → Runner target → Signing & Capabilities.
* iPhone: Settings → Privacy & Security → **Developer Mode** on; plug in via USB and tap *Trust*.
* The ESP32 must be advertising its iBeacon (`beacon 317 1` + `save` over serial, or automatically after its first heartbeat).
The **Server URL** is prefilled from `lib/core/app_config.dart` (currently the Cloudflare tunnel URL; change it there or pass `--dart-define=SMARTCLASS_SERVER=https://…` when building). A LAN address like `http://10.9.216.203:4000` also works when phone and laptop share a Wi-Fi
and sign in as a seeded student (`devansh@unb.ca` / `password`). Tap **Start broadcasting** if it did not start by itself.

## How it works
* `lib/core/token.dart` — `token = HMAC_SHA256(secret, "smartclass:v1:" + floor(unix/60))[0..8]`, same as backend + firmware.
* `lib/core/ble_broadcaster.dart` — advertises manufacturer data `FFFF 'S' 'C' 01 token[8] flags` at ~100 ms interval, non-connectable,
  no device name; re-advertises at each minute boundary using the server clock offset captured at login.
* `lib/core/api.dart` — `/auth/login` (sends a stable per-install `deviceId`; a second phone rotates the secret), `/me/status` every 5 s.
* `lib/core/beacon_presence.dart` — **iPhone path**: iOS cannot advertise manufacturer data and hides backgrounded peripherals from
  non-Apple scanners, so the app ranges the classroom iBeacon (`5C0A7A1D-…0001`, major = room, minor = scanner) with `flutter_beacon`
  and POSTs `/api/v1/presence/ios` every 3 s while in range. The backend turns that into the same evidence as an ESP32 report.

## Roadmap
* M7 — Android foreground service (`flutter_foreground_task`) so advertising survives screen-off / app in background.
* M8 — iOS path: done in foreground; background delivery relies on iOS region monitoring (enter/exit) which is coarser than ranging.

## Troubleshooting
* **Login fails with "Could not reach the server"** — phone and laptop must be on the same Wi-Fi/hotspot; `usesCleartextTraffic` is
  enabled by the patch script because the backend is plain HTTP on the LAN.
* **Advertising fails on Android 12+** — grant "Nearby devices" permission (BLUETOOTH_ADVERTISE).
* **ESP32 hears nothing** — check its serial `stats` output: `adv=` should climb while the phone broadcasts.

### Xcode tips learned the hard way
* **"Launching Runner is taking longer than expected"** = LLDB downloading symbols from the phone (the Mac's
  `~/Library/Developer/Xcode/iOS DeviceSupport` cache is missing). Click *Stop* and tap the app icon on the phone, or
  Product → Scheme → Edit Scheme → Run → untick **Debug executable** so ▶ Run installs and launches without LLDB.
* A "Build Succeeded" with nothing on the phone usually means the destination was *Any iOS Device* (build only): pick the phone.
* Killed `flutter` commands can leave orphan `dartvm` processes holding the Flutter lock; Xcode's Flutter step then hangs.
  `pkill -f dartvm` fixes it.

### Beacon listener behaviour (iOS)
The `flutter_beacon` permission/Bluetooth getters only answer when the state *changes*, so they are queried once; after that the app
re-subscribes to ranging directly (on resume, or when no ranging callback arrived for 15 s). The app sends its own status line to the
backend with every `/me/status` poll; on the laptop `grep 'app beacon status' backend.log` shows exactly what each phone sees.

### Requirements gate (`lib/core/requirements.dart`, `lib/features/requirements_gate.dart`)
After sign-in the app is blocked behind a full-screen card until everything it truly needs is granted, each explained in
plain words with a button that requests it or opens Settings:
* Location Services on (device-wide) · location permission for the app · **"Always"** on iOS (so a locked phone is marked
  present/away without opening the app) · Bluetooth on · Bluetooth allowed for the app · Android "Nearby devices".
The check re-runs when the app returns from Settings and when iOS reports a permission/Bluetooth change. Detection only
starts once the gate is satisfied. To see the dialogs: Settings → SmartClass → Location → "While Using" (Always prompt),
or switch Bluetooth off in Settings (hard block).

### How fast is "Away"?
* App alive (on screen, or in the background thanks to the keep-alive below): the app reports "lost the beacon" after 3
  consecutive empty scans (~3 s); the server marks Away immediately → **about 3–6 s** after the signal is really gone.
* Fallbacks: server silence timer (12 s in demo mode) and iOS's own region exit (~30 s) if the app was killed.
* `ios/Runner/AppDelegate.swift` keeps the app alive in the background with a 3 km-accuracy location subscription
  (never stored or used) so ranging continues with the screen off. Needs Location "Always" (the gate enforces it).

### Getting the "Always" location prompt on iOS
iOS never offers Always in the first prompt, and if an app asks for Always right away iOS grants a silent *provisional*
Always and postpones the real prompt. So the app (via `ios/Runner/AppDelegate.swift`, channel `smartclass/location`) asks in
two explicit steps: "While Using" first, then — from the gate's **Allow Always** button — Always, which makes iOS show
"Change to Always Allow?" immediately. iOS shows that upgrade prompt once per install; after that the gate sends the user to
Settings → SmartClass → Location → Always. To re-test from scratch, delete the app from the phone (resets permissions).

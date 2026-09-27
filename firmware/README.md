# SmartClass scanner firmware (ESP32)

Board: **ESP32 Dev Module** (ESP32-D0WD / WROOM-32D, CH340 USB-serial). Language: C-style Arduino.

## Arduino IDE (recommended for the team)
1. **Boards Manager** → install *esp32 by Espressif Systems*.
2. **Library Manager** → install *NimBLE-Arduino* (2.x, by h2zero).
3. Open `SmartClassScanner/SmartClassScanner.ino`.
4. Tools → Board: *ESP32 Dev Module* · Partition Scheme: *Huge APP (3MB No OTA/1MB SPIFFS)* · Upload Speed: *921600* (use 115200 if uploads fail) · Port: `/dev/cu.usbserial-XXXX`.
5. Upload. If the IDE says *"Failed to connect… Wrong boot mode"*, hold the **BOOT** button on the board while it says *Connecting…*.
6. Open **Serial Monitor** at **115200**, set *Newline* line ending, and configure the scanner:
   ```
   wifi MyHotspot mypassword
   server http://192.168.1.23:4000
   scanner ITC317-A scanner-secret-ITC317-A
   save
   reboot
   ```
   The server URL is the LAN address the backend prints at startup, **or** the public tunnel URL from `pnpm tunnel` (https works; certificates are not pinned). Scanner ids and secrets come from the backend seed (`ITC317-A` … `ITC317-D`, secret `scanner-secret-<id>`).

Serial commands: `help`, `show`, `stats`, `wifi`, `server`, `scanner`, `beacon <major> <minor>`, `active <0|1>`, `save`, `reboot`, `clear`.

The port name depends on which USB socket you use (`/dev/cu.usbserial-110`, `/dev/cu.usbserial-10`, …); `ls /dev/cu.usbserial*` shows it.
Current board state (2026-09-26): flashed, `server http://10.9.216.203:4000`, `scanner ITC317-A`, `beacon 317 1` saved; Wi-Fi not yet set.

LED: fast blink = no Wi-Fi · slow blink = connected, no class · solid = class active.

## PlatformIO (CLI, same sketch)
```bash
pio run                       # compile
pio run -t upload             # flash (auto-detects /dev/cu.usbserial-*)
pio device monitor            # serial console at 115200
```

## What the firmware does
* Passive continuous BLE scan; keeps only frames whose manufacturer data is `FF FF 'S' 'C' 01 <token:8> <flags:1>`.
* Aggregates per token (packets, avg & max RSSI) and POSTs a signed batch every 3 s (`X-Scanner-Id`, `X-Timestamp`, `X-Signature = HMAC-SHA256(secret, ts + "." + body)`).
* Heartbeat every 30 s; clock is synced from the server (`GET /api/v1/time`), so no NTP/internet needed.
* Offline ring buffer (600 entries) replays when the server is reachable again.
* Advertises the SmartClass iBeacon (major = room, minor = scanner index, assigned by the backend) so iPhones can detect the room.

## Simulating "walked out of the room" (demo helper)
Press the **BOOT** button on the board (next to the USB port): the beacon stops and heard phones are no longer reported, exactly
as if the room were out of range. Press again to come back. The blue LED is off while "out". From the laptop:
```bash
pnpm esp32 range out      # or: range in | range toggle | stats | beacon 317 1 | wifi <ssid> <pw> | save
```
(`pnpm esp32` = `python3 firmware/esp32ctl.py`, needs `pip3 install pyserial`.)

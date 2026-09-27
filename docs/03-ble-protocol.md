# 03 — BLE protocol

## Android → ESP32 (advertising)

Non-connectable, no device name, one Manufacturer Specific Data AD structure:

```
Company ID   0xFFFF        (Bluetooth SIG reserved for testing/prototyping)
Magic        'S' 'C'       0x53 0x43
Version      0x01
Token        8 bytes       HMAC_SHA256(secret, "smartclass:v1:" + window)[0..8]
Flags        1 byte        bit0 = charging, bit1 = app in foreground, others reserved
```
Total AD payload: 2 + 2 + 1 + 8 + 1 = 14 bytes (+2 header) — fits comfortably in the 31-byte legacy advertisement with Flags.

`window = floor(unix_seconds / 60)`. The phone re-starts advertising with the new token at each minute boundary
(it syncs its clock offset from `GET /api/v1/time` at login). The backend accepts windows `w-1, w, w+1`.

Why manufacturer data and not a service UUID? A 128-bit UUID costs 18 bytes and would not leave room for the token;
16-bit UUIDs are SIG-assigned. `0xFFFF` + magic bytes filters just as well on the ESP32.

## Replay resistance
A captured token is valid for at most ~3 minutes. The server also rejects a token seen simultaneously from two
rooms (flag `duplicate_room` in events) — cheap and good enough for a hackathon.

## ESP32 → iPhone (iBeacon, iOS path)
```
UUID    5C0A7A1D-5C1A-4C1A-B1E5-000000000001   (SmartClass fixed)
Major   room number (e.g. 317)
Minor   scanner index in room (1..4)
TxPower -59
```
The iOS app registers a `CLBeaconRegion` for the UUID; on enter/ranging it POSTs `/api/v1/presence/ios`
with `{ major, minor, proximity, rssi }` and its bearer token. The backend maps `major/minor → scannerId`.

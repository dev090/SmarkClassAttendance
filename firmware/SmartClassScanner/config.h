// Compile-time defaults. Anything set over the serial console (`wifi`, `server`, `scanner`, then `save`)
// is stored in NVS and overrides these. Safe to leave the Wi-Fi fields empty and configure over serial.
#pragma once

#define DEFAULT_WIFI_SSID        ""
#define DEFAULT_WIFI_PASS        ""
#define DEFAULT_SERVER_URL       "http://192.168.1.23:4000"   // laptop LAN IP printed by the backend at startup
#define DEFAULT_SCANNER_ID       "ITC317-A"
#define DEFAULT_SCANNER_SECRET   "scanner-secret-ITC317-A"    // must match backend seed (scanners collection)

// SmartClass iBeacon (iOS reverse path). Major/minor are assigned by the backend via heartbeat.
#define BEACON_UUID              "5C0A7A1D-5C1A-4C1A-B1E5-000000000001"
#define BEACON_TX_POWER          -59

// Timings
#define FLUSH_INTERVAL_MS        3000    // backend may adjust via heartbeat response
#define HEARTBEAT_INTERVAL_MS    30000
#define WIFI_CONNECT_TIMEOUT_MS  12000
#define WIFI_RETRY_MS            10000
#define HTTP_TIMEOUT_MS          8000    // TLS handshakes over a hotspot need the headroom
#define BATCH_MAX                60      // max aggregated entries per POST

// BLE scan: units of 0.625 ms; window == interval means the radio listens continuously
#define SCAN_INTERVAL_UNITS      80      // 50 ms
#define SCAN_WINDOW_UNITS        80

// Board
#define LED_PIN                  2       // built-in LED on most ESP32 dev modules
#define BOOT_BUTTON_PIN          0       // BOOT button: press = simulate "out of range" (beacon off, no reports), press again = back

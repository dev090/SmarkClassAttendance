/*
 * SmartClass scanner firmware — ESP32 (ESP32-D0WD "ESP32 Dev Module")
 *
 * The ESP32 is a SENSOR, not a decision maker:
 *   1. passively scans BLE advertisements
 *   2. keeps only SmartClass frames: manufacturer data  FF FF 'S' 'C' 01 <token:8> <flags:1>
 *   3. aggregates per token (count, avg/max RSSI) and POSTs a signed batch to the backend every few seconds
 *   4. sends a heartbeat every 30 s and syncs its clock from the server (works on a hotspot with no internet)
 *   5. optionally advertises an iBeacon so iPhones can detect the room (iOS reverse path)
 *   6. buffers batches while Wi-Fi/server are unreachable and replays them later
 *
 * Runtime configuration lives in NVS and is set over the serial console (115200 baud), e.g.
 *   wifi MyHotspot mypassword
 *   server http://192.168.1.23:4000
 *   scanner ITC317-A scanner-secret-ITC317-A
 *   save
 *   reboot
 * Type `help` for all commands. Compile-time defaults are in config.h.
 *
 * Arduino IDE: Boards Manager -> "esp32 by Espressif Systems"; Library Manager -> "NimBLE-Arduino" (2.x).
 *   Board: ESP32 Dev Module, Partition Scheme: Huge APP (3MB No OTA), Upload Speed: 921600 (115200 if flaky).
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <NimBLEDevice.h>
#include "mbedtls/md.h"
#include "config.h"

#ifndef FW_VERSION
#define FW_VERSION "0.1.0"
#endif

// ------------------------------------------------------------------ runtime config (NVS)
struct Config {
  char ssid[64];
  char pass[64];
  char server[128];   // e.g. http://192.168.1.23:4000  (no trailing slash)
  char scannerId[32]; // e.g. ITC317-A
  char secret[96];    // shared with the backend's scanners collection
  uint16_t beaconMajor;
  uint16_t beaconMinor;
  uint8_t activeScan;  // 0 = passive (default), 1 = active
};
static Config cfg;
static Preferences prefs;

// ------------------------------------------------------------------ detections: per-token aggregate for the current flush
struct Agg {
  uint8_t token[8];
  int32_t rssiSum;
  int8_t rssiMax;
  uint16_t n;
  uint32_t lastTs;
};
#define AGG_MAX 64
static Agg agg[AGG_MAX];
static volatile uint8_t aggCount = 0;
static volatile uint32_t droppedAdv = 0;
static volatile uint32_t totalAdv = 0;
static portMUX_TYPE aggMux = portMUX_INITIALIZER_UNLOCKED;

// offline ring buffer of aggregated entries (survives Wi-Fi drops, not reboots)
struct Pending {
  uint8_t token[8];
  int8_t rssiAvg;
  int8_t rssiMax;
  uint16_t n;
  uint32_t ts;
};
#define PENDING_MAX 600
static Pending pending[PENDING_MAX];
static uint16_t pendingHead = 0;  // next write
static uint16_t pendingCount = 0;

// ------------------------------------------------------------------ state
static int64_t clockOffsetMs = 0;  // serverUnixMs - millis()
static bool clockSynced = false;
static bool sessionActive = false;
static uint32_t flushIntervalMs = FLUSH_INTERVAL_MS;
static uint32_t heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
static uint32_t lastFlush = 0, lastHeartbeat = 0, lastWifiAttempt = 0, lastLed = 0, lastStats = 0;
static uint32_t postOk = 0, postFail = 0;
static bool beaconRunning = false;
static bool rangeSimOut = false;   // demo helper: pretend the room is out of range (BOOT button / `range out`)
static uint32_t lastButtonChange = 0;
static bool lastButtonState = true; // pulled up = not pressed
static NimBLEScan* pScan = nullptr;
static WiFiClient plainClient;
static WiFiClientSecure secureClient;  // used when the server URL is https:// (e.g. a Cloudflare tunnel)

// ------------------------------------------------------------------ prototypes (Arduino IDE generates these, PlatformIO needs them)
void loadConfig();
void saveConfig();
void printConfig();
void handleSerial();
void handleCommand(char* line);
void ensureWifi();
void startScan();
void startBeacon();
void stopBeacon();
void setRangeSim(bool out);
void handleButton();
uint32_t nowUnix();
bool syncTime();
void flushDetections();
bool postJson(const char* path, const String& body, String& response, int& httpCode);
bool beginHttp(HTTPClient& http, const String& url);
void hmacSha256Hex(const char* key, const char* msg, size_t msgLen, char out[65]);
void hexEncode(const uint8_t* in, size_t n, char* out);
bool jsonBool(const String& json, const char* key, bool defaultValue);
long jsonLong(const String& json, const char* key, long defaultValue);
void pushPending(const Agg& a);
void sendHeartbeat();
void updateLed();

// ------------------------------------------------------------------ BLE scan callback (runs on the NimBLE host task)
class ScanCallbacks : public NimBLEScanCallbacks {
  void onResult(const NimBLEAdvertisedDevice* dev) override {
    if (!dev->haveManufacturerData()) return;
    std::string md = dev->getManufacturerData();
    if (md.size() < 14) return;
    const uint8_t* p = (const uint8_t*)md.data();
    // company id 0xFFFF (little endian FF FF), magic 'S' 'C', version 1
    if (p[0] != 0xFF || p[1] != 0xFF || p[2] != 'S' || p[3] != 'C' || p[4] != 0x01) return;
    const uint8_t* token = p + 5;
    int rssi = dev->getRSSI();
    uint32_t ts = nowUnix();

    portENTER_CRITICAL(&aggMux);
    totalAdv++;
    int idx = -1;
    for (int i = 0; i < aggCount; i++) {
      if (memcmp(agg[i].token, token, 8) == 0) { idx = i; break; }
    }
    if (idx < 0) {
      if (aggCount < AGG_MAX) {
        idx = aggCount++;
        memcpy(agg[idx].token, token, 8);
        agg[idx].rssiSum = 0;
        agg[idx].rssiMax = -127;
        agg[idx].n = 0;
      } else {
        droppedAdv++;
      }
    }
    if (idx >= 0) {
      agg[idx].rssiSum += rssi;
      if (rssi > agg[idx].rssiMax) agg[idx].rssiMax = (int8_t)rssi;
      agg[idx].n++;
      agg[idx].lastTs = ts;
    }
    portEXIT_CRITICAL(&aggMux);
  }

  void onScanEnd(const NimBLEScanResults& results, int reason) override {
    // continuous scan ended (e.g. after BLE stack restart) — start again
    if (pScan) pScan->start(0, false, true);
  }
};
static ScanCallbacks scanCallbacks;

// ------------------------------------------------------------------ setup / loop
void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);
  Serial.println();
  Serial.println("SmartClass scanner " FW_VERSION " (ESP32, NimBLE)");
  loadConfig();
  printConfig();
  Serial.println("Type `help` for serial commands.");

  // BLE first, Wi-Fi second. Wi-Fi modem sleep must stay ENABLED (the default): the Wi-Fi/BT
  // coexistence module aborts in coex_core_enable() if power save is off while BT starts.
  NimBLEDevice::init("");
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);
  startScan();
  if (cfg.beaconMajor && cfg.beaconMinor) startBeacon();

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true);
  ensureWifi();
}

void loop() {
  handleSerial();
  handleButton();
  ensureWifi();
  uint32_t now = millis();

  if (WiFi.status() == WL_CONNECTED) {
    if (!clockSynced) syncTime();
    if (now - lastHeartbeat >= heartbeatIntervalMs || lastHeartbeat == 0) {
      lastHeartbeat = now;
      sendHeartbeat();
    }
    if (now - lastFlush >= flushIntervalMs) {
      lastFlush = now;
      flushDetections();
    }
  } else if (now - lastFlush >= flushIntervalMs) {
    // offline: move the current aggregate into the pending buffer so nothing is lost
    lastFlush = now;
    portENTER_CRITICAL(&aggMux);
    for (int i = 0; i < aggCount; i++) pushPending(agg[i]);
    aggCount = 0;
    portEXIT_CRITICAL(&aggMux);
  }

  if (now - lastStats >= 10000) {
    lastStats = now;
    Serial.printf("[stat] wifi=%s rssi=%d ip=%s session=%s adv=%lu pending=%u ok=%lu fail=%lu heap=%u\n",
                  WiFi.status() == WL_CONNECTED ? "up" : "down", WiFi.RSSI(), WiFi.localIP().toString().c_str(),
                  sessionActive ? "ACTIVE" : "none", (unsigned long)totalAdv, pendingCount, (unsigned long)postOk,
                  (unsigned long)postFail, ESP.getFreeHeap());
  }
  updateLed();
  delay(5);
}

// ------------------------------------------------------------------ Wi-Fi
void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (strlen(cfg.ssid) == 0) return;
  uint32_t now = millis();
  if (lastWifiAttempt != 0 && now - lastWifiAttempt < WIFI_RETRY_MS) return;
  lastWifiAttempt = now;
  Serial.printf("[wifi] connecting to \"%s\"...\n", cfg.ssid);
  WiFi.disconnect();
  WiFi.begin(cfg.ssid, cfg.pass);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(100);
    handleSerial();
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected, ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    clockSynced = false;
    lastHeartbeat = 0;
  } else {
    Serial.println("[wifi] failed, will retry");
  }
}

// ------------------------------------------------------------------ BLE
void startScan() {
  pScan = NimBLEDevice::getScan();
  pScan->setScanCallbacks(&scanCallbacks, true);  // true = report duplicates (every packet)
  pScan->setActiveScan(cfg.activeScan == 1);
  pScan->setDuplicateFilter(false);
  pScan->setMaxResults(0);       // don't store results, we consume them in the callback
  pScan->setInterval(SCAN_INTERVAL_UNITS);
  pScan->setWindow(SCAN_WINDOW_UNITS);
  pScan->start(0, false, true);  // 0 = forever
  Serial.printf("[ble] scanning (%s)\n", cfg.activeScan ? "active" : "passive");
}

/** Advertises an Apple iBeacon frame in parallel with scanning (for the iOS reverse-beacon path). */
void startBeacon() {
  uint8_t frame[25];
  frame[0] = 0x4C; frame[1] = 0x00;  // Apple company id (little endian)
  frame[2] = 0x02; frame[3] = 0x15;  // iBeacon type + length
  // UUID bytes of BEACON_UUID
  const char* u = BEACON_UUID;
  int bi = 4;
  for (int i = 0; u[i] && bi < 20; i++) {
    if (u[i] == '-') continue;
    char hex[3] = { u[i], u[i + 1], 0 };
    frame[bi++] = (uint8_t)strtol(hex, nullptr, 16);
    i++;
  }
  frame[20] = cfg.beaconMajor >> 8; frame[21] = cfg.beaconMajor & 0xFF;
  frame[22] = cfg.beaconMinor >> 8; frame[23] = cfg.beaconMinor & 0xFF;
  frame[24] = (uint8_t)BEACON_TX_POWER;

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->stop();
  NimBLEAdvertisementData data;
  data.setFlags(BLE_HS_ADV_F_BREDR_UNSUP);
  data.setManufacturerData(frame, sizeof(frame));
  adv->setAdvertisementData(data);
  adv->setConnectableMode(BLE_GAP_CONN_MODE_NON);
  adv->enableScanResponse(false);
  adv->setMinInterval(160);  // 100 ms
  adv->setMaxInterval(320);  // 200 ms
  beaconRunning = adv->start();
  Serial.printf("[ble] iBeacon %s major=%u minor=%u -> %s\n", BEACON_UUID, cfg.beaconMajor, cfg.beaconMinor, beaconRunning ? "on" : "FAILED");
}

void stopBeacon() {
  NimBLEDevice::getAdvertising()->stop();
  beaconRunning = false;
}

// ------------------------------------------------------------------ time
uint32_t nowUnix() {
  if (!clockSynced) return 0;
  return (uint32_t)(((int64_t)millis() + clockOffsetMs) / 1000);
}

bool syncTime() {
  if (strlen(cfg.server) == 0) return false;
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  String url = String(cfg.server) + "/api/v1/time";
  if (!beginHttp(http, url)) return false;
  int code = http.GET();
  String body = code > 0 ? http.getString() : "";
  http.end();
  if (code != 200) {
    Serial.printf("[time] sync failed (%d) %s\n", code, url.c_str());
    return false;
  }
  long serverNow = jsonLong(body, "\"now\"", 0);
  if (serverNow <= 0) return false;
  clockOffsetMs = (int64_t)serverNow * 1000 - (int64_t)millis();
  clockSynced = true;
  Serial.printf("[time] synced, unix=%lu\n", (unsigned long)nowUnix());
  return true;
}

// ------------------------------------------------------------------ backend I/O
void flushDetections() {
  // snapshot + reset the aggregate under the lock, then work outside it
  Agg local[AGG_MAX];
  uint8_t n;
  portENTER_CRITICAL(&aggMux);
  n = aggCount;
  memcpy(local, agg, sizeof(Agg) * n);
  aggCount = 0;
  portEXIT_CRITICAL(&aggMux);
  if (rangeSimOut) return;  // "out of range": phones we hear are not reported
  for (int i = 0; i < n; i++) pushPending(local[i]);
  if (pendingCount == 0) return;
  if (!clockSynced && !syncTime()) return;

  // drain up to BATCH_MAX pending entries (oldest first)
  uint16_t take = pendingCount < BATCH_MAX ? pendingCount : BATCH_MAX;
  uint16_t start = (pendingHead + PENDING_MAX - pendingCount) % PENDING_MAX;
  String body;
  body.reserve(40 + take * 80);
  body += "{\"detections\":[";
  char tok[17];
  for (uint16_t i = 0; i < take; i++) {
    const Pending& p = pending[(start + i) % PENDING_MAX];
    hexEncode(p.token, 8, tok);
    if (i) body += ',';
    body += "{\"token\":\"";
    body += tok;
    body += "\",\"rssi\":";
    body += (int)p.rssiAvg;
    body += ",\"max\":";
    body += (int)p.rssiMax;
    body += ",\"n\":";
    body += (int)p.n;
    body += ",\"ts\":";
    body += (unsigned long)p.ts;
    body += '}';
  }
  body += "]}";

  String resp;
  int code;
  if (postJson("/api/v1/detections", body, resp, code) && code == 200) {
    pendingCount -= take;
    postOk++;
    bool active = jsonBool(resp, "\"active\"", sessionActive);
    if (active != sessionActive) {
      sessionActive = active;
      Serial.printf("[session] %s\n", active ? "ACTIVE" : "none");
    }
    long serverNow = jsonLong(resp, "\"now\"", 0);
    if (serverNow > 0) clockOffsetMs = (int64_t)serverNow * 1000 - (int64_t)millis();
    Serial.printf("[flush] %u tokens sent, accepted=%ld unknown=%ld, pending=%u\n", take, jsonLong(resp, "\"accepted\"", -1),
                  jsonLong(resp, "\"unknown\"", -1), pendingCount);
  } else {
    postFail++;
    Serial.printf("[flush] POST failed (%d), %u entries buffered\n", code, pendingCount);
    if (code == 401) clockSynced = false;  // signature rejected: most likely clock drift, re-sync
  }
}

void sendHeartbeat() {
  if (!clockSynced && !syncTime()) return;
  String body = "{\"fw\":\"" FW_VERSION "\",\"wifiRssi\":";
  body += WiFi.RSSI();
  body += ",\"uptime\":";
  body += (unsigned long)(millis() / 1000);
  body += ",\"buffered\":";
  body += pendingCount;
  body += ",\"ip\":\"";
  body += WiFi.localIP().toString();
  body += "\"}";
  String resp;
  int code;
  if (!postJson("/api/v1/scanners/heartbeat", body, resp, code) || code != 200) {
    Serial.printf("[hb] failed (%d)\n", code);
    if (code == 401) {
      clockSynced = false;
      Serial.println("[hb] 401 — check scanner id/secret with `show`, or clock (re-syncing)");
    }
    return;
  }
  long serverNow = jsonLong(resp, "\"now\"", 0);
  if (serverNow > 0) clockOffsetMs = (int64_t)serverNow * 1000 - (int64_t)millis();
  bool active = jsonBool(resp, "\"active\"", sessionActive);
  if (active != sessionActive) {
    sessionActive = active;
    Serial.printf("[session] %s\n", active ? "ACTIVE" : "none");
  }
  long fi = jsonLong(resp, "\"flushIntervalMs\"", flushIntervalMs);
  if (fi >= 1000 && fi <= 60000) flushIntervalMs = fi;
  long hi = jsonLong(resp, "\"heartbeatIntervalMs\"", heartbeatIntervalMs);
  if (hi >= 5000 && hi <= 300000) heartbeatIntervalMs = hi;
  // adopt the beacon major/minor the backend assigned to this scanner
  long major = jsonLong(resp, "\"major\"", 0);
  long minor = jsonLong(resp, "\"minor\"", 0);
  if (major > 0 && minor > 0 && (major != cfg.beaconMajor || minor != cfg.beaconMinor || !beaconRunning)) {
    cfg.beaconMajor = (uint16_t)major;
    cfg.beaconMinor = (uint16_t)minor;
    startBeacon();
  }
  Serial.printf("[hb] ok, session=%s flush=%lums\n", sessionActive ? "ACTIVE" : "none", (unsigned long)flushIntervalMs);
}

/** POST with SmartClass scanner signature headers. */
bool postJson(const char* path, const String& body, String& response, int& httpCode) {
  httpCode = -1;
  if (WiFi.status() != WL_CONNECTED || strlen(cfg.server) == 0) return false;
  uint32_t ts = nowUnix();
  char tsStr[16];
  snprintf(tsStr, sizeof(tsStr), "%lu", (unsigned long)ts);
  // signature = HMAC_SHA256(secret, "<ts>.<body>")
  String msg = String(tsStr) + "." + body;
  char sig[65];
  hmacSha256Hex(cfg.secret, msg.c_str(), msg.length(), sig);

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setReuse(false);
  String url = String(cfg.server) + path;
  if (!beginHttp(http, url)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Scanner-Id", cfg.scannerId);
  http.addHeader("X-Timestamp", tsStr);
  http.addHeader("X-Signature", sig);
  httpCode = http.POST(body);
  response = httpCode > 0 ? http.getString() : "";
  http.end();
  return httpCode > 0;
}

/** http:// → plain socket; https:// → TLS without certificate pinning (hackathon: tunnel hostnames change). */
bool beginHttp(HTTPClient& http, const String& url) {
  if (url.startsWith("https://")) {
    secureClient.setInsecure();
    secureClient.setTimeout(HTTP_TIMEOUT_MS / 1000);
    return http.begin(secureClient, url);
  }
  return http.begin(plainClient, url);
}

void pushPending(const Agg& a) {
  if (a.n == 0) return;
  Pending& p = pending[pendingHead];
  memcpy(p.token, a.token, 8);
  p.rssiAvg = (int8_t)(a.rssiSum / (int32_t)a.n);
  p.rssiMax = a.rssiMax;
  p.n = a.n;
  p.ts = a.lastTs;
  pendingHead = (pendingHead + 1) % PENDING_MAX;
  if (pendingCount < PENDING_MAX) pendingCount++;  // else: overwrote the oldest entry
}

// ------------------------------------------------------------------ crypto / encoding helpers
void hmacSha256Hex(const char* key, const char* msg, size_t msgLen, char out[65]) {
  uint8_t mac[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, (const uint8_t*)key, strlen(key));
  mbedtls_md_hmac_update(&ctx, (const uint8_t*)msg, msgLen);
  mbedtls_md_hmac_finish(&ctx, mac);
  mbedtls_md_free(&ctx);
  hexEncode(mac, 32, out);
}

void hexEncode(const uint8_t* in, size_t n, char* out) {
  static const char* digits = "0123456789ABCDEF";
  for (size_t i = 0; i < n; i++) {
    out[i * 2] = digits[in[i] >> 4];
    out[i * 2 + 1] = digits[in[i] & 0x0F];
  }
  out[n * 2] = 0;
}

/** Minimal JSON field readers (no ArduinoJson dependency). key includes quotes, e.g. "\"now\"". */
long jsonLong(const String& json, const char* key, long defaultValue) {
  int i = json.indexOf(key);
  if (i < 0) return defaultValue;
  i = json.indexOf(':', i);
  if (i < 0) return defaultValue;
  i++;
  while (i < (int)json.length() && json[i] == ' ') i++;
  if (i >= (int)json.length() || !(isdigit(json[i]) || json[i] == '-')) return defaultValue;
  return json.substring(i).toInt();
}

bool jsonBool(const String& json, const char* key, bool defaultValue) {
  int i = json.indexOf(key);
  if (i < 0) return defaultValue;
  i = json.indexOf(':', i);
  if (i < 0) return defaultValue;
  int t = json.indexOf("true", i);
  int f = json.indexOf("false", i);
  if (t >= 0 && (f < 0 || t < f) && t - i <= 3) return true;
  if (f >= 0 && f - i <= 3) return false;
  return defaultValue;
}

// ------------------------------------------------------------------ LED: fast blink = no Wi-Fi, slow blink = idle, solid = class active
void updateLed() {
  uint32_t now = millis();
  if (rangeSimOut) {
    digitalWrite(LED_PIN, LOW);
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastLed > 150) { lastLed = now; digitalWrite(LED_PIN, !digitalRead(LED_PIN)); }
  } else if (sessionActive) {
    digitalWrite(LED_PIN, HIGH);
  } else if (now - lastLed > 1000) {
    lastLed = now;
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
  }
}

// ------------------------------------------------------------------ demo: simulate walking out of range
/** out=true: beacon off + detections dropped (iPhones and Android phones both look "gone"). out=false: normal. */
void setRangeSim(bool out) {
  if (out == rangeSimOut) return;
  rangeSimOut = out;
  if (out) {
    stopBeacon();
    Serial.println("[sim] OUT OF RANGE — beacon off, phone reports suppressed (press BOOT or `range in` to return)");
  } else {
    if (cfg.beaconMajor && cfg.beaconMinor) startBeacon();
    Serial.println("[sim] back IN RANGE");
  }
}

/** BOOT button (GPIO0, active low) toggles the out-of-range simulation. Debounced, edge-triggered. */
void handleButton() {
  bool pressed = digitalRead(BOOT_BUTTON_PIN) == LOW;
  uint32_t now = millis();
  if (pressed != lastButtonState && now - lastButtonChange > 250) {
    lastButtonChange = now;
    lastButtonState = pressed;
    if (pressed) setRangeSim(!rangeSimOut);
  }
}

// ------------------------------------------------------------------ config (NVS) + serial console
void loadConfig() {
  memset(&cfg, 0, sizeof(cfg));
  prefs.begin("smartclass", true);
  prefs.getString("ssid", cfg.ssid, sizeof(cfg.ssid));
  prefs.getString("pass", cfg.pass, sizeof(cfg.pass));
  prefs.getString("server", cfg.server, sizeof(cfg.server));
  prefs.getString("id", cfg.scannerId, sizeof(cfg.scannerId));
  prefs.getString("secret", cfg.secret, sizeof(cfg.secret));
  cfg.beaconMajor = prefs.getUShort("major", 0);
  cfg.beaconMinor = prefs.getUShort("minor", 0);
  cfg.activeScan = prefs.getUChar("active", 0);
  prefs.end();
  // compile-time defaults fill anything not configured at runtime
  if (!cfg.ssid[0]) strlcpy(cfg.ssid, DEFAULT_WIFI_SSID, sizeof(cfg.ssid));
  if (!cfg.pass[0]) strlcpy(cfg.pass, DEFAULT_WIFI_PASS, sizeof(cfg.pass));
  if (!cfg.server[0]) strlcpy(cfg.server, DEFAULT_SERVER_URL, sizeof(cfg.server));
  if (!cfg.scannerId[0]) strlcpy(cfg.scannerId, DEFAULT_SCANNER_ID, sizeof(cfg.scannerId));
  if (!cfg.secret[0]) strlcpy(cfg.secret, DEFAULT_SCANNER_SECRET, sizeof(cfg.secret));
}

void saveConfig() {
  prefs.begin("smartclass", false);
  prefs.putString("ssid", cfg.ssid);
  prefs.putString("pass", cfg.pass);
  prefs.putString("server", cfg.server);
  prefs.putString("id", cfg.scannerId);
  prefs.putString("secret", cfg.secret);
  prefs.putUShort("major", cfg.beaconMajor);
  prefs.putUShort("minor", cfg.beaconMinor);
  prefs.putUChar("active", cfg.activeScan);
  prefs.end();
  Serial.println("[cfg] saved to NVS");
}

void printConfig() {
  Serial.printf("[cfg] ssid=\"%s\" pass=%s server=%s scanner=%s secret=%s beacon=%u/%u scan=%s\n", cfg.ssid,
                cfg.pass[0] ? "****" : "(none)", cfg.server, cfg.scannerId, cfg.secret[0] ? "****" : "(none)", cfg.beaconMajor,
                cfg.beaconMinor, cfg.activeScan ? "active" : "passive");
}

void handleSerial() {
  static char line[256];
  static uint8_t len = 0;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[len] = 0;
      if (len) handleCommand(line);
      len = 0;
    } else if (len < sizeof(line) - 1) {
      line[len++] = c;
    }
  }
}

void handleCommand(char* line) {
  char* cmd = strtok(line, " ");
  if (!cmd) return;
  if (!strcmp(cmd, "help")) {
    Serial.println("commands:\n  show\n  wifi <ssid> <password>\n  server <http://host:port>\n  scanner <id> <secret>\n"
                   "  beacon <major> <minor>\n  active <0|1>\n  range out|in|toggle   (simulate walking out; BOOT button does the same)\n  save\n  reboot\n  clear   (erase saved config)\n  stats");
  } else if (!strcmp(cmd, "show")) {
    printConfig();
  } else if (!strcmp(cmd, "wifi")) {
    char* ssid = strtok(nullptr, " ");
    char* pass = strtok(nullptr, "");
    if (!ssid) { Serial.println("usage: wifi <ssid> <password>"); return; }
    strlcpy(cfg.ssid, ssid, sizeof(cfg.ssid));
    strlcpy(cfg.pass, pass ? pass : "", sizeof(cfg.pass));
    Serial.println("[cfg] wifi set (type `save` then `reboot`)");
  } else if (!strcmp(cmd, "server")) {
    char* url = strtok(nullptr, " ");
    if (!url) { Serial.println("usage: server http://192.168.1.23:4000"); return; }
    strlcpy(cfg.server, url, sizeof(cfg.server));
    size_t l = strlen(cfg.server);
    if (l && cfg.server[l - 1] == '/') cfg.server[l - 1] = 0;
    clockSynced = false;
    Serial.println("[cfg] server set");
  } else if (!strcmp(cmd, "scanner")) {
    char* id = strtok(nullptr, " ");
    char* secret = strtok(nullptr, " ");
    if (!id || !secret) { Serial.println("usage: scanner <id> <secret>"); return; }
    strlcpy(cfg.scannerId, id, sizeof(cfg.scannerId));
    strlcpy(cfg.secret, secret, sizeof(cfg.secret));
    Serial.println("[cfg] scanner set");
  } else if (!strcmp(cmd, "beacon")) {
    char* a = strtok(nullptr, " ");
    char* b = strtok(nullptr, " ");
    if (!a || !b) { Serial.println("usage: beacon <major> <minor>"); return; }
    cfg.beaconMajor = (uint16_t)atoi(a);
    cfg.beaconMinor = (uint16_t)atoi(b);
    if (cfg.beaconMajor && cfg.beaconMinor) startBeacon(); else stopBeacon();
  } else if (!strcmp(cmd, "active")) {
    char* a = strtok(nullptr, " ");
    cfg.activeScan = (a && atoi(a)) ? 1 : 0;
    if (pScan) { pScan->stop(); pScan->setActiveScan(cfg.activeScan == 1); pScan->start(0, false, true); }
    Serial.printf("[ble] %s scan\n", cfg.activeScan ? "active" : "passive");
  } else if (!strcmp(cmd, "save")) {
    saveConfig();
  } else if (!strcmp(cmd, "reboot")) {
    Serial.println("rebooting...");
    delay(100);
    ESP.restart();
  } else if (!strcmp(cmd, "clear")) {
    prefs.begin("smartclass", false);
    prefs.clear();
    prefs.end();
    Serial.println("[cfg] cleared; reboot to use compile-time defaults");
  } else if (!strcmp(cmd, "range")) {
    char* a = strtok(nullptr, " ");
    if (a && !strcmp(a, "out")) setRangeSim(true);
    else if (a && !strcmp(a, "in")) setRangeSim(false);
    else if (a && !strcmp(a, "toggle")) setRangeSim(!rangeSimOut);
    else Serial.printf("range is %s — usage: range out|in|toggle\n", rangeSimOut ? "OUT" : "in");
  } else if (!strcmp(cmd, "stats")) {
    Serial.printf("adv=%lu dropped=%lu pending=%u ok=%lu fail=%lu clock=%s unix=%lu beacon=%s range=%s\n", (unsigned long)totalAdv,
                  (unsigned long)droppedAdv, pendingCount, (unsigned long)postOk, (unsigned long)postFail,
                  clockSynced ? "synced" : "unsynced", (unsigned long)nowUnix(), beaconRunning ? "on" : "off", rangeSimOut ? "OUT" : "in");
  } else {
    Serial.printf("unknown command \"%s\" — type help\n", cmd);
  }
}

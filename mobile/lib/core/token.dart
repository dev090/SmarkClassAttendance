import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// Mirrors backend/src/tokens.ts and firmware manufacturer-data layout.
class SmartClassToken {
  static const String context = 'smartclass:v1:';
  static const int windowSeconds = 60;
  static const int companyId = 0xFFFF; // Bluetooth SIG test id
  static const int version = 0x01;

  /// Current token window for a unix time in milliseconds.
  static int windowFor(int unixMs) => (unixMs ~/ 1000) ~/ windowSeconds;

  /// Milliseconds until the next window boundary (plus a small margin).
  static int msUntilNextWindow(int unixMs) {
    final next = (windowFor(unixMs) + 1) * windowSeconds * 1000;
    return (next - unixMs) + 400;
  }

  /// First 8 bytes of `HMAC_SHA256(secret, "smartclass:v1:" + window)`.
  static Uint8List derive(String secretHex, int window) {
    final key = _hexToBytes(secretHex);
    final mac = Hmac(sha256, key).convert(utf8.encode('$context$window')).bytes;
    return Uint8List.fromList(mac.sublist(0, 8));
  }

  static String hex(Uint8List bytes) =>
      bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join().toUpperCase();

  /// Manufacturer-specific payload (without the 2-byte company id, which the OS prepends):
  /// 'S' 'C' version token[8] flags
  static Uint8List payload(Uint8List token, {bool foreground = true, bool charging = false}) {
    final flags = (charging ? 0x01 : 0) | (foreground ? 0x02 : 0);
    return Uint8List.fromList([0x53, 0x43, version, ...token, flags]);
  }

  static Uint8List _hexToBytes(String hex) {
    final out = Uint8List(hex.length ~/ 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }
}

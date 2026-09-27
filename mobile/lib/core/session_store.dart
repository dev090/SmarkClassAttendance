import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import 'app_config.dart';

/// Persists login state. The BLE secret never leaves the device except in the login response.
class SessionStore {
  static const _kServer = 'server';
  static const _kToken = 'token';
  static const _kSecret = 'secret';
  static const _kName = 'name';
  static const _kEmail = 'email';
  static const _kDeviceId = 'deviceId';
  static const _kOffset = 'clockOffsetMs';
  static const _kMajors = 'roomMajors';

  final SharedPreferences _p;
  SessionStore._(this._p);

  static Future<SessionStore> load() async => SessionStore._(await SharedPreferences.getInstance());

  String get serverUrl => _p.getString(_kServer) ?? kDefaultServerUrl;
  String? get token => _p.getString(_kToken);
  String? get secret => _p.getString(_kSecret);
  String? get name => _p.getString(_kName);
  String? get email => _p.getString(_kEmail);
  int get clockOffsetMs => _p.getInt(_kOffset) ?? 0;
  bool get isLoggedIn => token != null && secret != null;
  List<int> get roomMajors => (_p.getStringList(_kMajors) ?? const []).map(int.parse).toList();

  /// Stable per-install id. Logging in from a second phone rotates the secret server-side.
  Future<String> deviceId() async {
    var id = _p.getString(_kDeviceId);
    if (id == null) {
      id = const Uuid().v4();
      await _p.setString(_kDeviceId, id);
    }
    return id;
  }

  /// Normalises what the user typed: trims spaces, adds https:// when the scheme is missing, drops a trailing slash.
  static String normalizeServerUrl(String raw) {
    var u = raw.trim();
    if (u.isEmpty) return kDefaultServerUrl;
    if (!u.startsWith('http://') && !u.startsWith('https://')) {
      // bare LAN address → http, anything else (tunnel/cloud host) → https
      u = RegExp(r'^(\d{1,3}\.){3}\d{1,3}(:\d+)?$').hasMatch(u) ? 'http://$u' : 'https://$u';
    }
    return u.replaceAll(RegExp(r'/+$'), '');
  }

  Future<void> setServerUrl(String url) => _p.setString(_kServer, normalizeServerUrl(url));

  Future<void> saveLogin({required String token, required String secret, required String name, required String email, List<int> roomMajors = const []}) async {
    await _p.setStringList(_kMajors, roomMajors.map((m) => m.toString()).toList());
    await _p.setString(_kToken, token);
    await _p.setString(_kSecret, secret);
    await _p.setString(_kName, name);
    await _p.setString(_kEmail, email);
  }

  Future<void> setClockOffset(int offsetMs) => _p.setInt(_kOffset, offsetMs);

  Future<void> clear() async {
    for (final k in [_kToken, _kSecret, _kName, _kEmail]) {
      await _p.remove(k);
    }
  }
}

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_beacon/flutter_beacon.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// iPhone path (also usable on Android as a fallback): the classroom ESP32s advertise an iBeacon
/// (UUID below, major = room, minor = scanner). The phone ranges the beacons and proves presence to
/// the backend with its bearer token — the backend turns that into the same evidence an ESP32 report
/// would produce, so the professor dashboard looks identical.
///
/// Permission flow: iOS answers "not determined" until the user taps Allow, so we request, then keep
/// re-checking (state streams + a 4 s retry) and only start ranging once location + Bluetooth are OK.
class BeaconPresence extends ChangeNotifier {
  static const String uuid = '5C0A7A1D-5C1A-4C1A-B1E5-000000000001';
  static const Duration postEvery = Duration(seconds: 3);

  final String baseUrl;
  final String token;
  /// iBeacon majors of the student's rooms. iOS monitors one region per room in the background
  /// (phone locked, app not on screen) and wakes the app on enter/exit.
  final List<int> roomMajors;
  final http.Client _client = http.Client();
  BeaconPresence({required this.baseUrl, required this.token, this.roomMajors = const []});

  /// foreground ranging: any SmartClass beacon (major/minor come from the readings)
  final List<Region> _regions = [Region(identifier: 'SmartClass', proximityUUID: uuid)];
  /// background monitoring: one region per room so enter/exit events tell us which room
  List<Region> get _monitorRegions => roomMajors.isEmpty
      ? _regions
      : roomMajors.map((m) => Region(identifier: 'room-$m', proximityUUID: uuid, major: m)).toList();
  final Set<int> insideRooms = {};
  /// rooms iOS said we were inside the last time the app ran (survives a force-quit, so a relaunch
  /// triggered by leaving the room can report the exit instead of just "I'm outside")
  Set<int> _previouslyInside = {};
  static const _kInside = 'beacon.insideRooms';
  final Map<String, DateTime> _lastEventPost = {};
  int? lastMajor;
  /// consecutive ranging callbacks with no SmartClass beacon; after [_lostAfter] we tell the server we left
  int _emptyScans = 0;
  bool _lostReported = false;
  static const int _lostAfter = 3;
  /// with the screen off iOS delivers scans less often, so also treat "nothing heard for this long" as lost
  static const Duration _lostAfterSilence = Duration(seconds: 8);
  StreamSubscription<RangingResult>? _ranging;
  StreamSubscription<MonitoringResult>? _monitoring;
  StreamSubscription<AuthorizationStatus>? _authSub;
  StreamSubscription<BluetoothState>? _btSub;
  Timer? _retry;
  DateTime? _lastPost;
  DateTime? _lastRangingEvent;
  DateTime? _rangingStartedAt;
  bool _starting = false;
  bool _everRanged = false; // once ranging has delivered, restarts skip the (hang-prone) state queries
  // One-time plugin init + permission request per app launch. Process-wide: a new instance after sign-out
  // must not repeat it either, because iOS only answers the permission query when the state changes.
  static bool pluginInitialized = false;
  int restarts = 0;
  static const Duration _pluginTimeout = Duration(seconds: 3);
  static const Duration _stallAfter = Duration(seconds: 15);

  /// user wants detection on
  bool running = false;
  /// ranging stream is active
  bool ranging = false;
  bool inside = false;
  AuthorizationStatus? authStatus;
  BluetoothState? btState;
  String? lastError;
  List<Beacon> lastBeacons = const [];
  String? lastServerState; // present|detected|away|left or a reason such as no_active_session
  DateTime? lastSeen;
  int posts = 0;

  Future<void> start() async {
    running = true;
    lastError = null;
    notifyListeners();
    if (!pluginInitialized) {
      pluginInitialized = true;
      try {
        final prefs = await SharedPreferences.getInstance();
        _previouslyInside = (prefs.getStringList(_kInside) ?? const []).map(int.parse).toSet();
      } catch (_) {}
      try {
        // "Always" lets iOS deliver region enter/exit while the app is in the background.
        await flutterBeacon.setLocationAuthorizationTypeDefault(AuthorizationStatus.always);
        try {
          await flutterBeacon.initializeScanning.timeout(_pluginTimeout);
        } catch (e) {
          debugPrint('[beacon] initializeScanning: $e');
        }
        // Triggers the iOS permission dialog the first time (may legitimately wait for the user).
        try {
          await flutterBeacon.requestAuthorization.timeout(const Duration(seconds: 10));
        } catch (e) {
          debugPrint('[beacon] requestAuthorization: $e');
        }
      } catch (e) {
        lastError = e.toString();
        debugPrint('[beacon] start error: $e');
      }
    }
    _authSub ??= flutterBeacon.authorizationStatusChanged().listen((s) {
      debugPrint('[beacon] authorization -> $s');
      authStatus = s;
      unawaited(_maybeRange());
    });
    _btSub ??= flutterBeacon.bluetoothStateChanged().listen((s) {
      debugPrint('[beacon] bluetooth -> $s');
      btState = s;
      unawaited(_maybeRange());
    });
    _retry ??= Timer.periodic(const Duration(seconds: 4), (_) {
      if (!running) return;
      if (!ranging) {
        unawaited(_maybeRange());
        return;
      }
      if (lastSeen != null && !_lostReported && DateTime.now().difference(lastSeen!) >= _lostAfterSilence * 2) {
        _emptyScans = _lostAfter; // no callbacks at all for 16 s counts as lost too
        _maybeReportLost();
      }
      // Watchdog: iOS sometimes stops delivering ranging callbacks (backgrounding, plugin hiccup) without an error.
      final last = _lastRangingEvent ?? _rangingStartedAt;
      if (last != null && DateTime.now().difference(last) > _stallAfter) {
        debugPrint('[beacon] no ranging callbacks for ${_stallAfter.inSeconds}s — restarting');
        unawaited(_restartRanging());
      }
    });
    await _maybeRange();
  }

  /// Call when the app returns to the foreground. (With the background keep-alive ranging usually kept
  /// running; restarting is cheap and covers the case where iOS suspended us anyway.)
  void onAppResumed() {
    _lastPost = null; // report the first fresh reading immediately
    if (running) unawaited(_restartRanging());
  }

  Future<void> _restartRanging() async {
    restarts++;
    await _ranging?.cancel();
    await _monitoring?.cancel();
    _ranging = null;
    _monitoring = null;
    ranging = false;
    _starting = false;
    notifyListeners();
    await _maybeRange();
  }

  /// Stops listening. With [tellServer] the backend is told the student is leaving, so the dashboard
  /// shows Away right away instead of keeping the sticky "inside the room" presence.
  Future<void> stop({bool tellServer = true}) async {
    running = false;
    _retry?.cancel();
    _retry = null;
    await _ranging?.cancel();
    await _monitoring?.cancel();
    _ranging = null;
    _monitoring = null;
    ranging = false;
    insideRooms.clear();
    inside = false;
    await _persistInside();
    notifyListeners();
    if (tellServer) await _postStop();
  }

  Future<void> _postStop() async {
    try {
      final r = await _client
          .post(
            Uri.parse('$baseUrl/api/v1/presence/ios'),
            headers: {'content-type': 'application/json', 'authorization': 'Bearer $token'},
            body: jsonEncode({'event': 'stop'}),
          )
          .timeout(const Duration(seconds: 8));
      lastServerState = 'stopped (${r.statusCode})';
      debugPrint('[beacon] told server we stopped -> ${r.statusCode}');
    } catch (e) {
      lastError = 'stop post failed: $e';
      debugPrint('[beacon] stop post error: $e');
    }
    notifyListeners();
  }

  bool get _authOk =>
      authStatus == AuthorizationStatus.allowed ||
      authStatus == AuthorizationStatus.always ||
      authStatus == AuthorizationStatus.whenInUse;

  Future<void> _maybeRange() async {
    if (!running || ranging || _starting) return;
    _starting = true;
    try {
      // The iOS plugin answers these getters via delegate callbacks that only fire when the state CHANGES,
      // so after the first successful check they can hang. Query them only until ranging has worked once,
      // and treat a timeout as "unchanged" rather than "blocked".
      if (!_everRanged) {
        try {
          authStatus = await flutterBeacon.authorizationStatus.timeout(_pluginTimeout);
        } catch (e) {
          debugPrint('[beacon] authorizationStatus unanswered: $e');
        }
        try {
          btState = await flutterBeacon.bluetoothState.timeout(_pluginTimeout);
        } catch (e) {
          debugPrint('[beacon] bluetoothState unanswered: $e');
        }
      }
      debugPrint('[beacon] check auth=$authStatus bt=$btState everRanged=$_everRanged');
      final blocked = (authStatus != null && !_authOk) || (btState != null && btState != BluetoothState.stateOn);
      if (blocked) {
        notifyListeners();
        return;
      }
      _monitoring = flutterBeacon.monitoring(_monitorRegions).listen(_onMonitoring, onError: (Object e) {
        debugPrint('[beacon] monitoring error: $e');
      });
      _ranging = flutterBeacon.ranging(_regions).listen(_onRanging, onError: (Object e) {
        lastError = e.toString();
        debugPrint('[beacon] ranging error: $e');
        ranging = false;
        notifyListeners();
      });
      ranging = true;
      lastError = null;
      _rangingStartedAt = DateTime.now();
      _lastRangingEvent = null;
      debugPrint('[beacon] ranging started for $uuid');
    } catch (e) {
      lastError = e.toString();
      debugPrint('[beacon] _maybeRange error: $e');
    } finally {
      _starting = false;
      notifyListeners();
    }
  }

  void _onRanging(RangingResult r) {
    _lastRangingEvent = DateTime.now();
    _everRanged = true;
    if (r.beacons.isEmpty) {
      if (lastBeacons.isNotEmpty) debugPrint('[beacon] no beacons in range');
      lastBeacons = const [];
      _emptyScans++;
      _maybeReportLost();
      notifyListeners();
      return;
    }
    _emptyScans = 0;
    _lostReported = false;
    lastBeacons = [...r.beacons]..sort((a, b) => _rssi(b).compareTo(_rssi(a)));
    lastSeen = DateTime.now();
    final b = lastBeacons.first;
    lastMajor = b.major;
    debugPrint('[beacon] ranged ${r.beacons.length}: major=${b.major} minor=${b.minor} rssi=${b.rssi} ${_prox(b)}');
    final now = DateTime.now();
    if (_lastPost == null || now.difference(_lastPost!) >= postEvery) {
      _lastPost = now;
      // report every scanner in range (max 4) so the backend can estimate the zone from relative RSSI
      for (final beacon in lastBeacons.take(4)) {
        unawaited(_post(beacon));
      }
    }
    notifyListeners();
  }

  static String _prox(Beacon b) => b.proximity.toString().split('.').last;

  /// Region events arrive even when the phone is locked and the app is in the background.
  void _onMonitoring(MonitoringResult r) {
    final major = r.region.major ?? lastMajor;
    final type = r.monitoringEventType;
    // monitoringState is only set for didDetermineStateForRegion; enter/exit events carry no state
    final entered = type == MonitoringEventType.didEnterRegion ||
        (type == MonitoringEventType.didDetermineStateForRegion && r.monitoringState == MonitoringState.inside);
    final exited = type == MonitoringEventType.didExitRegion ||
        (type == MonitoringEventType.didDetermineStateForRegion && r.monitoringState == MonitoringState.outside);
    debugPrint('[beacon] region ${r.region.identifier} $type state=${r.monitoringState} major=$major');
    if (major == null) {
      notifyListeners();
      return;
    }
    if (entered) {
      insideRooms.add(major);
      unawaited(_postEvent('enter', major));
    } else if (exited) {
      insideRooms.remove(major);
      // A real exit event means "left". An "outside" state check only counts as a leave when the previous run
      // of the app had us inside this room — i.e. iOS relaunched us (after a force-quit) because we walked out.
      final relaunchedAfterLeaving = type == MonitoringEventType.didDetermineStateForRegion && _previouslyInside.remove(major);
      if (type == MonitoringEventType.didExitRegion || relaunchedAfterLeaving) unawaited(_postEvent('exit', major));
    }
    inside = insideRooms.isNotEmpty;
    unawaited(_persistInside());
    notifyListeners();
  }

  Future<void> _persistInside() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(_kInside, insideRooms.map((m) => m.toString()).toList());
    } catch (_) {}
  }

  Future<void> _postEvent(String event, int major) async {
    final key = '$event-$major';
    final last = _lastEventPost[key];
    if (last != null && DateTime.now().difference(last) < const Duration(seconds: 10)) return; // iOS can repeat events
    _lastEventPost[key] = DateTime.now();
    try {
      final r = await _client
          .post(
            Uri.parse('$baseUrl/api/v1/presence/ios'),
            headers: {'content-type': 'application/json', 'authorization': 'Bearer $token'},
            body: jsonEncode({'event': event, 'major': major}),
          )
          .timeout(const Duration(seconds: 8));
      posts++;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      lastServerState = (j['state'] ?? j['reason'] ?? j['error'])?.toString();
      debugPrint('[beacon] posted $event room $major -> ${r.statusCode} $lastServerState');
      lastError = null;
    } catch (e) {
      lastError = 'region $event post failed: $e';
      debugPrint('[beacon] region post error: $e');
    }
    notifyListeners();
  }

  /// Three empty scans in a row (~3 s on screen) or 8 s without hearing the beacon = we really lost the room.
  /// Report it instead of waiting for the server's silence timer or iOS's ~30 s region exit.
  void _maybeReportLost() {
    if (_lostReported || lastMajor == null || lastSeen == null) return;
    final silent = DateTime.now().difference(lastSeen!);
    if (_emptyScans >= _lostAfter || (_emptyScans >= 1 && silent >= _lostAfterSilence)) {
      _lostReported = true;
      debugPrint('[beacon] lost the beacon ($_emptyScans empty scans, ${silent.inSeconds}s silent)');
      unawaited(_postEvent('exit', lastMajor!));
    }
  }

  /// iOS reports rssi 0 when it has no fresh reading; treat that as very weak.
  static int _rssi(Beacon b) => b.rssi == 0 ? -100 : b.rssi;

  Future<void> _post(Beacon b) async {
    try {
      final r = await _client
          .post(
            Uri.parse('$baseUrl/api/v1/presence/ios'),
            headers: {'content-type': 'application/json', 'authorization': 'Bearer $token'},
            body: jsonEncode({
              'event': 'range',
              'major': b.major,
              'minor': b.minor,
              'proximity': _prox(b),
              if (b.rssi != 0) 'rssi': b.rssi,
            }),
          )
          .timeout(const Duration(seconds: 6));
      posts++;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      lastServerState = (j['state'] ?? j['reason'] ?? j['error'])?.toString();
      debugPrint('[beacon] posted presence -> ${r.statusCode} $lastServerState');
      lastError = null;
    } catch (e) {
      lastError = 'presence post failed: $e';
      debugPrint('[beacon] post error: $e');
    }
    notifyListeners();
  }

  String describe() {
    if (!running) return lastError ?? 'not started';
    if (!ranging) {
      final parts = <String>[];
      if (authStatus != null && !_authOk) parts.add('location permission: ${authStatus!.value}');
      if (btState != null && btState != BluetoothState.stateOn) parts.add('bluetooth: ${btState!.value}');
      return parts.isEmpty ? (lastError ?? 'starting…') : 'Waiting for ${parts.join(', ')}';
    }
    final age = _lastRangingEvent == null ? 'no callbacks yet' : '${DateTime.now().difference(_lastRangingEvent!).inSeconds}s since last scan';
    final rooms = insideRooms.isEmpty ? 'outside all rooms' : 'inside room ${insideRooms.join('/')}';
    if (lastBeacons.isEmpty) return 'Listening — no beacon reading ($rooms, $age, restarts $restarts, location ${authStatus?.value ?? '?'})';
    final b = lastBeacons.first;
    final rssi = b.rssi == 0 ? '' : ' · ${b.rssi} dBm';
    final server = lastServerState == null ? '' : ' · server: $lastServerState';
    return 'Room ${b.major} scanner ${b.minor} · ${_prox(b)}$rssi$server · $posts reports · monitoring ${_monitorRegions.length} room(s) · location ${authStatus?.value ?? '?'}';
  }

  @override
  void dispose() {
    _authSub?.cancel();
    _btSub?.cancel();
    // widget going away (e.g. sign-out): the owner should have awaited stop(); don't tell the server twice
    unawaited(stop(tellServer: false).then((_) => _client.close()));
    super.dispose();
  }
}

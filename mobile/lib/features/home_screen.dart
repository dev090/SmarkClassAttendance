import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/beacon_presence.dart';
import '../core/ble_broadcaster.dart';
import '../core/requirements.dart';
import '../core/session_store.dart';
import 'requirements_gate.dart';

class HomeScreen extends StatefulWidget {
  final SessionStore store;
  final BleBroadcaster ble;
  final VoidCallback onSignOut;
  const HomeScreen(
      {super.key,
      required this.store,
      required this.ble,
      required this.onSignOut});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  Timer? _poll;
  ClassStatus? _status;
  String? _statusError;
  bool _permission = false;
  bool _supported = true;
  BeaconPresence? _beacon; // iPhone path
  late final SmartClassApi _api =
      SmartClassApi(widget.store.serverUrl, token: widget.store.token);
  late final Requirements _req =
      Requirements(android: Platform.isAndroid ? widget.ble : null);
  bool _detectionStarted = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.ble.addListener(_onBle);
    _init();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // back from Settings? re-check the requirements, then resume listening
      unawaited(_req.refresh());
      _beacon?.onAppResumed();
      _refreshStatus();
    }
  }

  Future<void> _init() async {
    // Ask the backend about the class first and keep polling no matter what Bluetooth does:
    // the status card must never wait on a permission dialog or a slow plugin call.
    unawaited(_refreshStatus());
    _poll = Timer.periodic(const Duration(seconds: 5), (_) => _refreshStatus());
    if (Platform.isIOS) {
      // iPhones cannot advertise to the ESP32s; they listen for the classroom beacon instead.
      _beacon = BeaconPresence(
          baseUrl: widget.store.serverUrl,
          token: widget.store.token ?? '',
          roomMajors: widget.store.roomMajors);
      _beacon!.addListener(_onBle);
      _permission = true;
      _supported = true;
    } else {
      _supported = await widget.ble.isSupported();
      _permission = await widget.ble.hasPermission();
    }
    // The requirements gate does the (one-time) permission querying; detection starts only once it is satisfied.
    _req.addListener(_onRequirements);
    await _req.start();
    BeaconPresence.pluginInitialized = true;
    _onRequirements();
    if (mounted) setState(() {});
  }

  void _onRequirements() {
    if (!mounted) return;
    if (_req.satisfied && !_detectionStarted) {
      _detectionStarted = true;
      if (Platform.isIOS) {
        unawaited(_beacon!.start());
      } else if (_supported) {
        _permission = true;
        unawaited(_startBroadcast());
      }
    }
    setState(() {});
  }

  Future<void> _startBroadcast() async {
    final secret = widget.store.secret;
    if (secret == null) return;
    await widget.ble.start(secret, clockOffsetMs: widget.store.clockOffsetMs);
  }

  Future<void> _refreshStatus() async {
    try {
      final s = await _api.status(beacon: _beacon?.describe());
      if (mounted) {
        setState(() {
          _status = s;
          _statusError = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _statusError = e.toString());
    }
  }

  void _onBle() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    widget.ble.removeListener(_onBle);
    _beacon?.removeListener(_onBle);
    _beacon?.dispose();
    _req.removeListener(_onRequirements);
    _req.dispose();
    _api.close();
    super.dispose();
  }

  String _fmtTime(int? unix) {
    if (unix == null) return '—';
    final d = DateTime.fromMillisecondsSinceEpoch(unix * 1000);
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final ble = widget.ble;
    final s = _status;
    final theme = Theme.of(context);
    final ok = theme.colorScheme.primary;

    Widget check(String label, bool good, {String? detail}) => ListTile(
          dense: true,
          leading: Icon(good ? Icons.check_circle : Icons.error_outline,
              color: good ? ok : theme.colorScheme.error),
          title: Text(label),
          subtitle: detail == null ? null : Text(detail),
        );

    return Scaffold(
      appBar: AppBar(
        title: const Text('SmartClass'),
        actions: [
          IconButton(
            tooltip: 'Sign out',
            icon: const Icon(Icons.logout),
            onPressed: () async {
              // leaving the class explicitly: tell the server before the token is thrown away
              await _beacon?.stop();
              await widget.ble.stop();
              widget.onSignOut();
            },
          ),
        ],
      ),
      body: RequirementsGate(
        req: _req,
        child: RefreshIndicator(
          onRefresh: _refreshStatus,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text('Hi, ${widget.store.name?.split(' ').first ?? 'there'}',
                  style: theme.textTheme.headlineSmall),
              const SizedBox(height: 16),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: s == null
                      ? Row(children: [
                          if (_statusError == null)
                            const SizedBox(
                                width: 18,
                                height: 18,
                                child:
                                    CircularProgressIndicator(strokeWidth: 2))
                          else
                            Icon(Icons.cloud_off,
                                color: theme.colorScheme.error),
                          const SizedBox(width: 12),
                          Expanded(
                              child: Text(_statusError == null
                                  ? 'Checking for class…'
                                  : 'Server unreachable: $_statusError\nPull down to retry.')),
                        ])
                      : !s.hasClass
                          ? Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                  Text('No class running right now',
                                      style: theme.textTheme.titleMedium),
                                  const SizedBox(height: 4),
                                  const Text(
                                      'Attendance starts automatically when your professor starts the class.'),
                                ])
                          : Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                  Text('${s.courseCode} · ${s.roomId}',
                                      style: theme.textTheme.labelLarge),
                                  const SizedBox(height: 6),
                                  Row(children: [
                                    Icon(_stateIcon(s.state),
                                        color: s.state == 'present'
                                            ? ok
                                            : theme.colorScheme.secondary,
                                        size: 28),
                                    const SizedBox(width: 8),
                                    Text(_stateText(s.state),
                                        style: theme.textTheme.titleLarge),
                                  ]),
                                  const SizedBox(height: 10),
                                  Text('Class started ${_fmtTime(s.startedAt)}'
                                      '${s.arrivalAt != null ? ' · you arrived ${_fmtTime(s.arrivalAt)}${s.late ? ' (late)' : ''}' : ''}'),
                                  if (s.presentSeconds > 0)
                                    Text(
                                        'Present ${s.presentSeconds ~/ 60} min'),
                                  if (s.lastSeen != null)
                                    Text(
                                        'Last verified ${_ago(s.lastSeen!, s.serverTime)}',
                                        style: theme.textTheme.bodySmall),
                                ]),
                ),
              ),
              const SizedBox(height: 16),
              Text('Attendance system', style: theme.textTheme.titleMedium),
              check('Account', widget.store.isLoggedIn,
                  detail: widget.store.email),
              if (Platform.isIOS) ...[
                check('Classroom beacon detection',
                    _beacon?.ranging == true && _beacon?.lastError == null,
                    detail: _beacon?.describe()),
                const Padding(
                  padding: EdgeInsets.only(left: 16, right: 16, top: 4),
                  child: Text(
                      'iPhones listen for the classroom\'s Bluetooth beacon instead of broadcasting. With Location set to "Always" (Settings → SmartClass), iOS keeps watching the room even when the phone is locked and reports when you leave or come back — no need to keep the app open.',
                      style: TextStyle(fontSize: 12)),
                ),
              ] else ...[
                check('Bluetooth advertising supported', _supported,
                    detail: _supported
                        ? null
                        : 'This device cannot act as a BLE peripheral'),
                check('Bluetooth permission', _permission,
                    detail: _permission ? null : 'Tap "Fix" below'),
                check('Broadcasting', ble.isRunning && ble.lastError == null,
                    detail: ble.lastError ??
                        (ble.currentTokenHex != null
                            ? 'token ${ble.currentTokenHex} (rotates every minute)'
                            : 'stopped')),
              ],
              const SizedBox(height: 12),
              Row(children: [
                if (Platform.isIOS)
                  FilledButton.icon(
                    onPressed: () async {
                      if (_beacon?.running == true) {
                        await _beacon!.stop();
                      } else {
                        await _beacon?.start();
                      }
                      setState(() {});
                    },
                    icon: Icon(
                        _beacon?.running == true ? Icons.stop : Icons.sensors),
                    label: Text(_beacon?.running == true
                        ? 'Stop detection'
                        : 'Start detection'),
                  )
                else ...[
                  if (!_permission)
                    OutlinedButton(
                        onPressed: () async {
                          _permission = await ble.requestPermission();
                          setState(() {});
                        },
                        child: const Text('Fix permission')),
                  if (!_permission) const SizedBox(width: 8),
                  FilledButton.icon(
                    onPressed: ble.isRunning ? ble.stop : _startBroadcast,
                    icon: Icon(ble.isRunning ? Icons.stop : Icons.bluetooth),
                    label: Text(ble.isRunning
                        ? 'Stop broadcasting'
                        : 'Start broadcasting'),
                  ),
                ],
              ]),
              const SizedBox(height: 24),
              Text('Privacy', style: theme.textTheme.titleMedium),
              const Text(
                  'Your phone broadcasts an anonymous code that changes every minute. Your name, student number and Bluetooth address are never sent over the air. Presence is only recorded during an active class you are enrolled in.'),
            ],
          ),
        ),
      ),
    );
  }

  static String _ago(int unix, int now) {
    final s = now - unix;
    if (s < 60) return '$s s ago';
    return '${s ~/ 60} min ago';
  }

  static IconData _stateIcon(String? state) => switch (state) {
        'present' => Icons.check_circle,
        'detected' => Icons.hourglass_top,
        'away' => Icons.directions_walk,
        'left' => Icons.logout,
        _ => Icons.radio_button_unchecked,
      };

  static String _stateText(String? state) => switch (state) {
        'present' => "You're in class",
        'detected' => 'Detected, confirming…',
        'away' => 'Temporarily away',
        'left' => 'Marked as left',
        _ => 'Waiting to be detected',
      };
}

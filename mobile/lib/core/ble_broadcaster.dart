import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_ble_peripheral/flutter_ble_peripheral.dart';

import 'token.dart';

/// Broadcasts the rotating SmartClass token as BLE manufacturer data and re-advertises at each
/// minute boundary. Android: works in foreground (M7 adds a foreground service for screen-off).
/// iOS: manufacturer data is not advertised by CoreBluetooth — iPhones use the reverse-beacon path (M8).
class BleBroadcaster extends ChangeNotifier {
  final FlutterBlePeripheral _ble = FlutterBlePeripheral();
  Timer? _rotate;
  String? _secret;
  int _clockOffsetMs = 0;
  bool _running = false;
  String? currentTokenHex;
  int? currentWindow;
  String? lastError;

  bool get isRunning => _running;

  Future<bool> hasPermission() async {
    final p = await _ble.hasPermission();
    return p == BluetoothPeripheralState.granted;
  }

  Future<bool> requestPermission() async {
    final p = await _ble.requestPermission();
    return p == BluetoothPeripheralState.granted;
  }

  Future<bool> isSupported() => _ble.isSupported;

  Future<void> start(String secretHex, {int clockOffsetMs = 0}) async {
    _secret = secretHex;
    _clockOffsetMs = clockOffsetMs;
    _running = true;
    lastError = null;
    await _advertiseCurrent();
    _scheduleRotation();
    notifyListeners();
  }

  Future<void> stop() async {
    _running = false;
    _rotate?.cancel();
    _rotate = null;
    try {
      await _ble.stop();
    } catch (_) {}
    currentTokenHex = null;
    notifyListeners();
  }

  int _nowMs() => DateTime.now().millisecondsSinceEpoch + _clockOffsetMs;

  void _scheduleRotation() {
    _rotate?.cancel();
    _rotate = Timer(Duration(milliseconds: SmartClassToken.msUntilNextWindow(_nowMs())), () async {
      if (!_running) return;
      await _advertiseCurrent();
      _scheduleRotation();
      notifyListeners();
    });
  }

  Future<void> _advertiseCurrent() async {
    final secret = _secret;
    if (secret == null) return;
    final window = SmartClassToken.windowFor(_nowMs());
    final Uint8List token = SmartClassToken.derive(secret, window);
    final payload = SmartClassToken.payload(token, foreground: true);
    try {
      if (await _ble.isAdvertising) await _ble.stop();
      await _ble.start(
        advertiseData: AdvertiseData(
          includeDeviceName: false,
          includePowerLevel: false,
          manufacturerId: SmartClassToken.companyId,
          manufacturerData: payload,
        ),
        advertiseSettings: AdvertiseSettings(
          advertiseMode: AdvertiseMode.advertiseModeLowLatency, // ~100 ms interval → ESP32 hears ~10 packets/s
          txPowerLevel: AdvertiseTxPower.advertiseTxPowerHigh,
          connectable: false,
          timeout: 0,
        ),
      );
      currentTokenHex = SmartClassToken.hex(token);
      currentWindow = window;
      lastError = null;
    } catch (e) {
      lastError = e.toString();
    }
  }

  @override
  void dispose() {
    _rotate?.cancel();
    super.dispose();
  }
}

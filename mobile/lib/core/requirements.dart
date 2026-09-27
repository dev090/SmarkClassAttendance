import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter_beacon/flutter_beacon.dart';
import 'package:permission_handler/permission_handler.dart' show openAppSettings;

import 'ble_broadcaster.dart';
import 'native_location.dart';

/// Things the app cannot work without. While one of these is missing the UI is blocked (see RequirementsGate).
enum Blocker {
  locationServicesOff,
  locationDenied,
  locationNotAlways,
  bluetoothOff,
  bluetoothUnauthorized,
  bluetoothPermission, // Android "Nearby devices"
}

/// Tracks the device settings SmartClass depends on and offers the actions to fix them.
///
/// iOS quirk that shapes this class: the beacon library answers "what is the permission?" through
/// callbacks that only fire when the state changes, so the getters reliably answer only the first
/// time per process. We query them with short timeouts, keep the last known value, and otherwise
/// rely on the change streams (which do fire when the user flips something in Settings).
class Requirements extends ChangeNotifier {
  final BleBroadcaster? android;
  Requirements({this.android});

  static const Duration _t = Duration(seconds: 3);
  static bool queriedOnce = false;

  bool locationServicesOn = true;
  /// iOS: from our own channel (always|whenInUse|denied|restricted|notDetermined); Android: from flutter_beacon
  AuthorizationStatus? location;
  /// true once iOS has been asked for Always (it shows that prompt at most once per install)
  bool askedAlways = false;
  BluetoothState? bluetooth;
  bool androidBlePermission = true;
  bool checking = false;
  StreamSubscription<AuthorizationStatus>? _authSub;
  StreamSubscription<BluetoothState>? _btSub;

  Future<void> start() async {
    _authSub ??= flutterBeacon.authorizationStatusChanged().listen((s) {
      debugPrint('[req] location -> ${s.value}');
      location = s;
      notifyListeners();
    });
    _btSub ??= flutterBeacon.bluetoothStateChanged().listen((s) {
      debugPrint('[req] bluetooth -> ${s.value}');
      bluetooth = s;
      notifyListeners();
    });
    await refresh();
  }

  Future<void> refresh() async {
    checking = true;
    notifyListeners();
    try {
      if (!queriedOnce) {
        try {
          // Never let the beacon library ask for Always itself: that makes iOS grant a silent provisional
          // Always and postpone the real "Always" prompt indefinitely. The app asks in two explicit steps.
          await flutterBeacon.setLocationAuthorizationTypeDefault(AuthorizationStatus.whenInUse);
          await flutterBeacon.initializeScanning.timeout(_t);
        } catch (e) {
          debugPrint('[req] init: $e');
        }
      }
      if (NativeLocation.available) {
        try {
          location = _fromNative(await NativeLocation.status().timeout(_t));
          locationServicesOn = await NativeLocation.servicesEnabled().timeout(_t);
        } catch (e) {
          debugPrint('[req] native location: $e');
        }
      } else {
        try {
          location = await flutterBeacon.authorizationStatus.timeout(_t);
        } catch (_) {}
        try {
          locationServicesOn = await flutterBeacon.checkLocationServicesIfEnabled.timeout(_t);
        } catch (_) {}
      }
      try {
        bluetooth = await flutterBeacon.bluetoothState.timeout(_t);
      } catch (_) {}
      if (Platform.isAndroid && android != null) {
        try {
          androidBlePermission = await android!.hasPermission();
        } catch (_) {}
      }
      queriedOnce = true;
      debugPrint('[req] services=$locationServicesOn location=${location?.value} bluetooth=${bluetooth?.value} blePerm=$androidBlePermission');
    } finally {
      checking = false;
      notifyListeners();
    }
  }

  Blocker? get blocker {
    if (!locationServicesOn) return Blocker.locationServicesOff;
    final l = location;
    if (l == AuthorizationStatus.denied || l == AuthorizationStatus.restricted || l == AuthorizationStatus.notDetermined) {
      return Blocker.locationDenied;
    }
    if (Platform.isIOS && l == AuthorizationStatus.whenInUse) return Blocker.locationNotAlways;
    final b = bluetooth;
    if (b == BluetoothState.stateUnauthorized) return Blocker.bluetoothUnauthorized;
    if (b == BluetoothState.stateOff || b == BluetoothState.stateTurningOff || b == BluetoothState.stateUnsupported) {
      return Blocker.bluetoothOff;
    }
    if (Platform.isAndroid && !androidBlePermission) return Blocker.bluetoothPermission;
    return null;
  }

  bool get satisfied => blocker == null;

  /// Step 1 (not determined): ask "While Using" — the only choice iOS offers in a first prompt.
  /// Step 2 (while using): ask Always — iOS then shows "Change to Always Allow?" (once per install).
  /// After a prompt we poll the status for up to 30 s, because the prompt is modal and the status flips
  /// the moment the user taps a choice.
  Future<void> requestLocation() async {
    final before = location;
    try {
      if (NativeLocation.available) {
        if (location == AuthorizationStatus.whenInUse) {
          askedAlways = true;
          await NativeLocation.requestAlways();
        } else {
          await NativeLocation.requestWhenInUse();
        }
      } else {
        await flutterBeacon.setLocationAuthorizationTypeDefault(AuthorizationStatus.always);
        await flutterBeacon.requestAuthorization.timeout(const Duration(seconds: 20));
      }
    } catch (e) {
      debugPrint('[req] request: $e');
    }
    for (var i = 0; i < 60; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 500));
      await refresh();
      if (location != before) break;
    }
    await refresh();
  }

  static AuthorizationStatus? _fromNative(String s) => switch (s) {
        'always' => AuthorizationStatus.always,
        'whenInUse' => AuthorizationStatus.whenInUse,
        'denied' => AuthorizationStatus.denied,
        'restricted' => AuthorizationStatus.restricted,
        'notDetermined' => AuthorizationStatus.notDetermined,
        _ => null,
      };

  Future<void> requestBluetoothPermission() async {
    if (android != null) await android!.requestPermission();
    await refresh();
  }

  Future<void> openSettings() async {
    if (NativeLocation.available) {
      await NativeLocation.openSettings();
    } else {
      await openAppSettings();
    }
  }

  @override
  void dispose() {
    _authSub?.cancel();
    _btSub?.cancel();
    super.dispose();
  }
}

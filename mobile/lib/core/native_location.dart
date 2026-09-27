import 'dart:io' show Platform;

import 'package:flutter/services.dart';

/// iOS location permission, driven by the app itself (see ios/Runner/AppDelegate.swift).
/// The status getter is synchronous on the native side, so it never hangs.
class NativeLocation {
  static const _ch = MethodChannel('smartclass/location');
  static bool get available => Platform.isIOS;

  /// always | whenInUse | denied | restricted | notDetermined | unknown
  static Future<String> status() async => (await _ch.invokeMethod<String>('status')) ?? 'unknown';
  static Future<bool> servicesEnabled() async => (await _ch.invokeMethod<bool>('servicesEnabled')) ?? true;
  static Future<void> requestWhenInUse() => _ch.invokeMethod<bool>('requestWhenInUse');
  static Future<void> requestAlways() => _ch.invokeMethod<bool>('requestAlways');
  static Future<void> openSettings() => _ch.invokeMethod<bool>('openSettings');
}

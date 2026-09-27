#!/usr/bin/env python3
"""Adds the Bluetooth/network permissions SmartClass needs after `flutter create .`.
Idempotent: safe to run again."""
import pathlib, re, sys

root = pathlib.Path(__file__).resolve().parents[1]

# ---------- Android ----------
manifest = root / 'android/app/src/main/AndroidManifest.xml'
if manifest.exists():
    s = manifest.read_text()
    perms = '''
    <!-- SmartClass: BLE advertising + LAN backend over plain HTTP -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />
    <uses-feature android:name="android.hardware.bluetooth_le" android:required="true" />
'''
    if 'BLUETOOTH_ADVERTISE' not in s:
        s = s.replace('<application', perms + '    <application', 1)
    if 'usesCleartextTraffic' not in s:
        s = s.replace('<application', '<application\n        android:usesCleartextTraffic="true"', 1)
    manifest.write_text(s)
    print('patched', manifest.relative_to(root))
    gradle = root / 'android/app/build.gradle.kts'
    if not gradle.exists():
        gradle = root / 'android/app/build.gradle'
    if gradle.exists():
        g = gradle.read_text()
        g2 = re.sub(r'minSdk\s*=\s*flutter\.minSdkVersion', 'minSdk = 23', g)
        g2 = re.sub(r'minSdkVersion\s+flutter\.minSdkVersion', 'minSdkVersion 23', g2)
        if g2 != g:
            gradle.write_text(g2)
            print('patched minSdk=23 in', gradle.relative_to(root))
else:
    print('android manifest not found — run `flutter create .` first', file=sys.stderr)

# ---------- iOS ----------
plist = root / 'ios/Runner/Info.plist'
if plist.exists():
    p = plist.read_text()
    add = ''
    if 'NSBluetoothAlwaysUsageDescription' not in p:
        add += '''
	<key>NSBluetoothAlwaysUsageDescription</key>
	<string>SmartClass uses Bluetooth to confirm you are in the classroom.</string>
	<key>NSBluetoothPeripheralUsageDescription</key>
	<string>SmartClass broadcasts an anonymous attendance code.</string>
	<key>NSLocationWhenInUseUsageDescription</key>
	<string>Needed to detect the classroom beacon.</string>
	<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
	<string>Needed to detect the classroom beacon while the app is in the background.</string>
	<key>UIBackgroundModes</key>
	<array>
		<string>bluetooth-peripheral</string>
		<string>bluetooth-central</string>
		<string>location</string>
	</array>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key>
		<true/>
	</dict>'''
    if add:
        p = p.replace('</dict>\n</plist>', add + '\n</dict>\n</plist>')
        plist.write_text(p)
        print('patched', plist.relative_to(root))
else:
    print('ios Info.plist not found — run `flutter create .` first', file=sys.stderr)

#!/usr/bin/env bash
# One-time setup: generates the android/ and ios/ platform folders around the Dart code in lib/,
# then patches the permissions SmartClass needs. Requires the Flutter SDK (https://docs.flutter.dev/get-started/install).
set -euo pipefail
cd "$(dirname "$0")"
flutter create . --org ca.unb.smartclass --project-name smartclass_app --platforms=android,ios
python3 platform/patch_platforms.py
flutter pub get
echo
echo "Done. Plug in an Android phone with USB debugging on, then:  flutter run"

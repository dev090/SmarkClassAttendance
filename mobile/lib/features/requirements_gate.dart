import 'dart:io' show Platform;

import 'package:flutter/material.dart';

import '../core/requirements.dart';

/// Blocks the screen underneath until every required setting is granted, explaining each one in plain words.
class RequirementsGate extends StatelessWidget {
  final Requirements req;
  final Widget child;
  const RequirementsGate({super.key, required this.req, required this.child});

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: req,
      builder: (context, _) {
        final b = req.blocker;
        return Stack(
          children: [
            child,
            if (b != null) ...[
              const ModalBarrier(dismissible: false, color: Colors.black54),
              Center(child: _card(context, b)),
            ],
          ],
        );
      },
    );
  }

  Widget _card(BuildContext context, Blocker b) {
    final theme = Theme.of(context);
    late final IconData icon;
    late final String title;
    late final String body;
    String? steps;
    final actions = <Widget>[];

    switch (b) {
      case Blocker.locationServicesOff:
        icon = Icons.location_off;
        title = 'Turn on Location Services';
        body = 'SmartClass uses location for one thing only: to hear the classroom\'s Bluetooth beacon. Location Services are switched off for the whole phone right now.';
        steps = Platform.isIOS ? 'Settings → Privacy & Security → Location Services → On' : 'Settings → Location → On';
        actions.add(FilledButton(onPressed: req.openSettings, child: const Text('Open Settings')));
      case Blocker.locationDenied:
        icon = Icons.my_location;
        title = 'Allow location for SmartClass';
        body = 'Your attendance is marked when the phone hears the classroom\'s Bluetooth beacon. On this phone that counts as "location", so the app needs your permission. It never records where you go.';
        steps = Platform.isIOS ? 'If no prompt appears: Settings → SmartClass → Location → Always' : 'If no prompt appears: Settings → Apps → SmartClass → Permissions → Location';
        actions.add(FilledButton(onPressed: req.requestLocation, child: const Text('Allow location')));
        actions.add(OutlinedButton(onPressed: req.openSettings, child: const Text('Open Settings')));
      case Blocker.locationNotAlways:
        icon = Icons.all_inclusive;
        title = 'Choose "Always" for location';
        body = 'You allowed location while using the app. To mark you present when you walk into class and away when you leave — with the phone in your pocket, without opening the app each time — iOS needs "Always". Tap the button and choose "Change to Always Allow" in the iPhone prompt.';
        steps = req.askedAlways
            ? 'No prompt? iPhone only shows it once. Then: Settings → SmartClass → Location → Always'
            : 'Settings → SmartClass → Location → Always';
        actions.add(FilledButton(onPressed: req.requestLocation, child: const Text('Allow Always')));
        actions.add(OutlinedButton(onPressed: req.openSettings, child: const Text('Open Settings')));
      case Blocker.bluetoothOff:
        icon = Icons.bluetooth_disabled;
        title = 'Turn on Bluetooth';
        body = 'The classroom beacon is Bluetooth, so the phone must be able to listen. Bluetooth is off right now.';
        steps = Platform.isIOS ? 'Settings → Bluetooth → On (the Control Centre button only pauses it until tomorrow)' : 'Quick settings → Bluetooth → On';
        actions.add(FilledButton(onPressed: req.openSettings, child: const Text('Open Settings')));
      case Blocker.bluetoothUnauthorized:
        icon = Icons.bluetooth_disabled;
        title = 'Allow Bluetooth for SmartClass';
        body = 'Bluetooth access for this app was turned off. Without it the phone cannot hear the classroom beacon.';
        steps = 'Settings → SmartClass → Bluetooth → On';
        actions.add(FilledButton(onPressed: req.openSettings, child: const Text('Open Settings')));
      case Blocker.bluetoothPermission:
        icon = Icons.bluetooth_searching;
        title = 'Allow "Nearby devices"';
        body = 'Android needs the Nearby devices permission so the app can broadcast its attendance signal to the classroom scanner.';
        actions.add(FilledButton(onPressed: req.requestBluetoothPermission, child: const Text('Allow')));
        actions.add(OutlinedButton(onPressed: req.openSettings, child: const Text('Open Settings')));
    }

    return Card(
      margin: const EdgeInsets.all(24),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Icon(icon, size: 40, color: theme.colorScheme.primary),
            const SizedBox(height: 12),
            Text(title, style: theme.textTheme.titleLarge, textAlign: TextAlign.center),
            const SizedBox(height: 8),
            Text(body, style: theme.textTheme.bodyMedium),
            if (steps != null) ...[
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(8)),
                child: Text(steps, style: theme.textTheme.bodySmall),
              ),
            ],
            const SizedBox(height: 16),
            ...actions.map((a) => Padding(padding: const EdgeInsets.only(bottom: 8), child: a)),
            TextButton(
              onPressed: req.checking ? null : req.refresh,
              child: Text(req.checking ? 'Checking…' : 'I\'ve done it — check again'),
            ),
            Text('Required to use SmartClass. The app never records your movements; it only notices the classroom beacon.',
                style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline), textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';

import 'core/ble_broadcaster.dart';
import 'core/session_store.dart';
import 'features/home_screen.dart';
import 'features/login_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const SmartClassApp());
}

class SmartClassApp extends StatefulWidget {
  const SmartClassApp({super.key});
  @override
  State<SmartClassApp> createState() => _SmartClassAppState();
}

class _SmartClassAppState extends State<SmartClassApp> {
  SessionStore? _store;
  final BleBroadcaster _ble = BleBroadcaster();

  @override
  void initState() {
    super.initState();
    SessionStore.load().then((s) => setState(() => _store = s));
  }

  @override
  Widget build(BuildContext context) {
    final store = _store;
    return MaterialApp(
      title: 'SmartClass',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: const Color(0xFF2A78D6), useMaterial3: true),
      darkTheme: ThemeData(colorSchemeSeed: const Color(0xFF3987E5), brightness: Brightness.dark, useMaterial3: true),
      home: store == null
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : store.isLoggedIn
              ? HomeScreen(
                  store: store,
                  ble: _ble,
                  onSignOut: () async {
                    await _ble.stop();
                    await store.clear();
                    setState(() {});
                  },
                )
              : LoginScreen(store: store, onLoggedIn: () => setState(() {})),
    );
  }
}

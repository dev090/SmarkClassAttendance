import 'dart:io' show Platform;

import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/app_config.dart';
import '../core/session_store.dart';

class LoginScreen extends StatefulWidget {
  final SessionStore store;
  final VoidCallback onLoggedIn;
  const LoginScreen({super.key, required this.store, required this.onLoggedIn});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  // Always prefill the current public server address; a stale LAN address saved earlier is replaced.
  late final TextEditingController _server = TextEditingController(
    text: widget.store.serverUrl.startsWith('http://') ? kDefaultServerUrl : widget.store.serverUrl,
  );
  final _email = TextEditingController(text: 'devansh@unb.ca');
  final _password = TextEditingController(text: 'password');
  String? _error;
  bool _busy = false;

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.store.setServerUrl(_server.text);
      _server.text = widget.store.serverUrl; // show the normalised form (scheme added, spaces removed)
      final api = SmartClassApi(widget.store.serverUrl);
      final deviceId = await widget.store.deviceId();
      final platform = Platform.isIOS ? 'ios' : 'android';
      final t0 = DateTime.now().millisecondsSinceEpoch;
      final r = await api.login(_email.text.trim(), _password.text, deviceId: deviceId, platform: platform);
      // clock offset = server − phone (server time is in seconds; assume the request took ~half the round trip)
      final rtt = DateTime.now().millisecondsSinceEpoch - t0;
      await widget.store.setClockOffset(r.serverTime * 1000 + rtt ~/ 2 - DateTime.now().millisecondsSinceEpoch);
      await widget.store.saveLogin(token: r.token, secret: r.secret, name: r.name, email: r.email, roomMajors: r.roomMajors);
      widget.onLoggedIn();
    } catch (e) {
      setState(() => _error = e is ApiException
          ? e.message
          : 'Could not reach the server at ${widget.store.serverUrl}.\nCheck the address (it must start with https://) and that the phone has internet.\n$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Icon(Icons.bluetooth_searching, size: 56),
                const SizedBox(height: 8),
                Text('SmartClass', textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineMedium),
                const SizedBox(height: 4),
                Text('Automatic attendance. Nothing to scan, nothing to tap.', textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium),
                const SizedBox(height: 24),
                TextField(controller: _server, decoration: const InputDecoration(labelText: 'Server URL', hintText: kDefaultServerUrl, prefixIcon: Icon(Icons.dns_outlined)), keyboardType: TextInputType.url, autocorrect: false),
                const SizedBox(height: 12),
                TextField(controller: _email, decoration: const InputDecoration(labelText: 'University email', prefixIcon: Icon(Icons.mail_outline)), keyboardType: TextInputType.emailAddress, autocorrect: false),
                const SizedBox(height: 12),
                TextField(controller: _password, decoration: const InputDecoration(labelText: 'Password', prefixIcon: Icon(Icons.lock_outline)), obscureText: true, onSubmitted: (_) => _submit()),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                ],
                const SizedBox(height: 20),
                FilledButton(onPressed: _busy ? null : _submit, child: Text(_busy ? 'Signing in…' : 'Sign in')),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

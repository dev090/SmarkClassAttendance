import 'dart:convert';

import 'package:http/http.dart' as http;

class ApiException implements Exception {
  final int status;
  final String message;
  ApiException(this.status, this.message);
  @override
  String toString() => message;
}

class LoginResult {
  final String token;
  final String secret;
  final String name;
  final String email;
  final int serverTime;
  final bool deviceMigrated;
  final List<String> courses;
  /// iBeacon majors of the rooms of the student's courses (one background region per room)
  final List<int> roomMajors;
  LoginResult(this.token, this.secret, this.name, this.email, this.serverTime, this.deviceMigrated, this.courses, this.roomMajors);
}

class ClassStatus {
  final String? courseCode;
  final String? courseName;
  final String? roomId;
  final int? startedAt;
  final String? state; // unknown|detected|present|away|left
  final int? arrivalAt;
  final int? lastSeen;
  final int presentSeconds;
  final bool late;
  final int serverTime;
  ClassStatus({this.courseCode, this.courseName, this.roomId, this.startedAt, this.state, this.arrivalAt, this.lastSeen, this.presentSeconds = 0, this.late = false, required this.serverTime});
  bool get hasClass => courseCode != null;
}

/// Thin client for the SmartClass backend (see docs/04-api.md).
class SmartClassApi {
  final String baseUrl;
  final String? token;
  /// One client per instance keeps the HTTPS connection alive (saves a TLS handshake per request on cellular).
  final http.Client _client = http.Client();
  SmartClassApi(this.baseUrl, {this.token});

  void close() => _client.close();

  Map<String, String> get _headers => {
        'content-type': 'application/json',
        if (token != null) 'authorization': 'Bearer $token',
      };

  Future<Map<String, dynamic>> _json(http.Response r) async {
    final body = r.body.isEmpty ? <String, dynamic>{} : jsonDecode(r.body) as Map<String, dynamic>;
    if (r.statusCode >= 400) throw ApiException(r.statusCode, (body['error'] ?? 'HTTP ${r.statusCode}').toString());
    return body;
  }

  Future<int> serverTime() async {
    final r = await _client.get(Uri.parse('$baseUrl/api/v1/time')).timeout(const Duration(seconds: 6));
    return ((await _json(r))['now'] as num).toInt();
  }

  Future<LoginResult> login(String email, String password, {required String deviceId, required String platform}) async {
    final r = await _client
        .post(Uri.parse('$baseUrl/api/v1/auth/login'), headers: _headers, body: jsonEncode({'email': email, 'password': password, 'deviceId': deviceId, 'platform': platform}))
        .timeout(const Duration(seconds: 12));
    final j = await _json(r);
    if (j['secret'] == null) throw ApiException(403, 'This account is not a student account.');
    final user = j['user'] as Map<String, dynamic>;
    final courseList = (j['courses'] as List<dynamic>).cast<Map<String, dynamic>>();
    final courses = courseList.map((c) => c['code'].toString()).toList();
    final majors = courseList.map((c) => (c['beaconMajor'] as num?)?.toInt()).whereType<int>().toSet().toList();
    return LoginResult(j['token'] as String, j['secret'] as String, user['name'] as String, user['email'] as String, (j['serverTime'] as num).toInt(), j['deviceMigrated'] == true, courses, majors);
  }

  /// [beacon] is the app's beacon status line; the backend logs it so the team can debug phones remotely.
  Future<ClassStatus> status({String? beacon}) async {
    final uri = Uri.parse('$baseUrl/api/v1/me/status').replace(queryParameters: beacon == null ? null : {'beacon': beacon});
    final r = await _client.get(uri, headers: _headers).timeout(const Duration(seconds: 6));
    final j = await _json(r);
    final s = j['activeSession'] as Map<String, dynamic>?;
    final a = j['attendance'] as Map<String, dynamic>?;
    return ClassStatus(
      courseCode: s?['courseCode'] as String?,
      courseName: s?['courseName'] as String?,
      roomId: s?['roomId'] as String?,
      startedAt: (s?['startedAt'] as num?)?.toInt(),
      state: a?['state'] as String?,
      arrivalAt: (a?['arrivalAt'] as num?)?.toInt(),
      lastSeen: (a?['lastSeen'] as num?)?.toInt(),
      presentSeconds: (a?['presentSeconds'] as num?)?.toInt() ?? 0,
      late: a?['late'] == true,
      serverTime: (j['serverTime'] as num).toInt(),
    );
  }
}

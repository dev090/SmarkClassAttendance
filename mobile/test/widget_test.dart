import 'package:flutter_test/flutter_test.dart';
import 'package:smartclass_app/core/token.dart';

void main() {
  test('token derivation matches the backend/firmware layout', () {
    final secret = 'ab' * 32;
    final t1 = SmartClassToken.derive(secret, 1000);
    final t2 = SmartClassToken.derive(secret, 1000);
    final t3 = SmartClassToken.derive(secret, 1001);
    expect(t1.length, 8);
    expect(SmartClassToken.hex(t1), SmartClassToken.hex(t2));
    expect(SmartClassToken.hex(t1), isNot(SmartClassToken.hex(t3)));
    final payload = SmartClassToken.payload(t1, foreground: true);
    expect(payload.length, 12);
    expect(payload.sublist(0, 3), [0x53, 0x43, 0x01]); // 'S' 'C' version
    expect(payload.last & 0x02, 0x02); // foreground flag
  });

  test('window math', () {
    expect(SmartClassToken.windowFor(120000), 2);
    expect(SmartClassToken.msUntilNextWindow(119000), 1000 + 400);
  });
}

/// Build-time defaults. Override at build time with
///   flutter run --dart-define=SMARTCLASS_SERVER=https://your-host
/// Until the backend has a fixed public address, this is the current Cloudflare tunnel URL.
const String kDefaultServerUrl = String.fromEnvironment(
  'SMARTCLASS_SERVER',
  defaultValue: 'https://whale-pleased-wishlist-prisoners.trycloudflare.com',
);

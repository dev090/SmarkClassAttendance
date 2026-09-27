import CoreLocation
import Flutter
import UIKit

/// SmartClass: while the app is in the background we keep it alive with a very low-power location
/// subscription (3 km accuracy, no distance filtering), so beacon ranging keeps delivering with the
/// screen off and "left the room" can be reported within seconds instead of iOS's ~30 s region exit.
/// Requires the "location" background mode (Info.plist) and Location "Always" (enforced by the app).
@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate, CLLocationManagerDelegate {
  private var keepAlive: CLLocationManager?
  /// Used for the permission prompts. Must be retained while a prompt is showing.
  private lazy var permissionManager: CLLocationManager = {
    let m = CLLocationManager()
    m.delegate = self
    return m
  }()

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    // SmartClass's own location-permission channel: iOS only shows the "Change to Always Allow?" prompt
    // when Always is requested AFTER "While Using" was granted, so the app drives the two steps itself.
    let messenger = engineBridge.pluginRegistry.registrar(forPlugin: "SmartClassLocation")!.messenger()
    let channel = FlutterMethodChannel(name: "smartclass/location", binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self = self else { return }
      switch call.method {
      case "status":
        result(Self.describe(self.permissionManager.authorizationStatus))
      case "servicesEnabled":
        result(CLLocationManager.locationServicesEnabled())
      case "requestWhenInUse":
        self.permissionManager.requestWhenInUseAuthorization()
        result(true)
      case "requestAlways":
        self.permissionManager.requestAlwaysAuthorization()
        result(true)
      case "openSettings":
        if let url = URL(string: UIApplication.openSettingsURLString) {
          UIApplication.shared.open(url)
        }
        result(true)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private static func describe(_ s: CLAuthorizationStatus) -> String {
    switch s {
    case .authorizedAlways: return "always"
    case .authorizedWhenInUse: return "whenInUse"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    // status changes are picked up by the Dart side polling `status`; nothing to do here
  }

  override func applicationDidEnterBackground(_ application: UIApplication) {
    super.applicationDidEnterBackground(application)
    startKeepAlive()
  }

  override func applicationWillEnterForeground(_ application: UIApplication) {
    super.applicationWillEnterForeground(application)
    stopKeepAlive()
  }

  private func startKeepAlive() {
    let status = CLLocationManager().authorizationStatus
    guard status == .authorizedAlways else { return }  // without Always iOS would stop us anyway
    if keepAlive == nil {
      let m = CLLocationManager()
      m.delegate = self
      m.desiredAccuracy = kCLLocationAccuracyThreeKilometers  // cell-tower level: very low power
      m.distanceFilter = kCLDistanceFilterNone  // keep the session actively delivering so iOS never suspends us
      m.pausesLocationUpdatesAutomatically = false
      m.allowsBackgroundLocationUpdates = true
      m.showsBackgroundLocationIndicator = false
      keepAlive = m
    }
    keepAlive?.startUpdatingLocation()
  }

  private func stopKeepAlive() {
    keepAlive?.stopUpdatingLocation()
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    // Intentionally ignored: we never store or use the position; the subscription only keeps the app awake.
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}

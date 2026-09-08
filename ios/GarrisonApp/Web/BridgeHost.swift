import SwiftUI
import UIKit

/// SwiftUI seat for the Capacitor bridge. The bridge fixes serverURL when it
/// is created, so a node switch is not a reload: GarrisonApp changes this
/// view's `.id(...)` and SwiftUI builds a fresh controller with a fresh bridge.
/// Nothing is pushed in through updateUIViewController for the same reason.
struct BridgeHost: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> GarrisonBridgeViewController {
        GarrisonBridgeViewController()
    }

    func updateUIViewController(_ uiViewController: GarrisonBridgeViewController, context: Context) {}
}

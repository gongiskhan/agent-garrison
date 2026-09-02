import ReplayKit
import SwiftUI

/// SwiftUI wrapper around RPSystemBroadcastPickerView. `preferredExtension`
/// targets our broadcast upload extension directly and the microphone button
/// is shown - mic sample buffers only arrive when the user flips it on in
/// the system sheet.
struct BroadcastPicker: UIViewRepresentable {
    static let extensionBundleID = "com.gomes.garrison.broadcast"

    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 60, height: 60))
        picker.preferredExtension = Self.extensionBundleID
        picker.showsMicrophoneButton = true
        return picker
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}

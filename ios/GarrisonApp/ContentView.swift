import SwiftUI

// M0 skeleton. The real surface (start/stop capture, mode selection, consent
// sheet, settings, sessions, ack log) lands at M6.
struct ContentView: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                Image(systemName: "waveform.circle")
                    .font(.system(size: 56))
                    .foregroundStyle(.secondary)
                Text("Garrison Companion")
                    .font(.title2.weight(.semibold))
                Text("Session capture arrives in a later build.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .navigationTitle("Garrison")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

#Preview {
    ContentView()
}

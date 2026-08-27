import SwiftUI

/// The consent notice shown before capture starts (spec §1, invariant I6).
/// The exact copy is part of the contract; "Don't ask me again" persists and
/// the session's consent state ("shown" / "suppressed") travels in the
/// capture event's provenance either way.
struct ConsentSheet: View {
    let onProceed: (ConsentState) -> Void
    let onCancel: () -> Void
    @State private var dontAskAgain = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Label("Before you record", systemImage: "person.2.wave.2")
                    .font(.title3.weight(.semibold))
                Text("If you have people around, always ask for consent.")
                    .font(.body)
                Toggle("Don't ask me again", isOn: $dontAskAgain)
                Spacer()
                Button {
                    if dontAskAgain { AppGroup.consentSuppressed = true }
                    onProceed(.shown)
                } label: {
                    Text("Start recording")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            .padding()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

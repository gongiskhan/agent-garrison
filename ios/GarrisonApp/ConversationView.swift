import SwiftUI

/// One wake exchange as the transcript endpoint serves it: the user's words,
/// what Zeca decided, what he said back (FULL text - the push banner is a
/// preview, this is the record), how it was delivered, and every follow-up
/// round of a clarifying-question dialogue threaded under it.
struct Exchange: Codable, Identifiable {
    struct Followup: Codable, Identifiable {
        let round: Int
        let at: String?
        let request: String?
        let reply: String
        let ok: Bool
        var id: Int { round }
    }

    let id: String
    let at: String?
    let command: String
    let intent: String?
    let confirmation: String?
    let lang: String?
    let cardId: String?
    let cardUrl: String?
    let delivery: String?
    let followups: [Followup]
}

struct ExchangesResponse: Codable {
    let exchanges: [Exchange]
}

/// Fetches the transcript from the capture-service. Plain URLSession against
/// the same base URL + bearer the capture stream uses - nothing new to
/// configure.
@MainActor
final class ConversationModel: ObservableObject {
    @Published var exchanges: [Exchange] = []
    @Published var error: String?
    @Published var loaded = false
    private var timer: Timer?

    func start() {
        refresh()
        // The transcript moves while a command is being worked (ack ~2s, the
        // real answer up to a minute later), so poll gently while visible.
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func refresh() {
        guard let request = AppGroup.request(path: "/capture/exchanges") else {
            error = "Set the capture URL and token in Settings first."
            loaded = true
            return
        }
        URLSession.shared.dataTask(with: request) { [weak self] data, response, err in
            Task { @MainActor in
                guard let self else { return }
                self.loaded = true
                if let err {
                    self.error = err.localizedDescription
                    return
                }
                guard (response as? HTTPURLResponse)?.statusCode == 200, let data else {
                    self.error = "Service answered \((response as? HTTPURLResponse)?.statusCode ?? 0)."
                    return
                }
                guard let decoded = try? JSONDecoder().decode(ExchangesResponse.self, from: data) else {
                    self.error = "Could not read the transcript."
                    return
                }
                self.error = nil
                // A failed refresh must never blank a transcript the user is
                // reading, so errors above return without touching this.
                self.exchanges = decoded.exchanges.filter { !$0.command.isEmpty || $0.confirmation != nil }
            }
        }.resume()
    }
}

/// The conversation with Zeca, as a chat transcript: what you said on the
/// right, what Zeca answered on the left, follow-up rounds threaded in order.
struct ConversationView: View {
    @StateObject private var model = ConversationModel()

    var body: some View {
        Group {
            if let error = model.error, model.exchanges.isEmpty {
                ContentUnavailableView {
                    Label("No conversation yet", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text(error)
                }
            } else if model.loaded && model.exchanges.isEmpty {
                ContentUnavailableView {
                    Label("No conversation yet", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Say \u{201C}Zeca\u{201D} to the pendant and the exchange lands here.")
                }
            } else {
                List(model.exchanges) { exchange in
                    ExchangeRow(exchange: exchange)
                        .listRowSeparator(.hidden)
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Conversation")
        .refreshable { model.refresh() }
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }
}

private struct ExchangeRow: View {
    let exchange: Exchange

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // The user's words, right-aligned - a chat, not a log.
            HStack {
                Spacer(minLength: 40)
                Text(exchange.command)
                    .padding(10)
                    .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 14))
            }

            if let confirmation = exchange.confirmation, !confirmation.isEmpty {
                reply(confirmation, delivery: exchange.delivery)
            }

            ForEach(exchange.followups) { followup in
                if let request = followup.request, followup.round > 0 {
                    HStack {
                        Spacer(minLength: 40)
                        Text(request)
                            .padding(10)
                            .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 14))
                    }
                }
                if !followup.reply.isEmpty {
                    reply(followup.reply, delivery: nil)
                }
            }

            HStack(spacing: 8) {
                if let intent = exchange.intent {
                    Text(intentLabel(intent))
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
                if let at = exchange.at, let date = ISO8601DateFormatter.cached.date(from: at) {
                    Text(date.formatted(.relative(presentation: .named)))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let cardUrl = exchange.cardUrl, let url = URL(string: cardUrl) {
                    Link("Open card", destination: url)
                        .font(.caption2)
                }
            }
        }
        .padding(.vertical, 6)
    }

    // Zeca's reply, left-aligned, NEVER truncated - the whole point of this
    // screen is the text the banner cut off.
    @ViewBuilder private func reply(_ text: String, delivery: String?) -> some View {
        HStack(alignment: .bottom, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                Text(text)
                    .padding(10)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
                    .textSelection(.enabled)
            }
            if delivery == "spoken" {
                Image(systemName: "speaker.wave.2.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if delivery == "push" {
                Image(systemName: "bell.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 40)
        }
    }

    private func intentLabel(_ intent: String) -> String {
        switch intent {
        case "create_task": return "task"
        case "create_event": return "event"
        case "card_command": return "card"
        case "delegate", "delegate_blocked": return "Zeca"
        case "query": return "answer"
        case "note": return "note"
        case "discuss": return "discussion"
        case "send_message": return "message"
        case "automate": return "automation"
        case "note_fallback": return "saved as note"
        case "discarded": return "discarded"
        default: return intent
        }
    }
}

extension ISO8601DateFormatter {
    static let cached: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

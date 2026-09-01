import SwiftUI

/// Recent capture sessions from the service's authed read API, each linking
/// to the fitting's own transcript view in the browser (the page is the
/// canonical surface; the app does not re-render transcripts).
struct SessionsView: View {
    struct SessionRow: Identifiable, Decodable {
        let id: String
        let mode: String
        let status: String
        let startedAt: String?
        let ended: Ended?

        struct Ended: Decodable { let reason: String? }

        enum CodingKeys: String, CodingKey {
            case id, mode, status, ended
            case startedAt = "started_at"
        }
    }

    @State private var sessions: [SessionRow] = []
    @State private var status: String?

    var body: some View {
        List {
            // The raw delivery record (every ack and push the phone received),
            // demoted from the front door: the Conversation screen is the
            // product surface, this is the debug one.
            NavigationLink("Delivery log") { AckLogView() }
            if let status {
                Text(status).font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(sessions) { session in
                if let link = sessionLink(session.id) {
                    Link(destination: link) { row(session) }
                } else {
                    row(session)
                }
            }
        }
        .navigationTitle("Sessions")
        .task { await reload() }
        .refreshable { await reload() }
    }

    private func row(_ session: SessionRow) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(session.id).font(.footnote.monospaced())
            HStack {
                Text(session.mode)
                Text(session.status == "live" ? "live" : (session.ended?.reason ?? "ended"))
                    .foregroundStyle(session.status == "live" ? .green : .secondary)
                if let startedAt = session.startedAt {
                    Text(startedAt).lineLimit(1)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private func sessionLink(_ id: String) -> URL? {
        guard let base = AppGroup.baseURL else { return nil }
        return base.appendingPathComponent("sessions").appendingPathComponent(id)
    }

    private func reload() async {
        guard let request = AppGroup.request(path: "/capture/sessions") else {
            status = "Set the base URL and token in Settings."
            return
        }
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            struct Body: Decodable { let sessions: [SessionRow] }
            sessions = try JSONDecoder().decode(Body.self, from: data).sessions
            status = sessions.isEmpty ? "No sessions yet." : nil
        } catch {
            status = "Could not load sessions: \(error.localizedDescription)"
        }
    }
}

/// The local ack/notification log (spec §5c) — what the operator scrolls
/// when they felt a buzz and missed it. Full text, newest first.
struct AckLogView: View {
    @State private var entries: [AckLogEntry] = []

    var body: some View {
        List(entries) { entry in
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.text)
                HStack {
                    Text(entry.via)
                    if let kind = entry.kind { Text(kind) }
                    Text(entry.at.formatted(date: .abbreviated, time: .shortened))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Delivery log")
        .onAppear { entries = AckLog.shared.entries() }
        .refreshable { entries = AckLog.shared.entries() }
    }
}

import XCTest
@testable import GarrisonApp

/// The device haptic tier vocabulary (ADR D4): every feedback event maps to
/// a pattern composed from the three fixed firmware levels, and the two
/// tiers the brief requires to stay distinguishable - window_closed and
/// task_created - genuinely are.
///
/// PendantController is @MainActor, so its static pattern table inherits
/// that isolation; the test case adopts it rather than the shipping type
/// weakening to nonisolated.
@MainActor
final class PendantFeedbackMappingTests: XCTestCase {
    func testEveryTierHasAPattern() {
        for name in ["wake_detected", "wake_lapsed", "segment_captured", "window_closed", "task_created", "task_failed"] {
            XCTAssertFalse(PendantController.hapticPattern(for: name).isEmpty, name)
        }
        XCTAssertTrue(PendantController.hapticPattern(for: "unknown_event").isEmpty)
    }

    /// A wake pulse fires off an unstable Deepgram interim, so it can be wrong:
    /// when the final drops the name no capture window opens, and the wearer -
    /// who already felt the promise - dictates a task into nothing. wake_lapsed
    /// is the retraction, and it is only useful if the wrist can TELL it apart
    /// from the pulse it retracts and from every other tier.
    func testWakeLapsedIsDistinctFromEveryOtherTier() {
        let lapsed = PendantController.hapticPattern(for: "wake_lapsed")
        XCTAssertEqual(lapsed.map(\.level), [.short, .short])
        for other in ["wake_detected", "segment_captured", "window_closed", "task_created", "task_failed"] {
            let pattern = PendantController.hapticPattern(for: other)
            XCTAssertFalse(
                pattern.map(\.level) == lapsed.map(\.level) && pattern.map(\.delayMs) == lapsed.map(\.delayMs),
                "wake_lapsed collides with \(other)"
            )
        }
        // Same tier as the pulse it retracts (both short) but a different
        // count; window_closed is a different tier entirely.
        XCTAssertEqual(PendantController.hapticPattern(for: "wake_detected").map(\.level), [.short])
        XCTAssertNotEqual(PendantController.hapticPattern(for: "window_closed").map(\.level), lapsed.map(\.level))
    }

    /// segment_captured used to be byte-identical to wake_detected, and it is
    /// the one buzz that fires mid-sentence - precisely when a stray single
    /// short reads as a fresh wake.
    func testSegmentCapturedIsNotMistakableForAWake() {
        let captured = PendantController.hapticPattern(for: "segment_captured")
        let wake = PendantController.hapticPattern(for: "wake_detected")
        XCTAssertNotEqual(captured.map(\.level), wake.map(\.level))
        XCTAssertNotEqual(captured.map(\.delayMs), PendantController.hapticPattern(for: "wake_lapsed").map(\.delayMs))
    }

    func testWindowClosedAndTaskCreatedAreDistinguishable() {
        let closed = PendantController.hapticPattern(for: "window_closed")
        let created = PendantController.hapticPattern(for: "task_created")
        XCTAssertEqual(closed.map(\.level), [.medium, .medium])
        XCTAssertEqual(created.map(\.level), [.long])
        XCTAssertNotEqual(closed.map(\.level), created.map(\.level))
        XCTAssertNotEqual(closed.count, created.count)
    }

    func testFailureIsALowTriple() {
        let failed = PendantController.hapticPattern(for: "task_failed")
        XCTAssertEqual(failed.map(\.level), [.medium, .medium, .medium])
        XCTAssertEqual(failed.count, 3)
    }

    // The pendant must outlive the screen. It used to be a @StateObject inside
    // a SwiftUI view, so navigating away tore it down - BLE dropped, the
    // session ended, and the wearable went deaf until you walked back to that
    // one view. The screen is now a web page behind GarrisonPendantPlugin, and
    // a plugin instance dies with its bridge on every node switch, so the same
    // bug would come back the moment the plugin built its own controller. A
    // source check because the bug lives in OWNERSHIP, which no runtime
    // assertion in this target can observe.
    func testPendantIsOwnedByTheAppNotByAView() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let plugin = try String(contentsOf: root.appendingPathComponent("GarrisonApp/Plugins/GarrisonPendantPlugin.swift"))
        XCTAssertTrue(plugin.contains("PendantController.shared"))
        XCTAssertFalse(
            plugin.contains("= PendantController("),
            "the plugin must OBSERVE the shared controller, never own a second one - owning it kills the link with the bridge"
        )

        let controller = try String(contentsOf: root.appendingPathComponent("GarrisonApp/Pendant/PendantController.swift"))
        XCTAssertTrue(controller.contains("static let shared = PendantController()"))

        // And the app reconnects a KNOWN pendant on launch and on foreground,
        // so wearing it does not require visiting a screen at all.
        let app = try String(contentsOf: root.appendingPathComponent("GarrisonApp/GarrisonApp.swift"))
        XCTAssertTrue(app.contains("PendantController.shared.connect()"))
        XCTAssertTrue(app.contains("scenePhase"))
        XCTAssertTrue(
            app.contains("AppGroup.pendantIdentifier != nil"),
            "auto-connect only for an already-paired pendant; first pairing stays deliberate"
        )
    }
}

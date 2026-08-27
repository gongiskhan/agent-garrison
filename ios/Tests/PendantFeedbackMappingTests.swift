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
}

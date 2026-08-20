import XCTest
@testable import GarrisonApp

/// The device haptic tier vocabulary (ADR D4): every feedback event maps to
/// a pattern composed from the three fixed firmware levels, and the two
/// tiers the brief requires to stay distinguishable - window_closed and
/// task_created - genuinely are.
final class PendantFeedbackMappingTests: XCTestCase {
    func testEveryTierHasAPattern() {
        for name in ["wake_detected", "segment_captured", "window_closed", "task_created", "task_failed"] {
            XCTAssertFalse(PendantController.hapticPattern(for: name).isEmpty, name)
        }
        XCTAssertTrue(PendantController.hapticPattern(for: "unknown_event").isEmpty)
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

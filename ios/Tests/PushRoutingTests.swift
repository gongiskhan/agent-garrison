import XCTest
@testable import GarrisonApp

/// The route a push tap lands on. capture-service puts the shell path under
/// `data.path` (beside the absolute `link`); a hand-built test push may carry
/// it flat. Anything that is not a bare shell path is dropped, so a payload can
/// never steer the web view off the node origin.
final class PushRoutingTests: XCTestCase {
    func testNestedDataPathWins() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Card", "body": "Done"]],
            "data": ["path": "/fitting/kanban-loop/card/42", "link": "https://node.example/fitting/kanban-loop/card/42"],
            "path": "/talk"
        ]
        XCTAssertEqual(PushRouter.path(fromNotification: userInfo), "/fitting/kanban-loop/card/42")
    }

    func testFlatPathIsAcceptedForHandBuiltPushes() {
        XCTAssertEqual(PushRouter.path(fromNotification: ["path": "/talk/abc"]), "/talk/abc")
    }

    func testMissingPathIsNil() {
        XCTAssertNil(PushRouter.path(fromNotification: ["aps": ["alert": "hi"]]))
        XCTAssertNil(PushRouter.path(fromNotification: ["data": ["link": "https://node.example/talk"]]))
    }

    func testOnlyBareShellPathsPass() {
        XCTAssertNil(PushRouter.path(fromNotification: ["path": "https://evil.example/x"]))
        XCTAssertNil(PushRouter.path(fromNotification: ["path": "//evil.example/x"]))
        XCTAssertNil(PushRouter.path(fromNotification: ["path": "talk"]))
        XCTAssertNil(PushRouter.path(fromNotification: ["path": "/x?next=https://evil.example"]))
        XCTAssertNil(PushRouter.path(fromNotification: ["data": ["path": 42]]))
    }
}

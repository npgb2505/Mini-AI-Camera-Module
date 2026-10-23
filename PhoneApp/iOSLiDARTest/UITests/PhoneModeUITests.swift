import XCTest

final class PhoneModeUITests: XCTestCase {
    func testPhoneModeShowsLiDARReadoutAndReturnsToChooser() {
        let app = XCUIApplication()
        app.launch()

        let phoneModeButton = app.buttons["mode.phone"]
        XCTAssertTrue(phoneModeButton.waitForExistence(timeout: 10))
        phoneModeButton.tap()

        let distanceReadout = app.descendants(matching: .any)["phone.distance.readout"]
        XCTAssertTrue(distanceReadout.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["voice.conversation.toggle"].exists)
        XCTAssertTrue(app.buttons["Chọn chế độ camera"].exists)
        XCTAssertTrue(app.buttons["Cài đặt backend"].exists)

        app.buttons["Chọn chế độ camera"].tap()
        XCTAssertTrue(phoneModeButton.waitForExistence(timeout: 5))
    }

    func testNativeSettingsCanCreateACloudAccount() {
        let app = XCUIApplication()
        app.launch()

        app.buttons["Cài đặt backend"].tap()
        let displayName = app.textFields["account.registration.display-name"]
        for _ in 0..<3 where !displayName.exists {
            app.swipeUp()
        }

        XCTAssertTrue(displayName.waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["account.registration.username"].exists)
        XCTAssertTrue(app.secureTextFields["account.registration.password"].exists)
        XCTAssertTrue(app.secureTextFields["account.registration.code"].exists)
        XCTAssertTrue(app.buttons["account.registration.submit"].exists)
    }
}

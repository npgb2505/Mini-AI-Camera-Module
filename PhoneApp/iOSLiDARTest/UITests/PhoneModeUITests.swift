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
        XCTAssertTrue(app.buttons["Chọn chế độ camera"].exists)
        XCTAssertTrue(app.buttons["Cài đặt backend"].exists)

        app.buttons["Chọn chế độ camera"].tap()
        XCTAssertTrue(phoneModeButton.waitForExistence(timeout: 5))
    }
}

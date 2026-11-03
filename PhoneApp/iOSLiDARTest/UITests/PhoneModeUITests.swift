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

    func testWalkingDirectionsSearchesPreviewsRouteAndHandsOffToMapsAfterDestinationSelection() {
        let app = XCUIApplication()
        app.launchArguments.append("--ui-testing-navigation")
        app.launch()

        let directionsButton = app.buttons["mode.navigation"]
        XCTAssertTrue(directionsButton.waitForExistence(timeout: 10))
        directionsButton.tap()

        XCTAssertTrue(app.textFields["navigation.destination-query"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["navigation.search"].exists)
        XCTAssertTrue(app.buttons["Quay lại chọn chế độ"].exists)

        let query = app.textFields["navigation.destination-query"]
        query.tap()
        query.typeText("Bao tang Cham")
        app.buttons["navigation.search"].tap()

        let locationRequestCount = app.staticTexts["navigation.location-request-count"]
        XCTAssertTrue(locationRequestCount.waitForExistence(timeout: 5))
        XCTAssertEqual(locationRequestCount.label, "Yêu cầu vị trí: 0", "Searching must not request location.")

        let destination = app.buttons["navigation.destination-result.ui-test-destination"]
        XCTAssertTrue(destination.waitForExistence(timeout: 5))
        XCTAssertTrue(destination.label.contains("Bảo tàng Điêu khắc Chăm"))
        destination.tap()

        let distance = app.staticTexts["navigation.route.distance"]
        XCTAssertTrue(distance.waitForExistence(timeout: 5))
        XCTAssertTrue(distance.label.contains("1.2 km"))
        let instruction = app.staticTexts["navigation.route.instruction"]
        XCTAssertTrue(instruction.waitForExistence(timeout: 5))
        XCTAssertTrue(instruction.label.contains("Đi thẳng về hướng đường Bạch Đằng"))
        XCTAssertEqual(locationRequestCount.label, "Yêu cầu vị trí: 1", "The route may request location after a destination is selected.")

        let mapsButton = app.buttons["navigation.open-apple-maps"]
        XCTAssertTrue(mapsButton.exists)
        mapsButton.tap()
        XCTAssertTrue(app.staticTexts["navigation.maps-handoff-state"].waitForExistence(timeout: 5))

        let routeContent = app.scrollViews["navigation.route.content"]
        XCTAssertTrue(routeContent.exists)
        routeContent.swipeUp()
        let backButton = app.buttons["Quay lại chọn chế độ"]
        XCTAssertTrue(backButton.isHittable, "The back control should stay accessible while route details scroll.")
        backButton.tap()
        XCTAssertTrue(directionsButton.waitForExistence(timeout: 5))
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
        let registrationCode = app.secureTextFields["account.registration.code"]
        let submit = app.buttons["account.registration.submit"]
        for _ in 0..<5 where !submit.exists {
            app.swipeUp()
        }
        XCTAssertTrue(registrationCode.waitForExistence(timeout: 5))
        XCTAssertTrue(submit.waitForExistence(timeout: 5))
    }
}

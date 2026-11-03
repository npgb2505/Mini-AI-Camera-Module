import SwiftUI
import MapKit
import CoreLocation
import UIKit

private struct WalkingPlaceResult: Identifiable {
    let id: String
    let item: MKMapItem

    var title: String { item.name ?? "Địa điểm" }
    var subtitle: String {
        let address = item.placemark.title ?? item.placemark.subtitle ?? ""
        return address == title ? "" : address
    }
}

private struct WalkingStep: Identifiable {
    let id: Int
    let instruction: String
    let distanceMeters: CLLocationDistance
}

private struct WalkingRoutePreview {
    let distanceMeters: CLLocationDistance
    let expectedTravelTime: TimeInterval
    let steps: [WalkingStep]
    let polyline: MKPolyline?
}

@MainActor
private protocol WalkingDirectionsProviding {
    var isUITestFixture: Bool { get }
    func searchPlaces(query: String, near location: CLLocationCoordinate2D?) async throws -> [WalkingPlaceResult]
    func walkingRoute(from origin: CLLocation, to destination: WalkingPlaceResult) async throws -> WalkingRoutePreview
    func openMaps(destination: CLLocationCoordinate2D, name: String)
}

@MainActor
private struct MapKitWalkingDirectionsProvider: WalkingDirectionsProviding {
    var isUITestFixture: Bool { false }

    func searchPlaces(query: String, near location: CLLocationCoordinate2D?) async throws -> [WalkingPlaceResult] {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        if let location {
            request.region = MKCoordinateRegion(center: location, latitudinalMeters: 20_000, longitudinalMeters: 20_000)
        }
        let response = try await MKLocalSearch(request: request).start()
        return response.mapItems.enumerated().map { index, item in
            WalkingPlaceResult(id: "\(index)-\(item.name ?? query)", item: item)
        }
    }

    func walkingRoute(from origin: CLLocation, to destination: WalkingPlaceResult) async throws -> WalkingRoutePreview {
        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: origin.coordinate))
        request.destination = destination.item
        request.transportType = .walking
        request.requestsAlternateRoutes = true
        let response = try await MKDirections(request: request).calculate()
        guard let route = response.routes.first else { throw WalkingDirectionsError.noWalkingRoute }
        let steps = route.steps.enumerated().compactMap { index, step in
            let instruction = step.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !instruction.isEmpty else { return nil }
            return WalkingStep(id: index, instruction: instruction, distanceMeters: step.distance)
        }
        return WalkingRoutePreview(
            distanceMeters: route.distance,
            expectedTravelTime: route.expectedTravelTime,
            steps: steps,
            polyline: route.polyline
        )
    }

    func openMaps(destination: CLLocationCoordinate2D, name: String) {
        let destinationItem = MKMapItem(placemark: MKPlacemark(coordinate: destination))
        destinationItem.name = name
        MKMapItem.openMaps(
            with: [MKMapItem.forCurrentLocation(), destinationItem],
            launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeWalking]
        )
    }
}

private enum WalkingDirectionsError: Error {
    case noWalkingRoute
}

#if DEBUG
@MainActor
private struct UITestWalkingDirectionsProvider: WalkingDirectionsProviding {
    var isUITestFixture: Bool { true }

    func searchPlaces(query: String, near location: CLLocationCoordinate2D?) async throws -> [WalkingPlaceResult] {
        let item = MKMapItem(
            placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: 16.0601, longitude: 108.2237))
        )
        item.name = "Bảo tàng Điêu khắc Chăm"
        return [WalkingPlaceResult(id: "ui-test-destination", item: item)]
    }

    func walkingRoute(from origin: CLLocation, to destination: WalkingPlaceResult) async throws -> WalkingRoutePreview {
        WalkingRoutePreview(
            distanceMeters: 1_240,
            expectedTravelTime: 900,
            steps: [
                WalkingStep(id: 0, instruction: "Đi thẳng về hướng đường Bạch Đằng", distanceMeters: 180),
                WalkingStep(id: 1, instruction: "Rẽ phải vào đường Trần Phú", distanceMeters: 260)
            ],
            polyline: MKPolyline(coordinates: [origin.coordinate, destination.item.placemark.coordinate], count: 2)
        )
    }

    func openMaps(destination: CLLocationCoordinate2D, name: String) {}
}
#endif

@MainActor
private final class WalkingDirectionsModel: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var query = ""
    @Published private(set) var searchResults: [WalkingPlaceResult] = []
    @Published private(set) var selectedDestinationName: String?
    @Published private(set) var selectedDestination: CLLocationCoordinate2D?
    @Published private(set) var currentLocation: CLLocationCoordinate2D?
    @Published private(set) var route: WalkingRoutePreview?
    @Published private(set) var steps: [WalkingStep] = []
    @Published private(set) var isSearching = false
    @Published private(set) var isCalculatingRoute = false
    @Published private(set) var status = "Nhập địa điểm cần đến để tìm tuyến đi bộ."
    @Published private(set) var authorizationStatus: CLAuthorizationStatus = .notDetermined
#if DEBUG
    @Published private(set) var testLocationRequestCount = 0
    @Published private(set) var testMapsHandoffRequested = false
#endif

    private let provider: any WalkingDirectionsProviding
    private let locationManager = CLLocationManager()
    private var pendingDestination: WalkingPlaceResult?
    private var routeRequestID = UUID()

    init(provider: any WalkingDirectionsProviding = MapKitWalkingDirectionsProvider()) {
        self.provider = provider
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        authorizationStatus = locationManager.authorizationStatus
    }

    func searchPlaces() {
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            status = "Nhập tên địa điểm hoặc địa chỉ trước."
            searchResults = []
            return
        }
        isSearching = true
        status = "Đang tìm địa điểm…"
        route = nil
        steps = []
        Task {
            defer { isSearching = false }
            do {
                searchResults = try await provider.searchPlaces(query: value, near: currentLocation)
                status = searchResults.isEmpty
                    ? "Không tìm thấy địa điểm phù hợp. Thử thêm quận hoặc thành phố."
                    : "Chọn đúng địa điểm để tính tuyến đi bộ."
            } catch {
                searchResults = []
                status = "Không tìm được địa điểm. Kiểm tra kết nối mạng rồi thử lại."
            }
        }
    }

    func choose(_ result: WalkingPlaceResult) {
        selectedDestinationName = result.title
        selectedDestination = result.item.placemark.coordinate
        route = nil
        steps = []
        pendingDestination = result
        if provider.isUITestFixture {
#if DEBUG
            testLocationRequestCount += 1
#endif
            let origin = CLLocation(latitude: 16.0678, longitude: 108.2208)
            currentLocation = origin.coordinate
            calculateWalkingRoute(from: origin, to: result)
            return
        }
        switch locationManager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            status = "Đang lấy vị trí hiện tại để tính tuyến đi bộ…"
            locationManager.requestLocation()
        case .notDetermined:
            status = "Cần quyền vị trí khi dùng app để tính đường từ chỗ bạn đang đứng."
            locationManager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            status = "Chưa có quyền vị trí. Bật Location Services cho Ro Sight trong Cài đặt iPhone."
        @unknown default:
            status = "Không xác định được quyền vị trí trên iPhone."
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorizationStatus = manager.authorizationStatus
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            if pendingDestination != nil {
                status = "Đang lấy vị trí hiện tại…"
                manager.requestLocation()
            }
        case .denied, .restricted:
            if pendingDestination != nil {
                status = "Chưa có quyền vị trí. Bật Location Services cho Ro Sight trong Cài đặt iPhone."
            }
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last,
              location.horizontalAccuracy >= 0,
              location.horizontalAccuracy <= 100 else {
            status = "Vị trí chưa đủ chính xác để tính tuyến. Hãy thử ở nơi thoáng hơn."
            return
        }
        currentLocation = location.coordinate
        guard let destination = pendingDestination else { return }
        pendingDestination = nil
        calculateWalkingRoute(from: location, to: destination)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        pendingDestination = nil
        status = "Không lấy được vị trí hiện tại. Kiểm tra GPS/vị trí rồi thử lại."
    }

    func openInAppleMaps() {
        guard let destination = selectedDestination,
              let destinationName = selectedDestinationName else { return }
        provider.openMaps(destination: destination, name: destinationName)
        if provider.isUITestFixture {
#if DEBUG
            testMapsHandoffRequested = true
#endif
            status = "Đã yêu cầu mở Apple Maps (kiểm thử)."
        }
    }

    func startNewSearch() {
        query = ""
        searchResults = []
        selectedDestinationName = nil
        selectedDestination = nil
        route = nil
        steps = []
        pendingDestination = nil
        status = "Nhập địa điểm cần đến để tìm tuyến đi bộ."
    }

    private func calculateWalkingRoute(from origin: CLLocation, to destination: WalkingPlaceResult) {
        let requestID = UUID()
        routeRequestID = requestID
        isCalculatingRoute = true
        status = "Đang tính tuyến đi bộ tới \(destination.title)…"
        Task {
            defer {
                if routeRequestID == requestID { isCalculatingRoute = false }
            }
            do {
                guard routeRequestID == requestID else { return }
                let preview = try await provider.walkingRoute(from: origin, to: destination)
                guard routeRequestID == requestID else { return }
                route = preview
                steps = preview.steps
                status = "Đã tính tuyến đi bộ. Mở Apple Maps để bắt đầu dẫn đường từng chặng."
            } catch {
                guard routeRequestID == requestID else { return }
                route = nil
                steps = []
                if error is WalkingDirectionsError {
                    status = "Không có tuyến đi bộ phù hợp tới địa điểm này."
                } else {
                    status = "Không tính được tuyến đi bộ. Kiểm tra mạng hoặc thử địa điểm khác."
                }
            }
        }
    }
}

private struct WalkingRouteMap: UIViewRepresentable {
    let currentLocation: CLLocationCoordinate2D?
    let destination: CLLocationCoordinate2D?
    let routePolyline: MKPolyline?

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView(frame: .zero)
        map.delegate = context.coordinator
        map.showsUserLocation = true
        map.userTrackingMode = .none
        map.mapType = .standard
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        map.removeOverlays(map.overlays)
        map.removeAnnotations(map.annotations.filter { !($0 is MKUserLocation) })
        if let destination {
            let annotation = MKPointAnnotation()
            annotation.coordinate = destination
            annotation.title = "Điểm đến"
            map.addAnnotation(annotation)
        }
        if let routePolyline {
            map.addOverlay(routePolyline)
            map.setVisibleMapRect(
                routePolyline.boundingMapRect,
                edgePadding: UIEdgeInsets(top: 44, left: 32, bottom: 44, right: 32),
                animated: true
            )
        } else if let currentLocation {
            map.setRegion(
                MKCoordinateRegion(center: currentLocation, latitudinalMeters: 1_500, longitudinalMeters: 1_500),
                animated: true
            )
        }
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            guard let polyline = overlay as? MKPolyline else { return MKOverlayRenderer(overlay: overlay) }
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = UIColor.systemCyan
            renderer.lineWidth = 6
            renderer.lineCap = .round
            renderer.lineJoin = .round
            return renderer
        }
    }
}

struct WalkingDirectionsScreen: View {
    let onBack: () -> Void
    @StateObject private var model: WalkingDirectionsModel

    init(onBack: @escaping () -> Void) {
        self.onBack = onBack
#if DEBUG
        let provider: any WalkingDirectionsProviding = ProcessInfo.processInfo.arguments.contains("--ui-testing-navigation")
            ? UITestWalkingDirectionsProvider()
            : MapKitWalkingDirectionsProvider()
#else
        let provider: any WalkingDirectionsProviding = MapKitWalkingDirectionsProvider()
#endif
        _model = StateObject(wrappedValue: WalkingDirectionsModel(provider: provider))
    }

    var body: some View {
        ZStack {
            Color(red: 0.035, green: 0.055, blue: 0.065).ignoresSafeArea()
            VStack(spacing: 12) {
                header
                searchBox
                Text(model.status)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.72))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.updatesFrequently)
#if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--ui-testing-navigation") {
                    Text("Yêu cầu vị trí: \(model.testLocationRequestCount)")
                        .accessibilityIdentifier("navigation.location-request-count")
                }
#endif

                if let route = model.route {
                    routeDetails(route)
                } else {
                    placeResults
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 8)
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(.white.opacity(0.1), in: Circle())
            }
            .accessibilityLabel("Quay lại chọn chế độ")
            VStack(alignment: .leading, spacing: 4) {
                Text("CHỈ ĐƯỜNG")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .tracking(1.8)
                    .foregroundStyle(.cyan)
                Text("Tuyến đi bộ")
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
            }
            Spacer()
            Image(systemName: "figure.walk")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(.cyan)
        }
    }

    private var searchBox: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass").foregroundStyle(.white.opacity(0.55))
            TextField("Địa chỉ hoặc tên địa điểm", text: $model.query)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit(model.searchPlaces)
                .foregroundStyle(.white)
                .accessibilityLabel("Tìm địa điểm đến")
                .accessibilityIdentifier("navigation.destination-query")
            Button(action: model.searchPlaces) {
                if model.isSearching {
                    ProgressView().tint(.black)
                } else {
                    Text("Tìm").font(.system(size: 13, weight: .bold, design: .rounded))
                }
            }
            .disabled(model.isSearching)
            .foregroundStyle(.black)
            .frame(minWidth: 48, minHeight: 40)
            .background(.cyan, in: Capsule())
            .accessibilityIdentifier("navigation.search")
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .frame(minHeight: 52)
        .background(.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 17))
        .overlay(RoundedRectangle(cornerRadius: 17).stroke(.white.opacity(0.13), lineWidth: 1))
    }

    private var placeResults: some View {
        ScrollView {
            VStack(spacing: 8) {
                if model.searchResults.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Dùng vị trí hiện tại", systemImage: model.authorizationStatus == .denied ? "location.slash" : "location.fill")
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white)
                        Text("Chọn một kết quả tìm kiếm để xin quyền vị trí khi dùng app và tính tuyến đi bộ.")
                            .font(.system(size: 11, weight: .regular, design: .rounded))
                            .foregroundStyle(.white.opacity(0.62))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(15)
                    .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
                }
                ForEach(model.searchResults) { place in
                    Button { model.choose(place) } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(place.title).font(.system(size: 14, weight: .semibold, design: .rounded))
                            if !place.subtitle.isEmpty {
                                Text(place.subtitle)
                                    .font(.system(size: 11, weight: .regular, design: .rounded))
                                    .lineLimit(2)
                            }
                        }
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 15))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("navigation.destination-result.\(place.id)")
                }
            }
        }
    }

    private func routeDetails(_ route: WalkingRoutePreview) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            WalkingRouteMap(
                currentLocation: model.currentLocation,
                destination: model.selectedDestination,
                routePolyline: route.polyline
            )
            .frame(height: 230)
            .clipShape(RoundedRectangle(cornerRadius: 18))
            .accessibilityLabel("Bản đồ tuyến đi bộ tới \(model.selectedDestinationName ?? "điểm đến")")

            HStack(spacing: 16) {
                Label(String(format: "%.1f km", route.distanceMeters / 1_000), systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                    .accessibilityIdentifier("navigation.route.distance")
                Label(Self.durationLabel(route.expectedTravelTime), systemImage: "clock")
            }
            .font(.system(size: 12, weight: .semibold, design: .rounded))
            .foregroundStyle(.cyan)

            if let first = model.steps.first {
                Text("Bước tiếp theo: \(first.instruction)")
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(13)
                    .background(.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityIdentifier("navigation.route.instruction")
            }

            HStack {
                Text(model.selectedDestinationName ?? "Điểm đến")
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.86))
                    .lineLimit(1)
                Spacer()
                Button(action: model.openInAppleMaps) {
                    Label("Bắt đầu trong Apple Maps", systemImage: "arrow.up.right.square.fill")
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundStyle(.black)
                        .frame(minHeight: 44)
                        .padding(.horizontal, 13)
                        .background(.cyan, in: Capsule())
                }
                .accessibilityIdentifier("navigation.open-apple-maps")
            }
#if DEBUG
            if model.testMapsHandoffRequested {
                Text("Đã yêu cầu mở Apple Maps (kiểm thử).")
                    .accessibilityIdentifier("navigation.maps-handoff-state")
            }
#endif

            Text("Tuyến tính từ bản đồ; app chưa kiểm tra lề đường, cầu thang, công trình hoặc lối đi bộ có thể sử dụng. Hãy xác nhận bằng Apple Maps và môi trường thực tế.")
                .font(.system(size: 10, weight: .regular, design: .rounded))
                .foregroundStyle(.white.opacity(0.56))

            Button("Tìm điểm đến khác", action: model.startNewSearch)
            .font(.system(size: 12, weight: .semibold, design: .rounded))
            .foregroundStyle(.cyan)
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private static func durationLabel(_ seconds: TimeInterval) -> String {
        let minutes = max(1, Int((seconds / 60).rounded()))
        if minutes < 60 { return "\(minutes) phút" }
        return "\(minutes / 60) giờ \(minutes % 60) phút"
    }
}

// Fenêtre « Fonds d'écran » : sélecteur de thème, onglets Sélection / Plus / Téléchargés, grille de vignettes.
// Une seule opération à la fois (téléchargement puis application). Les données passent par GalleryProviding :
// GalleryService en réel, MockGalleryProvider pour les captures (GalleryView.mock()).
import Cocoa
import SwiftUI

/// Onglets de la fenêtre.
enum GalleryTab: String, CaseIterable, Identifiable {
    case selection
    case more
    case downloaded

    var id: String { rawValue }

    var title: String {
        switch self {
        case .selection: return "Sélection"
        case .more: return "Plus"
        case .downloaded: return "Téléchargés"
        }
    }

    var emptyText: String {
        switch self {
        case .selection: return "Aucun fond à proposer pour ce thème."
        case .more: return "Aucun résultat sur cette page."
        case .downloaded: return "Aucun fond téléchargé pour ce thème."
        }
    }
}

/// État de la fenêtre : thème, onglet, page, grille et opération en cours.
@MainActor
final class GalleryViewModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published private(set) var themes: [ThemeInfo] = []
    @Published private(set) var theme = ""
    @Published private(set) var tab: GalleryTab = .selection
    @Published private(set) var page = 1
    @Published private(set) var lastPage: Int?
    @Published private(set) var items: [WallpaperItem] = []
    @Published private(set) var phase: Phase = .loading
    /// Fond appliqué en ce moment : marqué « Actuel ».
    @Published private(set) var currentId: String?
    /// Fonds déjà présents sur le Mac pour le thème affiché.
    @Published private(set) var downloadedIds: Set<String> = []
    /// Fond en cours de téléchargement ou d'application : bloque les autres clics.
    @Published private(set) var busyId: String?
    @Published private(set) var operationError: String?

    private let provider: GalleryProviding
    private var requestedTheme: String?
    private var started = false
    private var generation = 0
    private var loadTask: Task<Void, Never>?

    init(provider: GalleryProviding, theme: String? = nil) {
        self.provider = provider
        self.requestedTheme = theme
    }

    var canGoPrevious: Bool { page > 1 }
    var canGoNext: Bool { page < (lastPage ?? Int.max) }

    // MARK: Chargement

    /// Premier affichage. Sans effet ensuite.
    func start() {
        guard !started else { return }
        started = true
        retry()
    }

    /// « Réessayer » : charge les thèmes si la liste manque, puis le contenu de l'onglet.
    func retry() {
        startLoad(loadThemes: themes.isEmpty)
    }

    /// Réouverture de la fenêtre : affiche le thème demandé s'il diffère, sinon recharge.
    func reopen(theme id: String?) {
        guard let id, !id.isEmpty, id != theme else {
            retry()
            return
        }
        if themes.contains(where: { $0.id == id }) {
            selectTheme(id)
        } else {
            requestedTheme = id
            startLoad(loadThemes: true)
        }
    }

    func selectTheme(_ id: String) {
        guard id != theme else { return }
        theme = id
        page = 1
        lastPage = nil
        startLoad(loadThemes: false)
    }

    func select(tab newTab: GalleryTab) {
        guard newTab != tab else { return }
        tab = newTab
        startLoad(loadThemes: false)
    }

    func changePage(by delta: Int) {
        let target = page + delta
        guard target >= 1, target <= (lastPage ?? Int.max) else { return }
        page = target
        startLoad(loadThemes: false)
    }

    func dismissError() {
        operationError = nil
    }

    private func startLoad(loadThemes: Bool) {
        loadTask?.cancel()
        generation += 1
        let token = generation
        phase = .loading
        items = []
        loadTask = Task {
            await self.load(token, loadThemes: loadThemes)
        }
    }

    /// Une réponse périmée (un autre chargement a commencé depuis) est ignorée.
    private func load(_ token: Int, loadThemes: Bool) async {
        do {
            if loadThemes {
                let response = try await provider.themes()
                guard token == generation else { return }
                themes = response.themes ?? []
                theme = chosenTheme(current: response.theme)
                requestedTheme = nil
            }
            let currentTheme = theme
            let currentTab = tab
            let currentPage = page
            var fetched: [WallpaperItem] = []
            var last: Int?
            var local: WallpaperLocalResponse?
            if !currentTheme.isEmpty {
                switch currentTab {
                case .selection:
                    local = try? await provider.local(theme: currentTheme)
                    fetched = try await provider.list(theme: currentTheme).wallpapers ?? []
                case .more:
                    local = try? await provider.local(theme: currentTheme)
                    let response = try await provider.search(theme: currentTheme, page: currentPage)
                    fetched = response.wallpapers ?? []
                    last = response.lastPage
                case .downloaded:
                    let response = try await provider.local(theme: currentTheme)
                    local = response
                    fetched = (response.wallpapers ?? []).map(\.item)
                }
            }
            guard token == generation else { return }
            applyLocal(local)
            items = fetched
            lastPage = last
            phase = .loaded
        } catch {
            guard token == generation else { return }
            phase = .failed("Chargement impossible : \(GalleryViewModel.describe(error))")
        }
    }

    /// Thème demandé à l'ouverture, sinon thème courant, sinon le premier de la liste.
    private func chosenTheme(current: String?) -> String {
        let ids = themes.map(\.id)
        if let wanted = requestedTheme, ids.contains(wanted) { return wanted }
        if let current, ids.contains(current) { return current }
        return ids.first ?? ""
    }

    /// Sans réponse locale (échec de `local`), on n'affirme ni « Actuel » ni « téléchargé » : l'état de l'ancien thème est effacé.
    private func applyLocal(_ response: WallpaperLocalResponse?) {
        let locals = response?.wallpapers ?? []
        downloadedIds = Set(locals.map(\.id))
        currentId = locals.first(where: { $0.current == true })?.id
    }

    // MARK: Actions

    func isDownloaded(_ item: WallpaperItem) -> Bool {
        item.isDownloaded || downloadedIds.contains(item.id)
    }

    func isCurrent(_ item: WallpaperItem) -> Bool {
        item.id == currentId
    }

    func thumbnail(for item: WallpaperItem) async -> NSImage? {
        await provider.thumbnail(for: item)
    }

    func cachedThumbnail(for item: WallpaperItem) -> NSImage? {
        provider.cachedThumbnail(for: item)
    }

    /// Affiche un contenu déjà prêt (captures) : aucune tâche asynchrone, donc rendu immédiat.
    func preload(themes list: [ThemeInfo], theme id: String, items fetched: [WallpaperItem], currentId current: String?, downloadedIds downloaded: Set<String>) {
        started = true
        themes = list
        theme = id
        items = fetched
        currentId = current
        downloadedIds = downloaded
        lastPage = nil
        phase = .loaded
    }

    /// Clic sur une vignette : télécharge si besoin, puis applique le fond.
    func activate(_ item: WallpaperItem) {
        guard busyId == nil, !theme.isEmpty else { return }
        let target = theme
        let alreadyLocal = isDownloaded(item)
        busyId = item.id
        operationError = nil
        Task {
            var stage = "Téléchargement impossible"
            defer { self.busyId = nil }
            do {
                if !alreadyLocal {
                    _ = try await self.provider.download(id: item.id, theme: target)
                    self.downloadedIds.insert(item.id)
                }
                stage = "Application du fond impossible"
                // Le fond s'applique au thème affiché (target), pas au thème actif.
                let used = try await self.provider.use(id: item.id, theme: target)
                self.currentId = used.id ?? item.id
            } catch {
                self.operationError = "\(stage) : \(GalleryViewModel.describe(error))"
            }
        }
    }

    static func describe(_ error: Error) -> String {
        let text = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "erreur inconnue" : text
    }
}

/// Contenu de la fenêtre : barre de thème et d'onglets, pagination (Plus), grille et pied de page.
struct GalleryView: View {
    @ObservedObject var viewModel: GalleryViewModel

    private let columns = [GridItem(.adaptive(minimum: 200, maximum: 280), spacing: 16)]

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            if let error = viewModel.operationError {
                errorBar(error)
                Divider()
            }
            if viewModel.tab == .more {
                pagination
                Divider()
            }
            content
            Divider()
            footer
        }
        .frame(minWidth: 640, minHeight: 480)
        .onAppear { viewModel.start() }
    }

    private var themeBinding: Binding<String> {
        Binding(get: { viewModel.theme }, set: { viewModel.selectTheme($0) })
    }

    private var tabBinding: Binding<GalleryTab> {
        Binding(get: { viewModel.tab }, set: { viewModel.select(tab: $0) })
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            Picker("Thème", selection: themeBinding) {
                ForEach(viewModel.themes) { theme in
                    Text(theme.name).tag(theme.id)
                }
            }
            .frame(maxWidth: 240)
            .disabled(viewModel.themes.isEmpty)
            Spacer()
            Picker("Onglet", selection: tabBinding) {
                ForEach(GalleryTab.allCases) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 320)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func errorBar(_ message: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.orange)
            Text(message)
                .font(.callout)
                .lineLimit(2)
            Spacer()
            Button("Fermer") { viewModel.dismissError() }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.orange.opacity(0.12))
    }

    private var pagination: some View {
        HStack(spacing: 12) {
            Button("Précédent") { viewModel.changePage(by: -1) }
                .disabled(!viewModel.canGoPrevious || viewModel.phase == .loading)
            Text(pageLabel)
                .font(.callout)
                .foregroundStyle(.secondary)
            Button("Suivant") { viewModel.changePage(by: 1) }
                .disabled(!viewModel.canGoNext || viewModel.phase == .loading)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private var pageLabel: String {
        if let last = viewModel.lastPage {
            return "Page \(viewModel.page) sur \(last)"
        }
        return "Page \(viewModel.page)"
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.phase {
        case .loading:
            VStack(spacing: 10) {
                ProgressView()
                Text("Chargement…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            statusMessage(message, withRetry: true)
        case .loaded:
            if viewModel.themes.isEmpty {
                statusMessage("Aucun thème trouvé dans l'application.", withRetry: true)
            } else if viewModel.items.isEmpty {
                statusMessage(viewModel.tab.emptyText, withRetry: false)
            } else {
                grid
            }
        }
    }

    private func statusMessage(_ text: String, withRetry: Bool) -> some View {
        VStack(spacing: 12) {
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if withRetry {
                Button("Réessayer") { viewModel.retry() }
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var grid: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(viewModel.items) { item in
                    GalleryCell(item: item, viewModel: viewModel)
                }
            }
            .padding(16)
        }
    }

    private var footer: some View {
        HStack {
            Text("Images Wallhaven, propriété de leurs auteurs.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }
}

/// Cellule : vignette cliquable (télécharger si besoin, puis appliquer), résolution et lien vers la source.
struct GalleryCell: View {
    let item: WallpaperItem
    @ObservedObject var viewModel: GalleryViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                viewModel.activate(item)
            } label: {
                WallpaperThumbnail(
                    item: item,
                    viewModel: viewModel,
                    isCurrent: viewModel.isCurrent(item),
                    isDownloaded: viewModel.isDownloaded(item),
                    isBusy: viewModel.busyId == item.id)
            }
            .buttonStyle(.plain)
            .disabled(viewModel.busyId != nil)
            .accessibilityLabel(accessibilityText)

            HStack(spacing: 8) {
                Text(item.resolution ?? "")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if let source = GalleryLinks.sourceURL(item.source) {
                    Button("Ouvrir la source") {
                        _ = NSWorkspace.shared.open(source)
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                }
            }
        }
    }

    private var accessibilityText: String {
        var text = "Fond \(item.id)"
        if let resolution = item.resolution { text += ", \(resolution)" }
        if viewModel.isCurrent(item) { text += ", actuel" }
        return text
    }
}

/// Vignette 16:10 : placeholder pendant le chargement, repère « Actuel » ou coche « téléchargé », voile pendant l'opération.
struct WallpaperThumbnail: View {
    let item: WallpaperItem
    let viewModel: GalleryViewModel
    let isCurrent: Bool
    let isDownloaded: Bool
    let isBusy: Bool
    @State private var image: NSImage?
    @State private var loaded = false

    init(item: WallpaperItem, viewModel: GalleryViewModel, isCurrent: Bool, isDownloaded: Bool, isBusy: Bool) {
        self.item = item
        self.viewModel = viewModel
        self.isCurrent = isCurrent
        self.isDownloaded = isDownloaded
        self.isBusy = isBusy
        // Image déjà en cache : rendu immédiat, sans attendre la tâche.
        _image = State(initialValue: viewModel.cachedThumbnail(for: item))
    }

    var body: some View {
        Color.secondary.opacity(0.15)
            .aspectRatio(16.0 / 10.0, contentMode: .fit)
            .overlay {
                if let image {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFill()
                } else if loaded {
                    Image(systemName: "photo")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                } else {
                    ProgressView()
                        .scaleEffect(0.6)
                }
            }
            .overlay(alignment: .topLeading) {
                if isCurrent {
                    Text("Actuel")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color.accentColor))
                        .padding(8)
                }
            }
            .overlay(alignment: .topTrailing) {
                if isDownloaded && !isCurrent {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(.white)
                        .shadow(radius: 2)
                        .padding(8)
                }
            }
            .overlay {
                if isBusy {
                    ZStack {
                        Color.black.opacity(0.45)
                        ProgressView()
                            .colorScheme(.dark)
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .task(id: item.id) {
                loaded = false
                image = await viewModel.thumbnail(for: item)
                loaded = true
            }
    }
}

/// Fenêtre « Fonds d'écran » : une seule instance, réutilisée à chaque ouverture.
@MainActor
final class GalleryWindowController: NSWindowController {
    private static var shared: GalleryWindowController?
    private let viewModel: GalleryViewModel

    /// Ouvre la fenêtre, ou la ramène au premier plan. `theme` : thème à afficher (nil = thème courant).
    static func show(runner: SetupRunner, theme: String?) {
        let controller: GalleryWindowController
        if let existing = shared {
            controller = existing
            existing.viewModel.reopen(theme: theme)
        } else {
            controller = GalleryWindowController(provider: GalleryService(runner: runner), theme: theme)
            shared = controller
        }
        controller.showWindow(nil)
        controller.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    init(provider: GalleryProviding, theme: String?) {
        let model = GalleryViewModel(provider: provider, theme: theme)
        viewModel = model
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "Fonds d'écran"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 640, height: 480)
        window.contentView = NSHostingView(rootView: GalleryView(viewModel: model))
        window.center()
        super.init(window: window)
    }

    required init?(coder: NSCoder) {
        fatalError("GalleryWindowController n'est pas créé depuis un fichier nib")
    }
}

extension GalleryView {
    /// Vue avec données factices, prête dès la création (aucune tâche à attendre) : utilisable par Snapshot.swift,
    /// dont la boucle de rendu ne fait pas tourner les tâches du fil principal. Aucun réseau, aucun appel à setup.js.
    @MainActor
    static func mock() -> GalleryView {
        let model = GalleryViewModel(provider: MockGalleryProvider())
        model.preload(
            themes: MockGalleryProvider.themeList,
            theme: "demo-nuit",
            items: MockGalleryProvider.wallpapers,
            currentId: "demo-02",
            downloadedIds: ["demo-02", "demo-05"])
        return GalleryView(viewModel: model)
    }
}

/// Fournisseur statique : listes en dur, vignettes dessinées en code (dégradés). Aucune image tierce.
@MainActor
final class MockGalleryProvider: GalleryProviding {
    static let themeList: [ThemeInfo] = [
        ThemeInfo(id: "demo-nuit", name: "Nuit", thumbnail: nil),
        ThemeInfo(id: "demo-aube", name: "Aube", thumbnail: nil),
        ThemeInfo(id: "demo-foret", name: "Forêt", thumbnail: nil),
    ]

    static let wallpapers: [WallpaperItem] = (1...8).map { n in
        WallpaperItem(
            id: "demo-0\(n)",
            resolution: n % 2 == 0 ? "2560x1440" : "1920x1080",
            source: "https://wallhaven.cc/w/demo0\(n)",
            purity: "sfw",
            downloaded: n == 2 || n == 5)
    }

    private static let palette: [(NSColor, NSColor)] = [
        (NSColor(calibratedRed: 0.10, green: 0.16, blue: 0.32, alpha: 1), NSColor(calibratedRed: 0.52, green: 0.24, blue: 0.42, alpha: 1)),
        (NSColor(calibratedRed: 0.06, green: 0.36, blue: 0.40, alpha: 1), NSColor(calibratedRed: 0.22, green: 0.58, blue: 0.42, alpha: 1)),
        (NSColor(calibratedRed: 0.55, green: 0.22, blue: 0.14, alpha: 1), NSColor(calibratedRed: 0.90, green: 0.55, blue: 0.22, alpha: 1)),
        (NSColor(calibratedRed: 0.14, green: 0.15, blue: 0.18, alpha: 1), NSColor(calibratedRed: 0.36, green: 0.40, blue: 0.48, alpha: 1)),
        (NSColor(calibratedRed: 0.20, green: 0.30, blue: 0.12, alpha: 1), NSColor(calibratedRed: 0.52, green: 0.56, blue: 0.26, alpha: 1)),
    ]

    private var thumbnails: [String: NSImage] = [:]

    func themes() async throws -> ThemesResponse {
        ThemesResponse(themes: Self.themeList, theme: "demo-nuit", background: nil, autoDownload: true)
    }

    func list(theme: String) async throws -> WallpaperListResponse {
        WallpaperListResponse(theme: theme, query: nil, wallpapers: Self.wallpapers, skipped: [])
    }

    func search(theme: String, page: Int) async throws -> WallpaperSearchResponse {
        WallpaperSearchResponse(theme: theme, page: page, lastPage: 3, wallpapers: Self.wallpapers)
    }

    func local(theme: String) async throws -> WallpaperLocalResponse {
        WallpaperLocalResponse(theme: theme, wallpapers: [
            LocalWallpaper(id: "demo-02", file: nil, source: "https://wallhaven.cc/w/demo02", resolution: "2560x1440", current: true, builtin: false),
            LocalWallpaper(id: "demo-05", file: nil, source: "https://wallhaven.cc/w/demo05", resolution: "1920x1080", current: false, builtin: false),
        ])
    }

    func download(id: String, theme: String) async throws -> WallpaperDownloadResponse {
        try await Task.sleep(nanoseconds: 600_000_000)
        return WallpaperDownloadResponse(id: id, theme: theme, file: nil, source: nil, resolution: nil)
    }

    func use(id: String, theme: String) async throws -> WallpaperUseResponse {
        try await Task.sleep(nanoseconds: 400_000_000)
        return WallpaperUseResponse(background: nil, theme: nil, id: id)
    }

    func thumbnail(for item: WallpaperItem) async -> NSImage? {
        cachedThumbnail(for: item)
    }

    /// Dégradé généré à la demande, puis gardé : aucune attente.
    func cachedThumbnail(for item: WallpaperItem) -> NSImage? {
        if let cached = thumbnails[item.id] { return cached }
        let seed = item.id.unicodeScalars.reduce(0) { $0 + Int($1.value) }
        let (from, to) = Self.palette[seed % Self.palette.count]
        let image = Self.gradient(from: from, to: to, size: NSSize(width: 320, height: 200))
        thumbnails[item.id] = image
        return image
    }

    private static func gradient(from: NSColor, to: NSColor, size: NSSize) -> NSImage {
        NSImage(size: size, flipped: false) { rect in
            NSGradient(starting: from, ending: to)?.draw(in: rect, angle: -30)
            NSColor.white.withAlphaComponent(0.14).setFill()
            let diameter = rect.height * 0.5
            NSBezierPath(ovalIn: NSRect(x: rect.width * 0.62, y: rect.height * 0.3, width: diameter, height: diameter)).fill()
            return true
        }
    }
}

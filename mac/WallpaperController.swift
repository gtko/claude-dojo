// Fond d'écran Dojo : une fenêtre WebKit sans bordure par écran, posée au niveau du bureau, sur tous les Spaces,
// qui affiche http://localhost:7777/ (servi par agent-mac.js). Comportement identique à l'ancienne version mono-fichier.
import Cocoa
import WebKit

/// Réglages du fond d'écran : mêmes clés UserDefaults qu'avant.
enum WallpaperPrefs {
    private static var defaults: UserDefaults { UserDefaults.standard }

    static var mirror: Bool {
        get { defaults.object(forKey: "mirror") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "mirror") }
    }
    static var zoomSetting: Double {
        get { defaults.object(forKey: "zoom") as? Double ?? 0 }
        set { defaults.set(newValue, forKey: "zoom") }
    }
    static var interactive: Bool {
        get { defaults.object(forKey: "interactive") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "interactive") }
    }
}

let wallpaperURL = URL(string: ProcessInfo.processInfo.environment["DOJO_URL"] ?? "http://localhost:7777/")!

// Le 1er clic sur une fenêtre inactive ne sert d'habitude qu'à l'activer : on le transmet à la page
// (sinon il faut cliquer deux fois sur un ninja, un bouton du lecteur…).
final class Web: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class Wall: NSWindow {
    override var canBecomeKey: Bool { true }      // pour recevoir les clics en mode interactif
}

final class WallpaperController: NSObject, WKNavigationDelegate {
    private(set) var windows: [Wall] = []
    /// Appelé quand un réglage change, pour que le menu mette à jour ses coches.
    var onChange: (() -> Void)?
    private var started = false
    private var timer: Timer?
    private var lastSafe: [String] = []

    // Zone de travail : fenêtres des autres apps tenues hors des panneaux (voir WindowZoneManager)
    let zoneManager = WindowZoneManager()
    private(set) var windowZone = WindowZoneConfig.defaults
    private var zoneGeneration = 0
    /// Dernière zone valide de chaque écran (clé : identifiant d'affichage). Une mesure ratée (page en rechargement,
    /// changement de thème, réponse aberrante) la garde au lieu d'élargir la zone.
    private var lastValidZones: [Int: ScreenZone] = [:]

    // Miroir : panneau système à gauche (à côté de Stage Manager), grande colonne à droite
    var mirror: Bool {
        get { WallpaperPrefs.mirror }
        set { WallpaperPrefs.mirror = newValue; pushSafe(force: true); onChange?() }
    }
    // Taille de la page : 0 = auto (écran de référence 2560 pt de large, celui du Windows 4K à 150 %)
    var zoomSetting: Double {
        get { WallpaperPrefs.zoomSetting }
        set { WallpaperPrefs.zoomSetting = newValue; applyZoom() }
    }
    var interactive: Bool {
        get { WallpaperPrefs.interactive }
        set { WallpaperPrefs.interactive = newValue; applyLevel() }
    }

    func zoom(for screen: NSScreen) -> CGFloat {
        zoomSetting > 0 ? CGFloat(zoomSetting) : min(1, max(0.6, (screen.frame.width / 2560 * 100).rounded() / 100))
    }

    // Zone sûre d'un écran : hauteur de la barre de menus / encoche, largeur de l'encoche, marge gauche (Dock, Stage Manager)
    func safe(for screen: NSScreen) -> String {
        let f = screen.frame, v = screen.visibleFrame
        let top = max(screen.safeAreaInsets.top, f.maxY - v.maxY)
        var notchW: CGFloat = 0
        if let l = screen.auxiliaryTopLeftArea, let r = screen.auxiliaryTopRightArea { notchW = max(0, r.minX - l.maxX) }
        let stage = UserDefaults(suiteName: "com.apple.WindowManager")?.bool(forKey: "GloballyEnabled") ?? false
        let left = max(0, v.minX - f.minX) + (stage ? 165 : 0)
        let z = zoom(for: screen)
        return "{top:\(Int(top / z)),left:\(Int(left / z)),notchW:\(Int(notchW / z)),notchH:\(Int(screen.safeAreaInsets.top / z)),mirror:\(mirror)}"
    }

    func pushSafe(force: Bool) {
        let cur = windows.map { safe(for: $0.screen ?? NSScreen.main!) }
        if !force && cur == lastSafe { return }
        lastSafe = cur
        for (w, js) in zip(windows, cur) { (w.contentView as? WKWebView)?.evaluateJavaScript("window.setSafe && setSafe(\(js))") }
        // Miroir, taille, Stage Manager : la page se remet en page, les zones réservées suivent.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.refreshZones() }
    }

    // MARK: Zone de travail

    /// Applique la configuration windowZone (relue de config.json) : active ou arrête le gestionnaire, remesure les panneaux.
    func applyWindowZone(_ config: WindowZoneConfig) {
        if config.margin != windowZone.margin || config.reserveTop != windowZone.reserveTop { lastValidZones = [:] }
        windowZone = config
        zoneManager.configure(enabled: config.enabled, exclude: config.exclude)
        refreshZones()
    }

    /// Stage Manager actif ? Sa bande gauche est alors réservée en plus des panneaux.
    static var stageManagerActive: Bool {
        UserDefaults(suiteName: "com.apple.WindowManager")?.bool(forKey: "GloballyEnabled") ?? false
    }

    /// Mesure les panneaux de chaque page (window.dojoReservedRects) puis publie les zones de travail.
    /// Asynchrone, sur le fil principal : evaluateJavaScript ne bloque pas. Les réponses d'une mesure périmée sont ignorées.
    func refreshZones() {
        guard windowZone.enabled, WindowZoneManager.isTrusted else { return }
        zoneGeneration += 1
        let generation = zoneGeneration
        let walls = windows
        guard !walls.isEmpty else { return }
        var measured = [ReservedCSSRects?](repeating: nil, count: walls.count)
        var remaining = walls.count
        for (index, wall) in walls.enumerated() {
            let finish = { [weak self] (rects: ReservedCSSRects?) in
                guard let self, generation == self.zoneGeneration else { return }
                measured[index] = rects
                remaining -= 1
                if remaining == 0 { self.publishZones(walls: walls, measured: measured) }
            }
            guard let web = wall.contentView as? WKWebView else { finish(nil); continue }
            web.evaluateJavaScript("window.dojoReservedRects ? JSON.stringify(window.dojoReservedRects()) : null") { result, _ in
                finish(WindowZoneGeometry.parseRects(result as? String))
            }
        }
    }

    private func publishZones(walls: [Wall], measured: [ReservedCSSRects?]) {
        guard let primary = NSScreen.screens.first else { return }
        let stage = Self.stageManagerActive
        var zones: [ScreenZone] = []
        var seen = Set<Int>()
        for (wall, rects) in zip(walls, measured) {
            guard let screen = wall.screen else { continue }
            let displayID = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? -1
            seen.insert(displayID)
            let frame = WindowZoneGeometry.axRect(fromCocoa: screen.frame, primaryHeight: primary.frame.height)
            let visible = WindowZoneGeometry.axRect(fromCocoa: screen.visibleFrame, primaryHeight: primary.frame.height)
            // Mesure ratée (nil) : on ne calcule rien de neuf. Sinon, zone calculée ; refusée (panneaux énormes) : même repli.
            let computed = rects.flatMap {
                WindowZoneGeometry.screenZone(
                    screen: frame, visible: visible, reserved: $0, margin: CGFloat(windowZone.margin),
                    reserveTop: windowZone.reserveTop, stageStrip: stage ? 165 : 0)
            }
            if let computed {
                lastValidZones[displayID] = computed
                zones.append(computed)
            } else if let previous = lastValidZones[displayID], previous.screen == frame, previous.visible == visible {
                zones.append(previous)      // la zone reste celle d'avant, elle ne s'élargit pas
            } else {
                // Rien de valide encore : aucun recadrage sur cet écran, mais il reste connu pour attribuer les fenêtres.
                zones.append(ScreenZone(screen: frame, visible: visible, zone: visible, bands: []))
            }
        }
        lastValidZones = lastValidZones.filter { seen.contains($0.key) }
        zoneManager.update(zones: zones)
    }

    /// Lance le fond d'écran (une seule fois) : fenêtres, observateurs, zone sûre périodique.
    func start() {
        guard !started else { return }
        started = true
        build()
        NotificationCenter.default.addObserver(self, selector: #selector(rebuild), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(reloadAll), name: NSWorkspace.didWakeNotification, object: nil)
        // Stage Manager, Dock, barre de menus peuvent changer à tout moment : on renvoie la zone sûre si elle a bougé
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            self?.pushSafe(force: false)
            self?.refreshZones()      // mesure légère (un appel JS par écran) : suit les changements de thème, de taille, de miroir
        }
    }

    @objc private func rebuild() {
        windows.forEach { $0.close() }
        windows = []
        build()
        // La mise en page est refaite par les nouvelles pages : on remesure une fois qu'elles ont eu le temps de charger.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.refreshZones() }
    }

    private func build() {
        for screen in NSScreen.screens {
            let w = Wall(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            w.setFrame(screen.frame, display: false)
            w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
            w.isOpaque = true
            w.backgroundColor = .black
            w.hasShadow = false
            w.isReleasedWhenClosed = false
            let cfg = WKWebViewConfiguration()
            cfg.websiteDataStore = .nonPersistent()      // jamais de page périmée en cache
            cfg.mediaTypesRequiringUserActionForPlayback = []
            cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
            let web = Web(frame: NSRect(origin: .zero, size: screen.frame.size), configuration: cfg)
            web.autoresizingMask = [.width, .height]
            web.navigationDelegate = self
            web.setValue(false, forKey: "drawsBackground")
            w.contentView = web
            web.pageZoom = zoom(for: screen)
            web.load(URLRequest(url: wallpaperURL))
            w.orderFront(nil)
            windows.append(w)
        }
        applyLevel()
        applyZoom()
    }

    private func applyZoom() {
        for w in windows { (w.contentView as? WKWebView)?.pageZoom = zoom(for: w.screen ?? NSScreen.main!) }
        pushSafe(force: true)
        onChange?()
    }

    private func applyLevel() {
        // Interactif : juste au-dessus des icônes du Finder (qui sinon captent tous les clics du bureau)
        let level = interactive ? Int(CGWindowLevelForKey(.desktopIconWindow)) + 1 : Int(CGWindowLevelForKey(.desktopWindow))
        for w in windows {
            w.level = NSWindow.Level(rawValue: level)
            w.ignoresMouseEvents = !interactive
            w.orderFront(nil)
        }
        onChange?()
    }

    @objc func reloadAll() {
        for w in windows { (w.contentView as? WKWebView)?.load(URLRequest(url: wallpaperURL)) }
    }

    // MARK: WKNavigationDelegate

    func webView(_ v: WKWebView, didFinish _: WKNavigation!) {
        pushSafe(force: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.refreshZones() }
    }

    // L'agent n'est pas encore prêt (démarrage de session) : on réessaie.
    func webView(_ v: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError _: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { v.load(URLRequest(url: wallpaperURL)) }
    }

    // Liens externes : navigateur par défaut, la page du fond ne quitte jamais le dojo.
    func webView(_ v: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, u.host != wallpaperURL.host || a.targetFrame == nil {
            NSWorkspace.shared.open(u)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

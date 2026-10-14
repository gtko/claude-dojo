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
    }

    /// Lance le fond d'écran (une seule fois) : fenêtres, observateurs, zone sûre périodique.
    func start() {
        guard !started else { return }
        started = true
        build()
        NotificationCenter.default.addObserver(self, selector: #selector(rebuild), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(reloadAll), name: NSWorkspace.didWakeNotification, object: nil)
        // Stage Manager, Dock, barre de menus peuvent changer à tout moment : on renvoie la zone sûre si elle a bougé
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.pushSafe(force: false) }
    }

    @objc private func rebuild() {
        windows.forEach { $0.close() }
        windows = []
        build()
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

    func webView(_ v: WKWebView, didFinish _: WKNavigation!) { pushSafe(force: true) }

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

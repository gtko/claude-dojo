// Hôte du fond d'écran « Dojo » pour macOS : équivalent de Lively Wallpaper.
// Une fenêtre WebKit sans bordure par écran, posée au niveau du bureau, sur tous les Spaces,
// qui affiche http://localhost:7777/ (servi par agent-mac.js).
// Menu ⛩ dans la barre des menus : mode interactif (clics sur les ninjas, le lecteur…), recharger, quitter.
import Cocoa
import WebKit

let url = URL(string: ProcessInfo.processInfo.environment["DOJO_URL"] ?? "http://localhost:7777/")!
let defaults = UserDefaults.standard

// Le 1er clic sur une fenêtre inactive ne sert d'habitude qu'à l'activer : on le transmet à la page
// (sinon il faut cliquer deux fois sur un ninja, un bouton du lecteur…).
final class Web: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class Wall: NSWindow {
    override var canBecomeKey: Bool { true }      // pour recevoir les clics en mode interactif
}

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var windows: [Wall] = []
    var status: NSStatusItem!
    var interactiveItem: NSMenuItem!
    var sizeItems: [NSMenuItem] = []
    var mirrorItem: NSMenuItem!
    // miroir : panneau système à gauche (à côté de Stage Manager), grande colonne à droite
    var mirror: Bool {
        get { defaults.object(forKey: "mirror") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "mirror"); mirrorItem.state = newValue ? .on : .off; pushSafe(force: true) }
    }
    // Taille de la page : 0 = auto (écran de référence 2560 pt de large, celui du Windows 4K à 150 %)
    var zoomSetting: Double {
        get { defaults.object(forKey: "zoom") as? Double ?? 0 }
        set { defaults.set(newValue, forKey: "zoom"); applyZoom() }
    }
    func zoom(for screen: NSScreen) -> CGFloat {
        zoomSetting > 0 ? CGFloat(zoomSetting) : min(1, max(0.6, (screen.frame.width / 2560 * 100).rounded() / 100))
    }
    var interactive: Bool {
        get { defaults.object(forKey: "interactive") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "interactive"); applyLevel() }
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.title = "⛩"
        let menu = NSMenu()
        interactiveItem = NSMenuItem(title: "Interactif (au-dessus des icônes du bureau)", action: #selector(toggleInteractive), keyEquivalent: "")
        interactiveItem.target = self
        menu.addItem(interactiveItem)
        let reload = NSMenuItem(title: "Recharger", action: #selector(reloadAll), keyEquivalent: "r"); reload.target = self
        menu.addItem(reload)
        mirrorItem = NSMenuItem(title: "Inverser gauche / droite", action: #selector(toggleMirror), keyEquivalent: "")
        mirrorItem.target = self
        mirrorItem.state = mirror ? .on : .off
        menu.addItem(mirrorItem)
        let size = NSMenuItem(title: "Taille", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for (t, z) in [("Auto (selon l'écran)", 0.0), ("70 %", 0.7), ("75 %", 0.75), ("80 %", 0.8), ("85 %", 0.85), ("90 %", 0.9), ("100 %", 1.0)] {
            let i = NSMenuItem(title: t, action: #selector(pickSize(_:)), keyEquivalent: "")
            i.target = self; i.representedObject = z
            sub.addItem(i); sizeItems.append(i)
        }
        size.submenu = sub
        menu.addItem(size)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quitter le Dojo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        status.menu = menu

        build()
        NotificationCenter.default.addObserver(self, selector: #selector(rebuild), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(reloadAll), name: NSWorkspace.didWakeNotification, object: nil)
        // Stage Manager, Dock, barre de menus peuvent changer à tout moment : on renvoie la zone sûre si elle a bougé
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.pushSafe(force: false) }
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
    var lastSafe: [String] = []
    func pushSafe(force: Bool) {
        let cur = windows.map { safe(for: $0.screen ?? NSScreen.main!) }
        if !force && cur == lastSafe { return }
        lastSafe = cur
        for (w, js) in zip(windows, cur) { (w.contentView as? WKWebView)?.evaluateJavaScript("window.setSafe && setSafe(\(js))") }
    }
    func webView(_ v: WKWebView, didFinish _: WKNavigation!) { pushSafe(force: true) }

    @objc func rebuild() { windows.forEach { $0.close() }; windows = []; build() }

    func build() {
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
            web.load(URLRequest(url: url))
            w.orderFront(nil)
            windows.append(w)
        }
        applyLevel()
        applyZoom()
    }

    @objc func toggleMirror() { mirror.toggle() }
    @objc func pickSize(_ i: NSMenuItem) { zoomSetting = i.representedObject as? Double ?? 0 }
    func applyZoom() {
        for w in windows { (w.contentView as? WKWebView)?.pageZoom = zoom(for: w.screen ?? NSScreen.main!) }
        for i in sizeItems { i.state = (i.representedObject as? Double) == zoomSetting ? .on : .off }
        pushSafe(force: true)
    }

    func applyLevel() {
        // interactif : juste au-dessus des icônes du Finder (qui sinon captent tous les clics du bureau)
        let level = interactive ? Int(CGWindowLevelForKey(.desktopIconWindow)) + 1 : Int(CGWindowLevelForKey(.desktopWindow))
        for w in windows { w.level = NSWindow.Level(rawValue: level); w.ignoresMouseEvents = !interactive; w.orderFront(nil) }
        interactiveItem?.state = interactive ? .on : .off
    }

    @objc func toggleInteractive() { interactive.toggle() }
    @objc func reloadAll() { for w in windows { (w.contentView as? WKWebView)?.load(URLRequest(url: url)) } }

    // L'agent n'est pas encore prêt (démarrage de session) : on réessaie.
    func webView(_ v: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError _: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { v.load(URLRequest(url: url)) }
    }
    // Liens externes : navigateur par défaut, la page du fond ne quitte jamais le dojo.
    func webView(_ v: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, u.host != url.host || a.targetFrame == nil { NSWorkspace.shared.open(u); decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

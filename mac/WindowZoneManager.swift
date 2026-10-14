// Zone de travail : garde les fenêtres des autres apps hors des panneaux du fond d'écran, grâce à l'API Accessibilité.
//
// - Aucune action Accessibilité sans autorisation (AXIsProcessTrusted) : sans elle, l'option reste inactive et l'app
//   affiche « Autorisation requise » (menu et Réglages).
// - Les notifications (AXObserver) arrivent sur le fil principal, qui se contente de les transmettre : toute lecture ou
//   écriture d'attribut Accessibilité (échange avec l'app visée, qui peut bloquer) se fait sur une file dédiée.
// - Une fenêtre n'est recadrée qu'après 150 ms sans mouvement, jamais pendant que le bouton de la souris est enfoncé,
//   et ses propres déplacements sont ignorés (plus un coupe-circuit si une app résiste).
// - Chaque appel Accessibilité a un timeout de 0,25 s : une app bloquée ne retarde pas les autres.
// - La géométrie (zone, recadrage) est dans WindowZoneGeometry.swift, testée en CI.
import Cocoa
import ApplicationServices

/// Clé de dictionnaire pour un AXUIElement (égalité et hachage Core Foundation).
private struct AXKey: Hashable {
    let element: AXUIElement
    static func == (a: AXKey, b: AXKey) -> Bool { CFEqual(a.element, b.element) }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
}

/// Apps observées : un AXObserver par processus, avec les fenêtres déjà suivies.
private final class AppWatch {
    let pid: pid_t
    let observer: AXObserver
    let element: AXUIElement
    var windows = Set<AXKey>()

    init(pid: pid_t, observer: AXObserver, element: AXUIElement) {
        self.pid = pid
        self.observer = observer
        self.element = element
    }
}

private let axCallback: AXObserverCallback = { _, element, notification, refcon in
    guard let refcon else { return }
    Unmanaged<WindowZoneManager>.fromOpaque(refcon).takeUnretainedValue().received(element, notification as String)
}

final class WindowZoneManager: @unchecked Sendable {
    // MARK: Interface (fil principal)

    /// Appelé sur le fil principal quand l'état (autorisation, activité) change : le menu se remet à jour.
    var onStateChange: (() -> Void)?

    /// L'app a-t-elle l'autorisation Accessibilité ? Ne déclenche aucune fenêtre système.
    static var isTrusted: Bool { AXIsProcessTrusted() }

    /// Actif = option cochée ET autorisation accordée.
    private(set) var isActive = false
    private(set) var isEnabled = false

    private let hotKeys = WindowZoneHotKeys()
    private var trustTimer: Timer?
    private var trustTimerInterval: TimeInterval = 0
    /// Délai de chaque appel Accessibilité : une app bloquée ne retarde pas les autres de plus de ce délai par appel.
    private static let axTimeout: Float = 0.25

    /// Raccourcis ⌃⌥ refusés par le système (déjà utilisés par un autre outil). Vide si tout est en place.
    var refusedHotKeys: [String] { hotKeys.refused }
    private var observers: [NSObjectProtocol] = []

    init() {
        hotKeys.onAction = { [weak self] action in self?.arrange(action) }
        let ws = NSWorkspace.shared.notificationCenter
        let launch = { [weak self] (note: Notification) in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.queue.asyncAfter(deadline: .now() + 0.4) { self?.attachOrRefresh(app) }   // laisse à l'app le temps d'ouvrir ses fenêtres
        }
        observers.append(ws.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main, using: launch))
        observers.append(ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main, using: launch))
        observers.append(ws.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.queue.async { self?.detach(pid: app.processIdentifier) }
        })
        // Le Réglages Système publie cette notification quand une autorisation Accessibilité change.
        observers.append(DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("com.apple.accessibility.api"), object: nil, queue: .main) { [weak self] _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self?.reconcile() }
        })
    }

    deinit {
        observers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0); DistributedNotificationCenter.default().removeObserver($0) }
        trustTimer?.invalidate()
    }

    /// Réglages courants (relus de config.json). Active ou arrête la surveillance selon l'autorisation.
    func configure(enabled: Bool, exclude: [String]) {
        isEnabled = enabled
        let set = Set(exclude)
        queue.async {
            let changed = set != self.excluded
            self.excluded = set
            if changed && self.running { self.sweep() }     // une app retirée de la liste est recadrée tout de suite
        }
        reconcile()
    }

    /// Zones de travail de chaque écran (repère Accessibilité). Quand elles changent, les fenêtres ouvertes sont revues.
    func update(zones: [ScreenZone]) {
        queue.async {
            guard zones != self.zones else { return }
            self.zones = zones
            if self.running { self.sweep() }
        }
    }

    /// Demande l'autorisation : fenêtre système (qui inscrit l'app dans la liste), puis Réglages Système › Accessibilité.
    static func requestAccess() {
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { Self.openAccessibilitySettings() }
    }

    static func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Applique une action à la fenêtre au premier plan (hors Dojo).
    func arrange(_ action: WindowZoneAction) {
        guard isActive, let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != ownPid else { return }
        let pid = app.processIdentifier
        queue.async { self.arrange(action, pid: pid) }
    }

    /// Recalcule l'état à partir de l'option et de l'autorisation (fil principal).
    func reconcile() {
        let trusted = Self.isTrusted
        let active = isEnabled && trusted
        if active != isActive {
            isActive = active
            let apps = active ? NSWorkspace.shared.runningApplications : []
            queue.async { active ? self.start(apps) : self.stop() }
        }
        hotKeys.setActive(active)      // ne retente que les raccourcis manquants
        // Option cochée : on surveille l'autorisation (la notification système peut manquer), vite tant qu'elle manque,
        // puis plus lentement pour voir une révocation. Sans autorisation, tout s'arrête (stop) au prochain passage.
        if isEnabled {
            let interval: TimeInterval = trusted ? 8 : 2
            if trustTimer == nil || trustTimerInterval != interval {
                trustTimer?.invalidate()
                trustTimerInterval = interval
                trustTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in self?.reconcile() }
            }
        } else {
            trustTimer?.invalidate()
            trustTimer = nil
        }
        onStateChange?()
    }

    // MARK: État confiné à `queue`

    private let queue = DispatchQueue(label: "claude-dojo.window-zone", qos: .utility)
    private let ownPid = ProcessInfo.processInfo.processIdentifier
    private let ownBundle = Bundle.main.bundleIdentifier
    private var running = false
    private var excluded = Set<String>()
    private var zones: [ScreenZone] = []
    private var apps: [pid_t: AppWatch] = [:]
    private var pending: [AXKey: DispatchWorkItem] = [:]
    /// Notifications provoquées par nos propres déplacements : ignorées jusqu'à cette date.
    private var ignoreUntil: [AXKey: Date] = [:]
    /// Dates des derniers recadrages : au-delà de 4 en 3 s, l'app résiste et on la laisse tranquille.
    private var history: [AXKey: [Date]] = [:]

    private func start(_ list: [NSRunningApplication]) {
        guard !running else { return }
        running = true
        for app in list { attach(app) }
        sweep()
    }

    private func stop() {
        guard running else { return }
        running = false
        for pid in Array(apps.keys) { detach(pid: pid) }
        pending.values.forEach { $0.cancel() }
        pending = [:]
        ignoreUntil = [:]
        history = [:]
    }

    private func eligible(_ app: NSRunningApplication) -> Bool {
        guard app.processIdentifier != ownPid, !app.isTerminated, app.activationPolicy == .regular else { return false }
        if let id = app.bundleIdentifier, id == ownBundle { return false }
        return true
    }

    private func attachOrRefresh(_ app: NSRunningApplication) {
        guard running, eligible(app) else { return }
        if let watch = apps[app.processIdentifier] {
            watchWindows(of: watch, evaluateNew: true)
        } else {
            attach(app, evaluateExisting: true)   // app lancée : ses fenêtres existent peut-être déjà
        }
    }

    private func attach(_ app: NSRunningApplication, evaluateExisting: Bool = false) {
        guard running, Self.isTrusted, eligible(app), apps[app.processIdentifier] == nil else { return }
        let pid = app.processIdentifier
        var created: AXObserver?
        guard AXObserverCreate(pid, axCallback, &created) == .success, let observer = created else { return }
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, Self.axTimeout)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        // App pas prête (ou sans Accessibilité) : on n'enregistre rien, une prochaine activation réessaiera.
        guard AXObserverAddNotification(observer, element, kAXWindowCreatedNotification as CFString, refcon) == .success else { return }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        let watch = AppWatch(pid: pid, observer: observer, element: element)
        apps[pid] = watch
        watchWindows(of: watch, evaluateNew: evaluateExisting)
    }

    private func detach(pid: pid_t) {
        guard let watch = apps.removeValue(forKey: pid) else { return }
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(watch.observer), .commonModes)
        for key in watch.windows {
            pending.removeValue(forKey: key)?.cancel()
            ignoreUntil.removeValue(forKey: key)
            history.removeValue(forKey: key)
        }
    }

    /// Suit les fenêtres de l'app qu'on ne suit pas encore (déplacement, redimensionnement, fermeture).
    private func watchWindows(of watch: AppWatch, evaluateNew: Bool) {
        for window in windows(of: watch.element) where !watch.windows.contains(AXKey(element: window)) {
            follow(window, in: watch)
            if evaluateNew { schedule(AXKey(element: window), delay: 0.15) }
        }
    }

    private func follow(_ window: AXUIElement, in watch: AppWatch) {
        let key = AXKey(element: window)
        guard watch.windows.insert(key).inserted else { return }
        AXUIElementSetMessagingTimeout(window, Self.axTimeout)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for name in [kAXMovedNotification, kAXResizedNotification, kAXUIElementDestroyedNotification] {
            _ = AXObserverAddNotification(watch.observer, window, name as CFString, refcon)
        }
    }

    // MARK: Notifications

    /// Fil principal (callback de l'observateur) : transmet à la file, sans toucher à l'API Accessibilité.
    fileprivate func received(_ element: AXUIElement, _ notification: String) {
        queue.async { self.handle(AXKey(element: element), notification) }
    }

    private func handle(_ key: AXKey, _ notification: String) {
        guard running else { return }
        if notification == kAXUIElementDestroyedNotification {
            pending.removeValue(forKey: key)?.cancel()
            ignoreUntil.removeValue(forKey: key)
            history.removeValue(forKey: key)
            for watch in apps.values { watch.windows.remove(key) }
            return
        }
        if notification == kAXWindowCreatedNotification {
            var pid: pid_t = 0
            if AXUIElementGetPid(key.element, &pid) == .success, let app = apps[pid] { follow(key.element, in: app) }
        }
        if let until = ignoreUntil[key], until > Date() { return }   // nos propres déplacements
        schedule(key, delay: 0.15)
    }

    /// Debounce : chaque nouvelle notification repousse l'évaluation.
    private func schedule(_ key: AXKey, delay: TimeInterval) {
        pending.removeValue(forKey: key)?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.pending.removeValue(forKey: key)
            self?.evaluate(key, sweeping: false)
        }
        pending[key] = item
        queue.asyncAfter(deadline: .now() + delay, execute: item)
    }

    // MARK: Évaluation et recadrage

    private func sweep() {
        guard running, Self.isTrusted else { return }
        for watch in Array(apps.values) {
            for window in windows(of: watch.element) { evaluate(AXKey(element: window), sweeping: true) }
        }
    }

    private func evaluate(_ key: AXKey, sweeping: Bool) {
        guard running, !zones.isEmpty, Self.isTrusted else { return }
        let window = key.element
        var pid: pid_t = 0
        guard AXUIElementGetPid(window, &pid) == .success, let app = NSRunningApplication(processIdentifier: pid), eligible(app) else { return }
        if let id = app.bundleIdentifier, excluded.contains(id) { return }
        // L'utilisateur tient la fenêtre : on attend qu'il la lâche.
        if !sweeping, NSEvent.pressedMouseButtons & 1 != 0 {
            schedule(key, delay: 0.15)
            return
        }
        AXUIElementSetMessagingTimeout(window, Self.axTimeout)
        guard isManageable(window), let frame = frame(of: window),
              let index = WindowZoneGeometry.zoneIndex(for: frame, in: zones), WindowZoneGeometry.needsFit(frame, in: zones[index])
        else { return }
        let now = Date()
        let recent = (history[key] ?? []).filter { now.timeIntervalSince($0) < 3 }
        history[key] = recent
        guard recent.count < 4 else { return }
        history[key] = recent + [now]
        place(window, key: key, desired: WindowZoneGeometry.fit(frame, in: zones[index].zone), zone: zones[index].zone)
    }

    /// Fenêtre standard, redimensionnable et déplaçable ; ni plein écran natif, ni minimisée, ni modale.
    /// Les panneaux, dialogues et feuilles n'ont pas le sous-rôle AXStandardWindow.
    private func isManageable(_ window: AXUIElement) -> Bool {
        guard string(window, kAXRoleAttribute) == kAXWindowRole,
              string(window, kAXSubroleAttribute) == kAXStandardWindowSubrole else { return false }
        if bool(window, "AXFullScreen") == true || bool(window, kAXMinimizedAttribute) == true || bool(window, "AXModal") == true { return false }
        return settable(window, kAXSizeAttribute) && settable(window, kAXPositionAttribute)
    }

    /// Place la fenêtre : position, taille, puis relecture. Si l'app a imposé une taille minimale plus grande, on recale la position.
    private func place(_ window: AXUIElement, key: AXKey, desired: CGRect, zone: CGRect) {
        ignoreUntil[key] = Date().addingTimeInterval(0.4)
        setPosition(window, desired.origin)
        setSize(window, desired.size)
        guard let actual = frame(of: window) else { return }
        let final = WindowZoneGeometry.fit(actual, minSize: actual.size, in: zone)
        if abs(final.minX - actual.minX) > 1 || abs(final.minY - actual.minY) > 1 { setPosition(window, final.origin) }
        ignoreUntil[key] = Date().addingTimeInterval(0.4)
    }

    private func arrange(_ action: WindowZoneAction, pid: pid_t) {
        guard running, !zones.isEmpty else { return }
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, Self.axTimeout)
        guard let window = element(appElement, kAXFocusedWindowAttribute), isManageable(window),
              let frame = frame(of: window), let index = WindowZoneGeometry.zoneIndex(for: frame, in: zones) else { return }
        let zone = zones[index].zone
        let desired: CGRect
        switch action {
        case .maximize: desired = zone
        case .leftHalf: desired = WindowZoneGeometry.half(of: zone, .left)
        case .rightHalf: desired = WindowZoneGeometry.half(of: zone, .right)
        }
        place(window, key: AXKey(element: window), desired: desired, zone: zone)
    }

    // MARK: Lecture et écriture d'attributs

    private func windows(of app: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let list = value as? [AXUIElement] else { return [] }
        return list
    }

    private func element(_ parent: AXUIElement, _ attribute: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(parent, attribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private func bool(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return (value as? NSNumber)?.boolValue
    }

    private func settable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var result: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &result) == .success && result.boolValue
    }

    private func frame(of window: AXUIElement) -> CGRect? {
        var position: CFTypeRef?
        var size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position) == .success,
              AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size) == .success,
              let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var extent = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
        return CGRect(origin: origin, size: extent)
    }

    private func setPosition(_ window: AXUIElement, _ point: CGPoint) {
        var p = point
        if let value = AXValueCreate(.cgPoint, &p) { _ = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value) }
    }

    private func setSize(_ window: AXUIElement, _ extent: CGSize) {
        var s = extent
        if let value = AXValueCreate(.cgSize, &s) { _ = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value) }
    }
}

// Menu ⛩ et cycle de vie : fond d'écran, assistant (installation ou réglages), désinstallation.
import Cocoa

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let forceSetup: Bool
    private let wallpaper = WallpaperController()
    // Créé au lancement (contexte MainActor) : l'init reste utilisable depuis le code de haut niveau de main.swift.
    private var runner: SetupRunner!
    private var statusItem: NSStatusItem?
    private var interactiveItem: NSMenuItem?
    private var mirrorItem: NSMenuItem?
    private var sizeItems: [NSMenuItem] = []
    private var zoneMenu: NSMenu?
    private var zoneToggleItem: NSMenuItem?
    private var zoneStatusItem: NSMenuItem?
    private var zoneAccessItem: NSMenuItem?
    private var zoneActionItems: [NSMenuItem] = []
    private var themeMenu: NSMenu?
    private var themeItems: [NSMenuItem] = []
    private var setupWindow: SetupWindowController?
    private var wallpaperStarted = false

    nonisolated init(forceSetup: Bool) {
        self.forceSetup = forceSetup
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        runner = SetupRunner()
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "⛩"
        item.menu = buildMenu()
        statusItem = item
        wallpaper.onChange = { [weak self] in self?.refreshMenu() }
        wallpaper.zoneManager.onStateChange = { [weak self] in self?.refreshMenu() }
        refreshMenu()
        Task { @MainActor in await self.bootstrap() }
        Task { @MainActor in await self.reloadThemes() }
    }

    // MARK: Menu

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        let interactive = action("Interactif (au-dessus des icônes du bureau)", #selector(toggleInteractive))
        interactiveItem = interactive
        menu.addItem(interactive)
        menu.addItem(action("Recharger", #selector(reloadAll), key: "r"))
        let mirror = action("Inverser gauche / droite", #selector(toggleMirror))
        mirrorItem = mirror
        menu.addItem(mirror)
        let size = NSMenuItem(title: "Taille", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        let sizes: [(String, Double)] = [("Auto (selon l'écran)", 0), ("70 %", 0.7), ("75 %", 0.75), ("80 %", 0.8),
                                         ("85 %", 0.85), ("90 %", 0.9), ("100 %", 1.0)]
        for (title, zoom) in sizes {
            let entry = action(title, #selector(pickSize(_:)))
            entry.representedObject = zoom
            sub.addItem(entry)
            sizeItems.append(entry)
        }
        size.submenu = sub
        menu.addItem(size)
        // Thèmes : la liste et les coches sont relues à chaque ouverture du sous-menu (menuWillOpen).
        let theme = NSMenuItem(title: "Thème", action: nil, keyEquivalent: "")
        let themes = NSMenu(title: "Thème")
        themes.delegate = self
        themeMenu = themes
        themes.addItem(.separator())
        themes.addItem(action("Choisir un fond…", #selector(chooseBackground)))
        themes.addItem(action("Fond du thème", #selector(useThemeBackground)))
        theme.submenu = themes
        menu.addItem(theme)
        menu.addItem(buildZoneMenu())
        menu.addItem(.separator())
        menu.addItem(action("Réglages…", #selector(openSettings), key: ","))
        menu.addItem(action("Désinstaller…", #selector(uninstall)))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quitter le Dojo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        return menu
    }

    /// Sous-menu « Zone de travail » : case à cocher, état de l'autorisation Accessibilité, actions sur la fenêtre au premier plan.
    private func buildZoneMenu() -> NSMenuItem {
        let zone = NSMenuItem(title: "Zone de travail", action: nil, keyEquivalent: "")
        let sub = NSMenu(title: "Zone de travail")
        sub.delegate = self
        sub.autoenablesItems = false
        zoneMenu = sub
        let toggle = action("Garder les fenêtres hors des panneaux", #selector(toggleWindowZone))
        zoneToggleItem = toggle
        sub.addItem(toggle)
        let status = NSMenuItem(title: "Autorisation requise (Accessibilité)", action: nil, keyEquivalent: "")
        status.isEnabled = false
        zoneStatusItem = status
        sub.addItem(status)
        let access = action("Autoriser dans Réglages Système…", #selector(requestZoneAccess))
        zoneAccessItem = access
        sub.addItem(access)
        sub.addItem(.separator())
        let actions: [(String, WindowZoneAction, String)] = [
            ("Agrandir dans la zone", .maximize, "\r"),
            ("Moitié gauche de la zone", .leftHalf, String(UnicodeScalar(NSLeftArrowFunctionKey)!)),
            ("Moitié droite de la zone", .rightHalf, String(UnicodeScalar(NSRightArrowFunctionKey)!)),
        ]
        for (title, kind, key) in actions {
            let entry = action(title, #selector(arrangeWindow(_:)), key: key)
            entry.keyEquivalentModifierMask = [.control, .option]
            entry.tag = kind == .maximize ? 0 : (kind == .leftHalf ? 1 : 2)
            zoneActionItems.append(entry)
            sub.addItem(entry)
        }
        zone.submenu = sub
        return zone
    }

    private func action(_ title: String, _ selector: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        return item
    }

    private func refreshMenu() {
        interactiveItem?.state = wallpaper.interactive ? .on : .off
        mirrorItem?.state = wallpaper.mirror ? .on : .off
        for entry in sizeItems {
            entry.state = (entry.representedObject as? Double) == wallpaper.zoomSetting ? .on : .off
        }
        let zone = wallpaper.zoneManager
        let enabled = wallpaper.windowZone.enabled
        zoneToggleItem?.state = enabled ? .on : .off
        let needsAccess = enabled && !WindowZoneManager.isTrusted
        zoneStatusItem?.isHidden = !needsAccess
        zoneAccessItem?.isHidden = !needsAccess
        for entry in zoneActionItems { entry.isEnabled = zone.isActive }
    }

    @objc private func toggleInteractive() { wallpaper.interactive.toggle() }
    @objc private func reloadAll() { wallpaper.reloadAll() }
    @objc private func toggleMirror() { wallpaper.mirror.toggle() }
    @objc private func pickSize(_ sender: NSMenuItem) { wallpaper.zoomSetting = sender.representedObject as? Double ?? 0 }
    @objc private func openSettings() { openSetup(editing: true) }

    // MARK: Zone de travail

    /// Relit windowZone (setup.js window-zone) et l'applique : gestionnaire, mesure des panneaux, menu.
    private func loadWindowZone() async {
        guard let response: WindowZoneResponse = try? await runner.call("window-zone") else { return }
        wallpaper.applyWindowZone(response.windowZone ?? .defaults)
        refreshMenu()
    }

    @objc private func toggleWindowZone() {
        let enable = !wallpaper.windowZone.enabled
        Task { @MainActor in
            do {
                let patch = Data(#"{"windowZone":{"enabled":\#(enable)}}"#.utf8)
                let _: Ack = try await runner.call("write-config", ["-"], stdin: patch)
                await loadWindowZone()
                if enable && !WindowZoneManager.isTrusted { WindowZoneManager.requestAccess() }
            } catch {
                showFailure("Zone de travail non modifiée", error)
            }
        }
    }

    @objc private func requestZoneAccess() { WindowZoneManager.requestAccess() }

    @objc private func arrangeWindow(_ sender: NSMenuItem) {
        let kinds: [WindowZoneAction] = [.maximize, .leftHalf, .rightHalf]
        guard kinds.indices.contains(sender.tag) else { return }
        // Le menu se ferme et rend la main à l'app précédente avant d'agir : la fenêtre visée est celle du premier plan.
        let action = kinds[sender.tag]
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.wallpaper.zoneManager.arrange(action) }
    }

    // MARK: Thèmes et fond d'écran

    /// Relit la liste et le thème courant (setup.js themes) : reconstruit les thèmes si la liste a changé, coches à jour.
    private func reloadThemes() async {
        guard let response: ThemesResponse = try? await runner.call("themes") else { return }
        let list = response.themes ?? []
        if list.map(\.id) != themeItems.compactMap({ $0.representedObject as? String }) {
            rebuildThemeItems(list)
        }
        for item in themeItems {
            item.state = (item.representedObject as? String) == response.theme ? .on : .off
        }
    }

    private func rebuildThemeItems(_ list: [ThemeInfo]) {
        guard let menu = themeMenu else { return }
        themeItems.forEach { menu.removeItem($0) }
        themeItems = list.enumerated().map { index, theme in
            let entry = action(theme.name, #selector(pickTheme(_:)))
            entry.representedObject = theme.id
            menu.insertItem(entry, at: index)
            return entry
        }
    }

    @objc private func pickTheme(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        Task { @MainActor in
            do {
                let _: Ack = try await runner.call("set-theme", [id])
                await reloadThemes()
            } catch {
                showFailure("Thème non appliqué", error)
            }
        }
    }

    @objc private func chooseBackground() {
        guard let path = BackgroundPicker.pick() else { return }
        setBackground(path)
    }

    @objc private func useThemeBackground() { setBackground("default") }

    /// set-background (chemin d'image, ou « default ») en tâche de fond ; l'agent reprend le fond à chaud.
    private func setBackground(_ value: String) {
        Task { @MainActor in
            do {
                let _: Ack = try await runner.call("set-background", [value], timeout: 120)
            } catch {
                showFailure("Fond d'écran non appliqué", error)
            }
        }
    }

    private func showFailure(_ title: String, _ error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = error.localizedDescription
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    // MARK: Démarrage

    private func bootstrap() async {
        var configured: Bool?
        do {
            let status: SetupStatus = try await runner.call("status")
            configured = status.configured ?? false
        } catch {
            fputs("claude-dojo : statut indisponible (\(error.localizedDescription))\n", stderr)
        }
        switch configured {
        case .some(true):
            startWallpaper()
            if forceSetup { openSetup(editing: true) }
        case .some(false):
            openSetup(editing: false)
        case .none:
            // setup.js absent ou en erreur : le fond d'écran reste lancé comme avant
            startWallpaper()
            if forceSetup { openSetup(editing: false) }
        }
    }

    private func startWallpaper() {
        guard !wallpaperStarted else { return }
        wallpaperStarted = true
        wallpaper.start()
        Task { @MainActor in await self.loadWindowZone() }
    }

    func openSetup(editing: Bool) {
        if let window = setupWindow {
            window.showWindow(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let model = SetupModel(runner: runner, editing: editing)
        model.onApplied = { [weak self] in
            self?.startWallpaper()
            Task { @MainActor in await self?.loadWindowZone() }
        }
        model.onClose = { [weak self] in self?.setupWindow?.close() }
        let window = SetupWindowController(model: model)
        window.onWillClose = { [weak self] in self?.setupWindow = nil }
        setupWindow = window
        window.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task { @MainActor in await model.load() }
    }

    // MARK: Désinstallation

    @objc private func uninstall() {
        let alert = NSAlert()
        alert.messageText = "Désinstaller Claude Dojo ?"
        alert.informativeText = "Les démarrages automatiques, les fichiers installés, DojoWallpaper.app et les entrées Dojo de settings.json seront retirés. Le fond d'écran s'arrêtera."
        let purge = NSButton(checkboxWithTitle: "Supprimer aussi la configuration (config.json)", target: nil, action: nil)
        purge.state = .off
        alert.accessoryView = purge
        alert.addButton(withTitle: "Désinstaller")
        alert.addButton(withTitle: "Annuler")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let purgeConfig = purge.state == .on
        Task { @MainActor in
            do {
                let args = [try DojoPaths.json(UninstallOptions(purge: purgeConfig))]
                let result: UninstallResult = try await runner.call("uninstall", args, timeout: 180)
                announceAppLeft(result)
                NSApp.terminate(nil)
            } catch {
                let failure = NSAlert()
                failure.messageText = "Désinstallation impossible"
                failure.informativeText = error.localizedDescription
                failure.runModal()
            }
        }
    }

    /// Dit à l'utilisateur ce qui reste de DojoWallpaper.app, au lieu de le faire disparaître en silence.
    private func announceAppLeft(_ result: UninstallResult) {
        if let remaining = result.appRemaining {
            trashNotice(remaining)
            return
        }
        let running = Bundle.main.bundlePath
        guard running.hasPrefix("/Applications/") else { return }
        if FileManager.default.fileExists(atPath: running) {
            trashNotice(running)
        } else {
            let done = NSAlert()
            done.messageText = "DojoWallpaper.app retiré de /Applications"
            done.informativeText = "Claude Dojo est désinstallé. L'application se ferme."
            NSApp.activate(ignoringOtherApps: true)
            done.runModal()
        }
    }

    private func trashNotice(_ path: String) {
        let alert = NSAlert()
        alert.messageText = "Glisse DojoWallpaper.app dans la Corbeille"
        alert.informativeText = "Claude Dojo est désinstallé. Cette application est dans un dossier que Dojo ne peut pas modifier : \(path)"
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

extension AppDelegate: NSMenuDelegate {
    func menuWillOpen(_ menu: NSMenu) {
        if menu === zoneMenu { refreshMenu() }
        guard menu === themeMenu else { return }
        Task { @MainActor in await reloadThemes() }
    }
}

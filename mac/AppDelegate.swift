// Menu ⛩ et cycle de vie : fond d'écran, assistant (installation ou réglages), désinstallation.
import Cocoa
import Combine

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
    private var themeMenu: NSMenu?
    private var themeItems: [NSMenuItem] = []
    /// Sous-menu « Fonds » : fonds présents du thème actif, relus à chaque ouverture.
    private var backgroundsMenu: NSMenu?
    private var packWallpapers: [LocalWallpaper] = []
    private var activeThemeId = ""
    private var progressCancellable: AnyCancellable?
    private var setupWindow: SetupWindowController?
    private var wallpaperStarted = false
    /// Minuteur du changement automatique de fond (WallpaperAutoChange) ; nil quand le réglage est « jamais ».
    private var autoChangeTimer: Timer?
    private var autoChangeBusy = false

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
        refreshMenu()
        NotificationCenter.default.addObserver(self, selector: #selector(autoChangeSettingChanged),
                                               name: .wallpaperAutoChangeDidChange, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(packDidChange),
                                               name: .wallpaperPackDidChange, object: nil)
        // Progression du téléchargement : le sous-menu « Fonds » affiche « Téléchargement… 5/18 » tant qu'il tourne.
        progressCancellable = WallpaperSyncController.shared.$progress
            .sink { _ in
                Task { @MainActor [weak self] in self?.progressDidChange() }
            }
        scheduleAutoChange()
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
        // Fonds : les fonds présents du thème actif (fond du thème compris), coche sur le courant.
        let backgrounds = NSMenuItem(title: "Fonds", action: nil, keyEquivalent: "")
        let backgroundSub = NSMenu(title: "Fonds")
        backgroundSub.delegate = self
        backgroundsMenu = backgroundSub
        backgrounds.submenu = backgroundSub
        menu.addItem(backgrounds)
        menu.addItem(action("Fonds d'écran…", #selector(openGallery)))
        // ⌘→ : touche de droite, dans la même famille que ⌘R, ⌘, et ⌘Q du menu.
        menu.addItem(action("Fond suivant", #selector(nextWallpaper),
                            key: String(utf16CodeUnits: [unichar(NSRightArrowFunctionKey)], count: 1)))
        menu.addItem(.separator())
        menu.addItem(action("Réglages…", #selector(openSettings), key: ","))
        menu.addItem(action("Désinstaller…", #selector(uninstall)))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quitter le Dojo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        return menu
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
    }

    @objc private func toggleInteractive() { wallpaper.interactive.toggle() }
    @objc private func reloadAll() { wallpaper.reloadAll() }
    @objc private func toggleMirror() { wallpaper.mirror.toggle() }
    @objc private func pickSize(_ sender: NSMenuItem) { wallpaper.zoomSetting = sender.representedObject as? Double ?? 0 }
    @objc private func openSettings() { openSetup(editing: true) }

    // MARK: Thèmes et fond d'écran

    /// Relit la liste et le thème courant (setup.js themes) : reconstruit les thèmes si la liste a changé, coches à jour.
    private func reloadThemes() async {
        guard let response: ThemesResponse = try? await runner.call("themes") else { return }
        activeThemeId = response.theme ?? ""
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
        let name = sender.title
        Task { @MainActor in
            do {
                let response: SetThemeResponse = try await runner.call("set-theme", [id])
                WallpaperSyncController.shared.themeChanged(id, needsSync: response.needsSync, runner: runner)
                await reloadThemes()
                GalleryOffer.offerIfNoDownloads(themeId: id, name: name, hasDownloads: response.hasDownloads, runner: runner)
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

    // MARK: Fonds du thème (sous-menu « Fonds »)

    /// Relit le thème actif et ses fonds présents (`wallpapers local`), puis reconstruit le sous-menu.
    private func refreshPack() async {
        guard let themes: ThemesResponse = try? await runner.call("themes") else { return }
        let theme = themes.theme ?? ""
        guard !theme.isEmpty else { return }
        activeThemeId = theme
        guard let list = try? await GalleryService.localWallpapers(runner: runner, theme: theme) else { return }
        packWallpapers = list
        rebuildBackgroundItems()
    }

    private static let syncItemTag = 1

    /// Progression : le titre de l'item se met à jour sur place (le menu peut être ouvert) ; le sous-menu
    /// n'est reconstruit qu'au début et à la fin du téléchargement.
    private func progressDidChange() {
        guard let menu = backgroundsMenu else { return }
        if let p = WallpaperSyncController.shared.progress, p.running, p.theme == activeThemeId,
           let item = menu.item(withTag: Self.syncItemTag) {
            item.title = "Téléchargement… \(p.done)/\(p.total)"
        } else {
            rebuildBackgroundItems()
        }
    }

    /// Items du sous-menu : progression désactivée pendant un téléchargement, puis un item par fond (coche sur le courant).
    private func rebuildBackgroundItems() {
        guard let menu = backgroundsMenu else { return }
        menu.removeAllItems()
        if let p = WallpaperSyncController.shared.progress, p.running, p.theme == activeThemeId {
            let progressItem = NSMenuItem(title: "Téléchargement… \(p.done)/\(p.total)", action: nil, keyEquivalent: "")
            progressItem.isEnabled = false
            progressItem.tag = Self.syncItemTag
            menu.addItem(progressItem)
            menu.addItem(.separator())
        }
        if packWallpapers.isEmpty {
            let empty = NSMenuItem(title: "Aucun fond pour ce thème", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        }
        for (wallpaper, name) in zip(packWallpapers, LocalWallpaper.names(packWallpapers)) {
            var title = name
            if !wallpaper.isBuiltin, let resolution = wallpaper.resolution { title += " (\(resolution))" }
            let entry = action(title, #selector(pickBackground(_:)))
            entry.representedObject = wallpaper
            entry.state = wallpaper.current == true ? .on : .off
            menu.addItem(entry)
        }
    }

    /// Applique un fond du thème actif (`wallpapers use`), puis relit la liste pour la prochaine ouverture.
    @objc private func pickBackground(_ sender: NSMenuItem) {
        guard let wallpaper = sender.representedObject as? LocalWallpaper, !activeThemeId.isEmpty else { return }
        let theme = activeThemeId
        Task { @MainActor in
            do {
                _ = try await GalleryService.applyBackground(runner: runner, id: wallpaper.id, theme: theme)
                await refreshPack()
            } catch {
                showFailure("Fond d'écran non appliqué", error)
            }
        }
    }

    @objc private func packDidChange() {
        Task { @MainActor in await refreshPack() }
    }

    // MARK: Galerie et fond suivant

    @objc private func openGallery() {
        GalleryWindowController.show(runner: runner, theme: nil)
    }

    /// Fond suivant du thème actif. Sans fond téléchargé (ou en cas d'échec), l'alerte propose d'ouvrir la galerie.
    @objc private func nextWallpaper() {
        Task { @MainActor in
            do {
                _ = try await GalleryService.next(runner: runner)
            } catch {
                let alert = NSAlert()
                alert.alertStyle = .warning
                alert.messageText = "Fond suivant impossible"
                alert.informativeText = GalleryService.plainMessage(error.localizedDescription)
                alert.addButton(withTitle: "Ouvrir la galerie")
                alert.addButton(withTitle: "Fermer")
                NSApp.activate(ignoringOtherApps: true)
                if alert.runModal() == .alertFirstButtonReturn {
                    GalleryWindowController.show(runner: runner, theme: nil)
                }
            }
        }
    }

    // MARK: Changement automatique du fond

    @objc private func autoChangeSettingChanged() { scheduleAutoChange() }

    /// Minuteur reprogrammé à chaque changement du réglage. Il existe même quand la fenêtre Réglages est fermée.
    private func scheduleAutoChange() {
        autoChangeTimer?.invalidate()
        autoChangeTimer = nil
        let seconds = WallpaperAutoChange.seconds
        guard seconds > 0 else { return }
        autoChangeTimer = Timer.scheduledTimer(timeInterval: TimeInterval(seconds), target: self,
                                               selector: #selector(autoChangeTick), userInfo: nil, repeats: true)
    }

    /// Fond suivant à chaque tick. Échecs silencieux (aucun fond téléchargé, par exemple), pas d'appels qui se chevauchent.
    @objc private func autoChangeTick() {
        guard !autoChangeBusy else { return }
        autoChangeBusy = true
        Task { @MainActor in
            defer { autoChangeBusy = false }
            _ = try? await GalleryService.next(runner: runner)
        }
    }

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
            startPackSync()
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
    }

    /// Démarrage (app déjà configurée) : le pack du thème actif est vérifié une fois par session, en arrière-plan.
    private func startPackSync() {
        Task { @MainActor in
            guard let themes: ThemesResponse = try? await runner.call("themes"), let theme = themes.theme else { return }
            activeThemeId = theme
            WallpaperSyncController.shared.ensureSynced(theme, runner: runner)
        }
    }

    func openSetup(editing: Bool) {
        if let window = setupWindow {
            window.showWindow(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let model = SetupModel(runner: runner, editing: editing)
        model.onApplied = { [weak self] in self?.startWallpaper() }
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
        if menu === themeMenu {
            Task { @MainActor in await reloadThemes() }
        } else if menu === backgroundsMenu {
            // Affichage immédiat avec la liste connue, puis relecture : coches et fonds à jour.
            rebuildBackgroundItems()
            Task { @MainActor in await refreshPack() }
        }
    }
}

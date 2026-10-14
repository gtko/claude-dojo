// État de l'assistant (10 étapes) et ses actions : détection, géocodage, aperçu des réglages, application.
import Foundation
import Combine

enum SetupStep: Int, CaseIterable {
    case welcome, dependencies, weather, github, projects, calendars, claude, autostart, theme, done

    var title: String {
        switch self {
        case .welcome: return "Bienvenue"
        case .dependencies: return "Dépendances"
        case .weather: return "Météo"
        case .github: return "GitHub"
        case .projects: return "Projets"
        case .calendars: return "Calendriers"
        case .claude: return "Claude Code"
        case .autostart: return "Démarrage automatique"
        case .theme: return "Thème"
        case .done: return "Terminé"
        }
    }
}

/// Barre de statut Claude Code : remplacer, garder l'existante, ou ne pas y toucher.
enum StatusLinePolicy: String, CaseIterable {
    case replace, keep, none
}

@MainActor
final class SetupModel: ObservableObject {
    let editing: Bool
    let runner: SetupRunner
    let nodeInstaller = NodeInstaller()
    var onApplied: (() -> Void)?
    var onClose: (() -> Void)?
    /// false pour les captures (--snapshot) : aucun appel à setup.js.
    var liveMode = true

    @Published var step: SetupStep = .welcome
    @Published var loading = false
    @Published var loadError: String?
    @Published var detect: DetectResult?
    @Published var brewBusy: String?
    @Published var brewMessage: String?

    // Météo
    @Published var city = ""
    @Published var geoResults: [GeoResult] = []
    @Published var geoBusy = false
    @Published var geoError: String?
    @Published var weather: DojoConfig.Weather?

    // GitHub, projets, calendriers
    @Published var owners: [String] = []
    @Published var roots: [String] = []
    @Published var onlyOwners = false
    @Published var calendars: [String] = []

    // Claude Code
    @Published var hooks = true
    @Published var statusLine: StatusLinePolicy = .replace
    @Published var heavyGate = true
    @Published var vitestWorkers = true
    /// Aperçu : ajouts en phrases courtes, puis diff brut (merge-settings --dry-run, rien n'est écrit).
    @Published var changes: [String] = []
    @Published var diff = ""
    @Published var previewError: String?
    @Published var heavyLimits: HeavyLimits?

    // Thème et fond d'écran : choix appliqués à la validation, avec le reste
    @Published var themes: [ThemeInfo] = []
    @Published var themesLoaded = false
    @Published var themesError: String?
    /// Id du thème sélectionné dans la grille.
    @Published var themeChoice = ""
    /// Fond personnalisé actuel (config.json) : nil = fond du thème.
    @Published private(set) var currentBackground: String?
    /// Fond choisi dans l'assistant ; nil = inchangé.
    @Published var backgroundChange: BackgroundChange?

    // Démarrage et application
    @Published var autostart = true
    @Published var applying = false
    @Published var applied = false
    @Published var log: [String] = []
    @Published var applyError: String?

    private var sentry: JSONValue?
    /// Thème à l'ouverture de l'assistant : seul un choix différent déclenche set-theme.
    private var initialTheme = ""
    private var hadAutostart = false
    private var prefilled = false
    private var cancellables = Set<AnyCancellable>()

    init(runner: SetupRunner, editing: Bool) {
        self.runner = runner
        self.editing = editing
        // Toute modification d'option Claude Code rafraîchit l'aperçu (debounce 300 ms).
        Publishers.CombineLatest4($hooks, $statusLine, $heavyGate, $vitestWorkers)
            .dropFirst()
            .debounce(for: .milliseconds(300), scheduler: DispatchQueue.main)
            .sink { [weak self] _ in
                Task { await self?.refreshPreview() }
            }
            .store(in: &cancellables)
    }

    // MARK: État dérivé

    var nodeOK: Bool { detect?.node?.ok == true }
    var brewPath: String? { detect?.brew?.path }

    var nodeDetail: String {
        guard let node = detect?.node, node.path != nil else {
            return "absent (requis : 18 ou plus récent)"
        }
        let version = node.version ?? "version inconnue"
        return node.ok == true ? version : "\(version), 18 minimum requis"
    }

    var canGoNext: Bool {
        switch step {
        case .dependencies: return nodeOK
        case .calendars: return calendars.allSatisfy { $0.trimmed.isEmpty || DojoConfig.isCalendarURL($0.trimmed) }
        case .done: return false
        default: return true
        }
    }

    var statusLineLabel: String {
        switch statusLine {
        case .replace: return "remplacée"
        case .keep: return "conservée"
        case .none: return "non gérée"
        }
    }

    /// Nom du thème sélectionné (son id si le nom est inconnu).
    var themeName: String? {
        guard !themeChoice.isEmpty else { return nil }
        return themes.first { $0.id == themeChoice }?.name ?? themeChoice
    }

    /// Fond qui sera utilisé : le choix en attente, sinon le fond actuel.
    private var effectiveBackground: BackgroundChange {
        if let change = backgroundChange { return change }
        guard let current = currentBackground else { return .theme }
        return .file(current)
    }

    /// Libellé du fond : « fond du thème » ou « image « nom.jpg » ».
    var backgroundLabel: String {
        switch effectiveBackground {
        case .theme: return "fond du thème"
        case .file(let path): return "image « \((path as NSString).lastPathComponent) »"
        }
    }

    var backgroundUsesTheme: Bool {
        if case .theme = effectiveBackground { return true }
        return false
    }

    var summary: [String] {
        let validOwners = owners.filter { !$0.trimmed.isEmpty }.count
        let validRoots = roots.filter { !$0.trimmed.isEmpty }.count
        let validCalendars = calendars.filter { DojoConfig.isCalendarURL($0.trimmed) }.count
        let meteo: String
        if let w = weather {
            meteo = "\(w.name ?? "") (\(String(format: "%.2f", w.lat ?? 0)), \(String(format: "%.2f", w.lon ?? 0)))"
        } else {
            meteo = "désactivée"
        }
        return [
            "Node.js : " + (detect?.node?.version ?? "non détecté"),
            "Météo : " + meteo,
            "GitHub : \(validOwners) propriétaire(s)",
            "Projets : \(validRoots) dossier(s), " + (onlyOwners ? "dépôts des propriétaires seulement" : "tous les dépôts"),
            "Calendriers : \(validCalendars)",
            "Thème : " + (themeName ?? "non disponible"),
            "Fond : " + backgroundLabel,
            "Claude Code : hooks Dojo \(hooks ? "oui" : "non"), barre de statut \(statusLineLabel), heavy-gate \(heavyGate ? "oui" : "non"), VITEST_MAX_WORKERS \(vitestWorkers ? "oui" : "non")",
            "Démarrage automatique : " + autostartLabel
        ]
    }

    /// Dojo lancé depuis le DMG monté ou une copie translocée : les LaunchAgents seraient installés vers un chemin temporaire.
    static func appLocationWarning(for bundlePath: String) -> String? {
        guard bundlePath.hasPrefix("/Volumes/") || bundlePath.contains("/AppTranslocation/") else { return nil }
        return "Dojo est lancé depuis le disque d'installation ou une copie temporaire : le démarrage automatique ne peut pas être installé. Déplace DojoWallpaper.app dans Applications puis relance-la."
    }

    var appLocationWarning: String? { Self.appLocationWarning(for: Bundle.main.bundlePath) }

    private var autostartLabel: String {
        if !autostart { return "non" }
        return appLocationWarning == nil ? "oui" : "bloqué (app hors Applications)"
    }

    // MARK: Chargement

    func load() async {
        loading = true
        await refreshDetect()
        await loadThemes()
        loading = false
    }

    /// Liste des thèmes, thème courant et fond actuel (`setup.js themes`). Appelée à l'ouverture de l'assistant.
    func loadThemes() async {
        guard liveMode else { return }
        defer { themesLoaded = true }
        do {
            let response: ThemesResponse = try await runner.call("themes")
            themes = response.themes ?? []
            initialTheme = response.theme ?? ""
            themeChoice = initialTheme
            currentBackground = response.background
            themesError = nil
        } catch {
            themesError = error.localizedDescription
        }
    }

    /// Revient au fond du thème : annule un fichier choisi, sans rien écrire avant « Appliquer ».
    func resetBackground() {
        backgroundChange = currentBackground == nil ? nil : .theme
    }

    /// Relit `detect`. Pré-remplit l'assistant la première fois seulement, pour ne pas écraser une saisie.
    func refreshDetect() async {
        do {
            let result: DetectResult = try await runner.call("detect")
            detect = result
            loadError = nil
            if !prefilled {
                prefill(result)
                await refreshPreview()
            }
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func prefill(_ d: DetectResult) {
        prefilled = true
        if let c = d.config {
            if let w = c.weather, let name = w.name, let lat = w.lat, let lon = w.lon {
                weather = DojoConfig.Weather(name: name, lat: lat, lon: lon, timezone: w.timezone)
                city = name
            }
            owners = c.github?.owners ?? []
            roots = c.projects?.roots ?? []
            onlyOwners = c.projects?.onlyOwners ?? false
            calendars = c.calendars ?? []
            sentry = c.sentry
        }
        statusLine = (d.settings?.statusLine?.isPresent ?? false) ? .keep : .replace
        heavyGate = !(d.settings?.heavyGatePerso ?? false)
        hadAutostart = d.install?.launchAgents?.isPresent ?? false
        autostart = hadAutostart || !editing
    }

    // MARK: Navigation

    func next() async {
        guard canGoNext, let target = SetupStep(rawValue: step.rawValue + 1) else { return }
        step = target
        if target == .claude { await refreshPreview() }
    }

    func back() {
        guard let previous = SetupStep(rawValue: step.rawValue - 1) else { return }
        step = previous
    }

    func close() { onClose?() }

    // MARK: Dépendances

    func installNode() async {
        guard await nodeInstaller.install() != nil else { return }
        await refreshDetect()
    }

    /// `brew install <formule>` (Homebrew présent uniquement), puis relecture de detect.
    func brewInstall(_ formula: String) async {
        guard let brew = brewPath else {
            brewMessage = "Homebrew introuvable."
            return
        }
        brewBusy = formula
        brewMessage = nil
        defer { brewBusy = nil }
        do {
            let result = try await ProcessRunner.run(URL(fileURLWithPath: brew), ["install", formula], timeout: 900)
            if result.status == 0 {
                brewMessage = "\(formula) installé."
            } else {
                brewMessage = "brew install \(formula) a échoué : \(ProcessRunner.tail(result.stderr))"
            }
        } catch {
            brewMessage = error.localizedDescription
        }
        await refreshDetect()
    }

    // MARK: Météo

    func geocode() async {
        let query = city.trimmed
        guard !query.isEmpty, liveMode else { return }
        geoBusy = true
        geoError = nil
        geoResults = []
        defer { geoBusy = false }
        do {
            let response: GeoResponse = try await runner.call("geocode", [query], timeout: 30)
            geoResults = (response.results ?? []).filter { $0.lat != nil && $0.lon != nil }
            if geoResults.isEmpty { geoError = "Aucun résultat pour « \(query) »." }
        } catch {
            geoError = error.localizedDescription
        }
    }

    func choose(_ result: GeoResult) {
        weather = DojoConfig.Weather(name: result.name, lat: result.lat, lon: result.lon, timezone: result.timezone)
    }

    func clearWeather() {
        weather = nil
        city = ""
        geoResults = []
        geoError = nil
    }

    // MARK: Aperçu et configuration

    func mergeOptions(dryRun: Bool) -> MergeOptions {
        MergeOptions(hooks: hooks, statusLine: statusLine.rawValue, heavyGate: heavyGate,
                     vitestWorkers: vitestWorkers, dryRun: dryRun)
    }

    /// Aperçu des modifications de settings.json (dryRun), sans rien écrire.
    func refreshPreview() async {
        guard liveMode, detect != nil else { return }
        do {
            let args = [try DojoPaths.json(mergeOptions(dryRun: true))]
            let result: MergeResult = try await runner.call("merge-settings", args)
            diff = result.diff ?? ""
            changes = SettingsChanges.lines(before: result.before, after: result.after)
            heavyLimits = HeavyLimits(result.heavyGateThresholds)
            previewError = nil
        } catch {
            previewError = error.localizedDescription
        }
    }

    func buildConfig() -> DojoConfig {
        DojoConfig(
            weather: weather,
            calendars: calendars.map { $0.trimmed }.filter { DojoConfig.isCalendarURL($0) },
            github: DojoConfig.GitHub(owners: owners.map { $0.trimmed }.filter { !$0.isEmpty }),
            projects: DojoConfig.Projects(roots: roots.map { $0.trimmed }.filter { !$0.isEmpty }, onlyOwners: onlyOwners),
            sentry: sentry)
    }

    // MARK: Application

    private func note(_ line: String) { log.append(line) }

    /// Applique la configuration : fichiers, config.json, settings.json, LaunchAgents, agent, fond d'écran.
    func apply() async {
        guard !applying, !applied, detect != nil else { return }
        applying = true
        applyError = nil
        log = []
        defer { applying = false }
        // Le node détecté n'est utilisé que s'il est assez récent (ok:true) ; sinon on en cherche un autre.
        var nodeExe = detect?.node?.ok == true ? (detect?.node?.path ?? "") : ""
        if nodeExe.isEmpty, let found = await DojoPaths.findNode() { nodeExe = found.path }
        do {
            note("Copie des fichiers dans \(DojoPaths.configDir.path)…")
            let _: Ack = try await runner.call("install-files", [runner.runtimeDir.path], timeout: 120)

            note("Écriture de config.json…")
            // JSON envoyé sur stdin (« - ») : la config contient des secrets (sentry), jamais dans argv.
            let config = try DojoPaths.json(buildConfig())
            let _: Ack = try await runner.call("write-config", ["-"], stdin: Data(config.utf8))

            try await applyTheme()

            note("Mise à jour de settings.json…")
            let merge = try DojoPaths.json(mergeOptions(dryRun: false))
            let _: MergeResult = try await runner.call("merge-settings", ["-"], timeout: 120, stdin: Data(merge.utf8))

            let launch = try DojoPaths.json(LaunchOptions(node: nodeExe, app: Bundle.main.bundlePath, dryRun: false))
            if autostart, appLocationWarning != nil {
                // Depuis le DMG, les LaunchAgents pointeraient vers un chemin qui disparaît à l'éjection : on ne les installe pas.
                note("Démarrage automatique non installé : Déplace DojoWallpaper.app dans Applications puis relance-la.")
            } else if autostart {
                note("Démarrage automatique (LaunchAgents)…")
                let _: Ack = try await runner.call("launchagents", ["install", launch])
            } else if hadAutostart {
                note("Retrait du démarrage automatique…")
                let _: Ack = try await runner.call("launchagents", ["uninstall", launch])
            }

            note("Lancement de l'agent…")
            await ensureAgent(nodeExe: nodeExe)

            applied = true
            onApplied?()
            note("Terminé. Le fond d'écran est lancé.")
        } catch {
            applyError = error.localizedDescription
            note("Échec : \(error.localizedDescription)")
        }
    }

    /// Thème et fond choisis. Après write-config : config.json existe et garde ces champs. Rien n'est appelé si le choix est inchangé.
    private func applyTheme() async throws {
        if !themeChoice.isEmpty, themeChoice != initialTheme {
            note("Thème : \(themeName ?? themeChoice)…")
            let _: Ack = try await runner.call("set-theme", [themeChoice])
        }
        switch backgroundChange {
        case .theme?:
            note("Fond d'écran : fond du thème…")
            let _: Ack = try await runner.call("set-background", ["default"])
        case .file(let path)?:
            note("Fond d'écran : copie de l'image choisie…")
            let _: Ack = try await runner.call("set-background", [path], timeout: 120)
        case nil:
            break
        }
    }

    /// launchd a peut-être déjà démarré l'agent (port 7777 unique) : on ne le relance que si besoin.
    private func ensureAgent(nodeExe: String) async {
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        let status: SetupStatus? = try? await runner.call("status")
        if status?.agentRunning == true {
            note("Agent déjà actif.")
            return
        }
        do {
            try runner.startAgent(node: URL(fileURLWithPath: nodeExe), dir: DojoPaths.configDir)
            note("Agent lancé (node agent-mac.js).")
        } catch {
            note("Agent non lancé : \(error.localizedDescription)")
        }
    }
}

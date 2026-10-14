// Téléchargement automatique du pack du thème actif (`wallpapers sync <thème>`, long). Une opération à la fois,
// file d'attente pour les autres thèmes, progression lue par `wallpapers progress` toutes les 2 s, notification à la fin.
// Aucune alerte : un échec s'affiche discrètement dans la vue (WallpaperBandView).
import Cocoa
import Combine

extension Notification.Name {
    /// Envoyée à la fin d'un téléchargement de pack (userInfo["theme"]) : les vues et le menu relisent `wallpapers local`.
    static let wallpaperPackDidChange = Notification.Name("io.github.claude-dojo.wallpaperPackDidChange")
}

/// Progression d'un pack. `running` vient de `wallpapers progress` ; total 0 tant que le pack n'est pas compté.
struct PackProgress: Equatable {
    let theme: String
    let done: Int
    let total: Int
    let running: Bool
}

/// Dernier échec de téléchargement, avec le texte déjà formulé pour l'affichage discret.
struct PackFailure: Equatable {
    let theme: String
    let message: String
}

/// `wallpapers sync <thème>` : `stopped` renseigné quand le téléchargement s'arrête avant la fin ; `alreadyRunning` si un autre tient le verrou.
struct PackSyncResponse: Decodable {
    let theme: String?
    let total: Int?
    let stopped: String?
    let alreadyRunning: Bool?
}

/// `wallpapers progress <thème>`
struct PackProgressResponse: Decodable {
    let theme: String?
    let running: Bool?
    let total: Int?
    let done: Int?
}

/// Écriture de l'option : `write-config` avec `{"wallpapers":{"autoDownload":…}}` sur stdin (fusion, le reste de config.json est gardé).
struct AutoDownloadPatch: Encodable {
    struct Wallpapers: Encodable {
        let autoDownload: Bool
    }
    let wallpapers: Wallpapers
}

@MainActor
final class WallpaperSyncController: ObservableObject {
    static let shared = WallpaperSyncController()

    /// Progression du téléchargement en cours (nil quand aucun ne tourne).
    @Published private(set) var progress: PackProgress?
    /// Dernier échec, affiché discrètement dans l'étape Thème et les Réglages.
    @Published private(set) var failure: PackFailure?
    /// Option « Télécharger automatiquement le pack du thème » (wallpapers.autoDownload). Vraie par défaut. Une désactivation
    /// bloque les lancements automatiques ; le téléchargement manuel depuis la galerie reste possible.
    @Published private(set) var autoDownload = true
    /// Message discret quand l'option n'a pas pu être écrite dans config.json.
    @Published private(set) var autoDownloadMessage: String?

    /// Thème en cours de téléchargement, et file d'attente des autres thèmes.
    private(set) var current: String?
    private var queue: [(theme: String, runner: SetupRunner)] = []
    /// Thèmes déjà vérifiés pour cette session (démarrage ou fin de l'assistant) : pas de nouvelle vérification.
    private var checked = Set<String>()
    /// Écritures de l'option, enchaînées : deux bascules rapides ne se doublent pas dans config.json.
    private var autoDownloadWrites: Task<Void, Never>?

    /// Valeur lue dans `themes` : à chaque lecture, avant tout lancement automatique.
    func adoptAutoDownload(_ value: Bool) {
        autoDownload = value
    }

    /// Bascule de l'option : effet immédiat sur les lancements automatiques, puis écriture dans config.json.
    /// Un échec remet la valeur précédente (si aucune autre bascule n'a suivi) et affiche un message discret.
    func setAutoDownload(_ value: Bool, runner: SetupRunner) {
        let previous = autoDownload
        autoDownload = value
        autoDownloadMessage = nil
        let earlier = autoDownloadWrites
        autoDownloadWrites = Task { @MainActor in
            await earlier?.value
            do {
                let patch = try DojoPaths.json(AutoDownloadPatch(wallpapers: .init(autoDownload: value)))
                let _: Ack = try await runner.call("write-config", ["-"], stdin: Data(patch.utf8))
            } catch {
                if self.autoDownload == value { self.autoDownload = previous }
                self.autoDownloadMessage = "Option non enregistrée : \(error.localizedDescription)"
            }
        }
    }

    /// Premier lancement après l'assistant, ou démarrage de l'app : une fois par session et par thème.
    /// `wallpapers sync` ne télécharge que ce qui manque : sans rien à faire, il répond aussitôt.
    /// Option désactivée : rien n'est lancé.
    func ensureSynced(_ theme: String, runner: SetupRunner) {
        guard autoDownload, !theme.isEmpty, !checked.contains(theme) else { return }
        checked.insert(theme)
        enqueue(theme, runner: runner)
    }

    /// Changement de thème : lance le téléchargement seulement si `set-theme` indique needsSync et que l'option est active.
    /// Un thème déjà en cours ou en attente n'est pas ajouté une seconde fois.
    func themeChanged(_ theme: String, needsSync: Bool?, runner: SetupRunner) {
        guard autoDownload, needsSync == true else { return }
        enqueue(theme, runner: runner)
    }

    /// Affichage d'une progression fabriquée, pour les captures (--snapshot). Aucun téléchargement n'est lancé.
    func showFixture(progress fixture: PackProgress?) {
        progress = fixture
    }

    private func enqueue(_ theme: String, runner: SetupRunner) {
        guard current != theme, !queue.contains(where: { $0.theme == theme }) else { return }
        queue.append((theme: theme, runner: runner))
        startNext()
    }

    private func startNext() {
        guard current == nil, !queue.isEmpty else { return }
        let next = queue.removeFirst()
        current = next.theme
        failure = nil
        Task { @MainActor in await self.run(next.theme, runner: next.runner) }
    }

    private func run(_ theme: String, runner: SetupRunner) async {
        // Sondage : tant que le téléchargement tourne, la progression suit. Une réponse arrivée après l'arrêt est ignorée.
        let poll = Task { @MainActor in
            while !Task.isCancelled {
                let response: PackProgressResponse? = try? await runner.call("wallpapers", ["progress", theme], timeout: 15)
                if !Task.isCancelled, let response {
                    self.progress = PackProgress(theme: theme, done: response.done ?? 0, total: response.total ?? 0,
                                                 running: response.running ?? false)
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }

        var message: String?
        do {
            let response: PackSyncResponse = try await runner.call("wallpapers", ["sync", theme], timeout: 1800)
            if response.alreadyRunning != true, let stopped = response.stopped, !stopped.isEmpty {
                message = stopped
            }
        } catch {
            message = error.localizedDescription
        }
        poll.cancel()
        progress = nil
        if let message {
            failure = PackFailure(theme: theme, message: "Téléchargement interrompu : \(message)")
        }
        current = nil
        NotificationCenter.default.post(name: .wallpaperPackDidChange, object: nil, userInfo: ["theme": theme])
        startNext()
    }
}

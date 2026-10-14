// Liens entre les réglages et la galerie de fonds d'écran : proposition après un changement de thème sans fond
// téléchargé, et intervalle de changement automatique (UserDefaults de l'app, jamais config.json).
import Cocoa

extension Notification.Name {
    /// Envoyée quand l'intervalle de changement automatique change. La valeur se relit dans WallpaperAutoChange.seconds.
    static let wallpaperAutoChangeDidChange = Notification.Name("io.github.claude-dojo.wallpaperAutoChangeDidChange")
}

/// Une option du réglage « Changer de fond automatiquement ».
struct AutoChangeOption: Identifiable {
    let seconds: Int
    let label: String
    var id: Int { seconds }
}

/// Intervalle de changement automatique du fond d'écran, en secondes (0 = jamais), dans UserDefaults de l'app.
enum WallpaperAutoChange {
    static let defaultsKey = "wallpaperAutoChange"

    static let options: [AutoChangeOption] = [
        AutoChangeOption(seconds: 0, label: "jamais"),
        AutoChangeOption(seconds: 1800, label: "30 min"),
        AutoChangeOption(seconds: 3600, label: "1 h"),
        AutoChangeOption(seconds: 86400, label: "1 jour"),
    ]

    /// Lecture et écriture. L'écriture prévient l'AppDelegate, qui reprogramme son minuteur.
    static var seconds: Int {
        get { UserDefaults.standard.integer(forKey: defaultsKey) }
        set {
            UserDefaults.standard.set(newValue, forKey: defaultsKey)
            NotificationCenter.default.post(name: .wallpaperAutoChangeDidChange, object: nil)
        }
    }
}

/// Proposition d'ouvrir la galerie quand le thème choisi n'a aucun fond téléchargé. Une seule fois par thème et par session.
@MainActor
enum GalleryOffer {
    private static var offered = Set<String>()

    /// Ne propose que si hasDownloads vaut false : une réponse sans cette information ne déclenche rien.
    /// L'alerte est présentée dans sa propre tâche : l'appelant (changement de thème) ne l'attend pas.
    static func offerIfNoDownloads(themeId: String, name: String, hasDownloads: Bool?, runner: SetupRunner) {
        guard hasDownloads == false, !offered.contains(themeId) else { return }
        offered.insert(themeId)
        let alert = NSAlert()
        alert.messageText = "Ouvrir la galerie de fonds pour ce thème ?"
        alert.informativeText = "« \(name) » n'a encore aucun fond téléchargé. Tant que la galerie est vide, le fond généré du thème reste utilisé."
        alert.addButton(withTitle: "Ouvrir")
        alert.addButton(withTitle: "Plus tard")
        NSApp.activate(ignoringOtherApps: true)
        Task { @MainActor in
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            GalleryWindowController.show(runner: runner, theme: themeId)
        }
    }
}

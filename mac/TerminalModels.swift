// Options terminal (Ghostty, Terminal.app, message d'accueil zsh) : formes de `node setup.js terminal status|apply|remove`
// et ouverture du profil Terminal. Terminal.app ouvert : Dojo n'écrit pas dans ses réglages, le fichier .terminal
// s'ouvre pour un double-clic (import fait par Terminal).
import Cocoa

/// Options cochées, mêmes clés que setup.js (config.json, clé terminal). Absente = désactivée.
struct TerminalOptions: Codable, Equatable {
    var ghostty: Bool
    var terminalApp: Bool
    var welcome: Bool

    private enum CodingKeys: String, CodingKey { case ghostty, terminalApp, welcome }

    init(ghostty: Bool = false, terminalApp: Bool = false, welcome: Bool = false) {
        self.ghostty = ghostty
        self.terminalApp = terminalApp
        self.welcome = welcome
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ghostty = try container.decodeIfPresent(Bool.self, forKey: .ghostty) ?? false
        terminalApp = try container.decodeIfPresent(Bool.self, forKey: .terminalApp) ?? false
        welcome = try container.decodeIfPresent(Bool.self, forKey: .welcome) ?? false
    }

    /// Aucune option cochée.
    var isEmpty: Bool { self == TerminalOptions() }

    /// Options cochées dans les deux ensembles.
    func intersection(_ other: TerminalOptions) -> TerminalOptions {
        TerminalOptions(ghostty: ghostty && other.ghostty,
                        terminalApp: terminalApp && other.terminalApp,
                        welcome: welcome && other.welcome)
    }

    /// Options cochées ici et absentes de `other`.
    func subtracting(_ other: TerminalOptions) -> TerminalOptions {
        TerminalOptions(ghostty: ghostty && !other.ghostty,
                        terminalApp: terminalApp && !other.terminalApp,
                        welcome: welcome && !other.welcome)
    }
}

/// Une cible (Ghostty, Terminal.app, zsh) telle que `terminal status` la décrit. `running` : Terminal.app seulement.
struct TerminalTarget: Decodable {
    let applied: Bool?
    let available: Bool?
    let running: Bool?
}

/// Réponse de `terminal status` : options enregistrées et état réel.
struct TerminalStatus: Decodable {
    let options: TerminalOptions?
    let ghostty: TerminalTarget?
    let terminalApp: TerminalTarget?
    let welcome: TerminalTarget?
}

/// Résultat d'une cible de `terminal apply` ou `remove`. action : imported, unchanged, open-file, removed, skipped, none…
struct TerminalAction: Decodable {
    let action: String?
    let file: String?
    let running: Bool?
}

/// Réponse de `terminal apply` et `terminal remove` (une entrée par cible, absente si non concernée).
struct TerminalApplyResult: Decodable {
    let ghostty: TerminalAction?
    let terminalApp: TerminalAction?
    let welcome: TerminalAction?

    /// Fichier .terminal à ouvrir : Terminal.app est ouvert, le profil doit être importé par double-clic.
    var profileToOpen: String? {
        guard terminalApp?.action == "open-file" else { return nil }
        return terminalApp?.file
    }
}

/// Réponse de `set-theme` : `terminal` seulement quand des options terminal étaient actives (fichiers régénérés).
struct ThemeChangeResult: Decodable {
    let terminal: TerminalApplyResult?
}

/// Ouvre le profil Terminal (.terminal) : Terminal l'importe quand on le valide. Demande avant, pour ne rien ouvrir à l'improviste.
enum TerminalProfile {
    @MainActor
    static func offerOpen(_ file: String) {
        let alert = NSAlert()
        alert.messageText = "Importer le profil dans Terminal"
        alert.informativeText = "Terminal est ouvert : Dojo n'écrit pas dans ses réglages pendant qu'il tourne. Le profil s'ouvre pour que tu l'importes (double-clic)."
        alert.addButton(withTitle: "Ouvrir le profil")
        alert.addButton(withTitle: "Plus tard")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        if !NSWorkspace.shared.open(URL(fileURLWithPath: file)) {
            let failure = NSAlert()
            failure.alertStyle = .warning
            failure.messageText = "Profil non ouvert"
            failure.informativeText = "Ouvre ce fichier avec Terminal : \(file)"
            failure.runModal()
        }
    }
}

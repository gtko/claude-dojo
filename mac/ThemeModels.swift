// Thèmes et fonds d'écran : forme de la réponse de `node setup.js themes`, choix de fond, sélecteur d'image.
import Cocoa
import UniformTypeIdentifiers

/// Un thème tel que `setup.js themes` le décrit. La vignette est un chemin absolu, facultatif.
struct ThemeInfo: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let thumbnail: String?

    /// Logo du terminal (terminal/logo.png, dans le dossier du thème, à côté de la vignette). nil si absent.
    var terminalLogo: String? {
        guard let thumbnail else { return nil }
        let logo = URL(fileURLWithPath: thumbnail)
            .deletingLastPathComponent()
            .appendingPathComponent("terminal/logo.png")
            .path
        return FileManager.default.fileExists(atPath: logo) ? logo : nil
    }
}

/// Réponse de `setup.js themes` : liste, thème courant et fond personnalisé (nil = fond du thème).
struct ThemesResponse: Decodable {
    let themes: [ThemeInfo]?
    let theme: String?
    let background: String?
}

/// Fond choisi dans l'assistant : le fond du thème, ou une image à copier (set-background).
enum BackgroundChange: Equatable {
    case theme
    case file(String)
}

/// Sélecteur d'image de fond (jpg, png, heic, webp). Renvoie le chemin, ou nil si annulé.
enum BackgroundPicker {
    @MainActor
    static func pick() -> String? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.jpeg, .png, .heic, .webP]
        panel.message = "Choisis une image de fond (jpg, png, heic ou webp)."
        panel.prompt = "Choisir"
        guard panel.runModal() == .OK else { return nil }
        return panel.url?.path
    }
}

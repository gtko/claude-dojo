// Formes des réponses de `node setup.js wallpapers …`. Seul l'identifiant est obligatoire : un autre champ
// absent ou nul ne bloque pas la fenêtre. Les réponses de `themes` sont dans ThemeModels.swift.
import Foundation

/// Fond d'écran des listes « Sélection » et « Plus ». `file` (chemin local) n'est présent qu'une fois téléchargé.
struct WallpaperItem: Decodable, Identifiable, Equatable {
    let id: String
    let resolution: String?
    /// Vignette distante : utilisée seulement si elle passe GalleryLinks.thumbnailURL.
    let thumb: String?
    /// Page de la source : ouverte seulement si elle passe GalleryLinks.sourceURL.
    let source: String?
    let purity: String?
    let downloaded: Bool?
    let file: String?

    init(
        id: String,
        resolution: String? = nil,
        thumb: String? = nil,
        source: String? = nil,
        purity: String? = nil,
        downloaded: Bool? = nil,
        file: String? = nil
    ) {
        self.id = id
        self.resolution = resolution
        self.thumb = thumb
        self.source = source
        self.purity = purity
        self.downloaded = downloaded
        self.file = file
    }

    var isDownloaded: Bool { downloaded == true }
}

/// Entrée ignorée par `wallpapers list`, avec sa raison.
struct SkippedWallpaper: Decodable {
    let id: String?
    let reason: String?
}

/// `wallpapers list <theme>`
struct WallpaperListResponse: Decodable {
    let theme: String?
    let query: String?
    let wallpapers: [WallpaperItem]?
    let skipped: [SkippedWallpaper]?
}

/// `wallpapers search <theme> <page>` : `lastPage` borne la pagination.
struct WallpaperSearchResponse: Decodable {
    let theme: String?
    let page: Int?
    let lastPage: Int?
    let wallpapers: [WallpaperItem]?
}

/// Fond déjà présent pour un thème (`wallpapers local <theme>`). `current` marque le fond appliqué.
/// `builtin` : fond embarqué du thème (id « theme »), appliqué avec `wallpapers use theme`, sans second argument.
struct LocalWallpaper: Decodable, Identifiable, Equatable {
    static let builtinID = "theme"

    let id: String
    let file: String?
    let source: String?
    let resolution: String?
    let current: Bool?
    let builtin: Bool?

    var isBuiltin: Bool { builtin == true }

    /// Même forme que WallpaperItem, pour afficher les téléchargés dans la grille.
    var item: WallpaperItem {
        WallpaperItem(id: id, resolution: resolution, source: source, downloaded: true, file: file)
    }

    /// Libellés des fonds d'un thème, dans l'ordre reçu : « Fond du thème » pour le fond embarqué, « Fond 1 », « Fond 2 »… sinon.
    static func names(_ list: [LocalWallpaper]) -> [String] {
        var number = 0
        return list.map { wallpaper in
            if wallpaper.isBuiltin { return "Fond du thème" }
            number += 1
            return "Fond \(number)"
        }
    }
}

/// `wallpapers local <theme>`
struct WallpaperLocalResponse: Decodable {
    let theme: String?
    let wallpapers: [LocalWallpaper]?
}

/// `wallpapers download <id> <theme>`
struct WallpaperDownloadResponse: Decodable {
    let id: String?
    let theme: String?
    let file: String?
    let source: String?
    let resolution: String?
}

/// `wallpapers use <id|chemin>`
struct WallpaperUseResponse: Decodable {
    let background: String?
    let theme: String?
    let id: String?
}

/// `wallpapers next`
struct WallpaperNextResponse: Decodable {
    let background: String?
    let theme: String?
    let id: String?
    let count: Int?
}

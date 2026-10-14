// Zone de travail : configuration (clé windowZone de config.json) et actions sur la fenêtre au premier plan.
import Foundation

/// `windowZone` de config.json. Désactivée par défaut ; les valeurs par défaut sont aussi celles de `setup.js window-zone`.
struct WindowZoneConfig: Codable, Equatable {
    var enabled = false
    /// Marge (pt) laissée entre les panneaux et les fenêtres.
    var margin: Double = 8
    /// true : le bandeau horloge / météo est réservé en plus des colonnes latérales.
    var reserveTop = true
    /// Bundle ids des apps jamais recadrées.
    var exclude: [String] = []

    static let defaults = WindowZoneConfig()
    static let marginRange: ClosedRange<Double> = 0...64
}

/// Réponse de `setup.js window-zone`.
struct WindowZoneResponse: Decodable {
    let windowZone: WindowZoneConfig?
}

/// Actions appliquées à la fenêtre au premier plan (menu, raccourcis ⌃⌥).
enum WindowZoneAction: Equatable {
    case maximize, leftHalf, rightHalf
}

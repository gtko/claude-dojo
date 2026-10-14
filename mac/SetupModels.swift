// Formes des réponses de `node setup.js` et des options envoyées. Tous les champs de réponse sont optionnels :
// un champ absent ou d'un autre type ne bloque pas l'assistant.
import Foundation

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// Enveloppe commune : {"ok":true,…} ou {"ok":false,"error":"…"}.
struct Envelope: Decodable {
    let ok: Bool?
    let error: String?
}

/// Réponse sans donnée utile (install-files, write-config, launchagents…).
struct Ack: Decodable {}

struct SetupStatus: Decodable {
    let configured: Bool?
    let agentRunning: Bool?
    let launchAgentsLoaded: Bool?
}

struct NodeInfo: Decodable {
    let path: String?
    let version: String?
    let ok: Bool?
}

/// Outil optionnel : accepte "/chemin", true/false ou {"path": "…"}.
struct ToolInfo: Decodable {
    let path: String?
    let present: Bool

    private enum Keys: String, CodingKey { case path }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer() {
            if let text = try? single.decode(String.self) {
                path = text.isEmpty ? nil : text
                present = !text.isEmpty
                return
            }
            if let flag = try? single.decode(Bool.self) {
                path = nil
                present = flag
                return
            }
        }
        let container = try decoder.container(keyedBy: Keys.self)
        path = try? container.decodeIfPresent(String.self, forKey: .path)
        present = path != nil
    }
}

struct GhInfo: Decodable {
    let path: String?
    let authed: Bool?
}

struct SettingsInfo: Decodable {
    let path: String?
    let exists: Bool?
    let statusLine: JSONValue?
    let heavyGatePerso: Bool?
    let hooksDojo: Bool?
}

struct InstallInfo: Decodable {
    let installed: Bool?
    let configDir: String?
    let configExists: Bool?
    let launchAgents: JSONValue?
}

/// Réponse de `detect`. Chaque champ est décodé séparément : un champ mal formé est ignoré, pas tout le résultat.
struct DetectResult: Decodable {
    let node: NodeInfo?
    let brew: ToolInfo?
    let macmon: ToolInfo?
    let mediaControl: ToolInfo?
    let gh: GhInfo?
    let claude: ToolInfo?
    let settings: SettingsInfo?
    let install: InstallInfo?
    let config: DojoConfig?
    let home: String?
    let arch: String?

    private enum Keys: String, CodingKey {
        case node, brew, macmon, mediaControl, gh, claude, settings, install, config, home, arch
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        node = try? c.decodeIfPresent(NodeInfo.self, forKey: .node)
        brew = try? c.decodeIfPresent(ToolInfo.self, forKey: .brew)
        macmon = try? c.decodeIfPresent(ToolInfo.self, forKey: .macmon)
        mediaControl = try? c.decodeIfPresent(ToolInfo.self, forKey: .mediaControl)
        gh = try? c.decodeIfPresent(GhInfo.self, forKey: .gh)
        claude = try? c.decodeIfPresent(ToolInfo.self, forKey: .claude)
        settings = try? c.decodeIfPresent(SettingsInfo.self, forKey: .settings)
        install = try? c.decodeIfPresent(InstallInfo.self, forKey: .install)
        config = try? c.decodeIfPresent(DojoConfig.self, forKey: .config)
        home = try? c.decodeIfPresent(String.self, forKey: .home)
        arch = try? c.decodeIfPresent(String.self, forKey: .arch)
    }
}

struct GeoResponse: Decodable {
    let results: [GeoResult]?
}

struct GeoResult: Decodable, Identifiable {
    let name: String?
    let country: String?
    let lat: Double?
    let lon: Double?
    let timezone: String?

    var id: String { "\(name ?? "")|\(lat ?? 0)|\(lon ?? 0)" }
    var label: String { [name, country].compactMap { $0 }.joined(separator: ", ") }
}

struct MergeResult: Decodable {
    let changed: Bool?
    let diff: String?
    let before: JSONValue?
    let after: JSONValue?
    let heavyGateThresholds: JSONValue?
}

/// Seuils heavy-gate de ce Mac, calculés par setup.js (même formule que heavy-gate.js).
struct HeavyLimits {
    /// Suites lourdes en parallèle (HEAVY_GATE_MAX).
    let suites: Int
    /// Processus node simultanés (HEAVY_GATE_MAX_NODE).
    let nodes: Int
}

extension HeavyLimits {
    init?(_ value: JSONValue?) {
        guard case .object(let entries)? = value,
              case .number(let suites)? = entries["HEAVY_GATE_MAX"],
              case .number(let nodes)? = entries["HEAVY_GATE_MAX_NODE"] else { return nil }
        self.init(suites: Int(suites), nodes: Int(nodes))
    }
}

/// Ajouts de settings.json en phrases courtes, à partir des `before` et `after` de merge-settings.
/// Niveau 2 pour hooks et env (hooks.SessionStart, env.VITEST_MAX_WORKERS), premier niveau pour le reste (statusLine).
enum SettingsChanges {
    static func lines(before: JSONValue?, after: JSONValue?) -> [String] {
        let old = leaves(before)
        let new = leaves(after)
        var lines: [String] = []
        for path in new.keys.sorted() {
            guard let value = new[path] else { continue }
            if let previous = old[path] {
                if previous != value { lines.append("modifié : \(path)") }
            } else {
                lines.append("ajouté : \(path)")
            }
        }
        for path in old.keys.sorted() where new[path] == nil {
            lines.append("retiré : \(path)")
        }
        return lines
    }

    private static func leaves(_ root: JSONValue?) -> [String: String] {
        guard case .object(let top)? = root else { return [:] }
        var out: [String: String] = [:]
        for (key, value) in top {
            if key == "hooks" || key == "env", case .object(let inner) = value {
                for (name, item) in inner { out["\(key).\(name)"] = (try? DojoPaths.json(item)) ?? "" }
            } else {
                out[key] = (try? DojoPaths.json(value)) ?? ""
            }
        }
        return out
    }
}

/// Format de ~/.config/claude-dojo/config.json (sentry est conservé tel quel).
struct DojoConfig: Codable {
    var weather: Weather?
    var calendars: [String]?
    var github: GitHub?
    var projects: Projects?
    var sentry: JSONValue?

    private enum CodingKeys: String, CodingKey { case weather, calendars, github, projects, sentry }

    /// Écriture vers setup.js : `weather` part toujours (null quand la météo est désactivée, pour retirer l'ancienne ville).
    /// Les autres sections absentes ne sont pas envoyées : setup.js les garde telles quelles.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(weather, forKey: .weather)
        try c.encodeIfPresent(calendars, forKey: .calendars)
        try c.encodeIfPresent(github, forKey: .github)
        try c.encodeIfPresent(projects, forKey: .projects)
        try c.encodeIfPresent(sentry, forKey: .sentry)
    }

    struct Weather: Codable {
        var name: String?
        var lat: Double?
        var lon: Double?
        var timezone: String?
    }

    struct GitHub: Codable {
        var owners: [String]?
    }

    struct Projects: Codable {
        var roots: [String]?
        var onlyOwners: Bool?
    }

    /// Mêmes formats que le collecteur : https://, http:// ou webcal://.
    static func isCalendarURL(_ text: String) -> Bool {
        text.hasPrefix("https://") || text.hasPrefix("http://") || text.hasPrefix("webcal://")
    }
}

struct MergeOptions: Encodable {
    let hooks: Bool
    let statusLine: String
    let heavyGate: Bool
    let vitestWorkers: Bool
    let dryRun: Bool
}

struct LaunchOptions: Encodable {
    let node: String
    let app: String
    let dryRun: Bool
}

struct UninstallOptions: Encodable {
    let purge: Bool
}

/// Réponse de `setup.js uninstall` : bundles DojoWallpaper.app retirés, et celui qui reste si son dossier n'est pas inscriptible.
struct UninstallResult: Decodable {
    let appRemoved: [String]?
    let appRemaining: String?
}

/// Valeur JSON quelconque (formes non figées côté setup.js : statusLine, launchAgents, seuils, sentry).
enum JSONValue: Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "valeur JSON non prise en charge")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// Présent et utile : non nul, non faux, non vide.
    var isPresent: Bool {
        switch self {
        case .null: return false
        case .bool(let b): return b
        case .array(let a): return !a.isEmpty
        default: return true
        }
    }

    var display: String {
        switch self {
        case .null: return "—"
        case .bool(let b): return b ? "oui" : "non"
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .string(let s): return s
        case .array(let a): return a.map { $0.display }.joined(separator: ", ")
        case .object: return "{…}"
        }
    }
}

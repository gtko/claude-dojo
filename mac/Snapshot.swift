// --snapshot <dossier> : rend chaque étape de l'assistant et la fenêtre galerie (gallery.png) en PNG (échelle 2), avec des données factices.
// Aucun réseau, aucun appel à setup.js, aucune écriture hors du dossier demandé.
import Cocoa
import SwiftUI

@MainActor
enum SnapshotRenderer {
    static let names = ["welcome", "dependencies", "weather", "github", "projects", "calendars", "claude", "autostart", "theme", "done"]

    static func run(into dir: String) -> Int32 {
        let out = URL(fileURLWithPath: dir, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        } catch {
            fputs("snapshot : dossier inaccessible (\(error.localizedDescription))\n", stderr)
            return 1
        }

        let model = SetupModel.fixture(runner: SetupRunner())
        let size = NSSize(width: SetupLayout.width, height: SetupLayout.height)
        // Fenêtre sans bordure : sans fond explicite, les captures sortaient transparentes.
        // Fond opaque (couleur de fenêtre) et mode sombre fixe, pour des PNG lisibles tels quels.
        let dark = NSAppearance(named: .darkAqua)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = true
        window.backgroundColor = .windowBackgroundColor
        window.appearance = dark
        for (index, step) in SetupStep.allCases.enumerated() {
            model.step = step
            // L'étape Thème (grille, bande des fonds, réglages du fond) dépasse la hauteur de l'assistant :
            // elle est capturée en entier, à la hauteur de son contenu, sans défilement.
            let unclipped = step == .theme
            // Un hôte neuf par étape : hors écran, la barre de progression (NSProgressIndicator) garde sinon
            // la valeur de l'étape précédente. Créé après le changement d'étape, elle part de la bonne valeur.
            let content = SetupWizardView(model: model, unclipped: unclipped)
                .background(Color(nsColor: .windowBackgroundColor))
            let host = NSHostingView(rootView: content)
            host.appearance = dark
            var pageSize = size
            if unclipped {
                host.frame = NSRect(origin: .zero, size: NSSize(width: size.width, height: 2400))
                host.layoutSubtreeIfNeeded()
                pageSize = NSSize(width: size.width, height: ceil(host.fittingSize.height))
            }
            host.frame = NSRect(origin: .zero, size: pageSize)
            window.contentView = host
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
            host.layoutSubtreeIfNeeded()

            let file = out.appendingPathComponent("setup-0\(index + 1)-\(names[index]).png")
            guard writePNG(host, size: pageSize, to: file) else { return 1 }
            print(file.path)
        }

        // Fenêtre « Fonds d'écran » (taille de GalleryWindowController : 900 × 640), données factices de GalleryView.mock().
        let gallerySize = NSSize(width: 900, height: 640)
        let gallery = NSHostingView(rootView: GalleryView.mock()
            .frame(width: gallerySize.width, height: gallerySize.height)
            .background(Color(nsColor: .windowBackgroundColor)))
        gallery.appearance = dark
        gallery.frame = NSRect(origin: .zero, size: gallerySize)
        window.contentView = gallery
        gallery.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        gallery.layoutSubtreeIfNeeded()
        let galleryFile = out.appendingPathComponent("gallery.png")
        guard writePNG(gallery, size: gallerySize, to: galleryFile) else { return 1 }
        print(galleryFile.path)
        return 0
    }

    /// PNG à l'échelle 2 du contenu de `view`. false si le bitmap, l'encodage ou l'écriture échoue (message sur stderr).
    private static func writePNG(_ view: NSView, size: NSSize, to file: URL) -> Bool {
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(size.width) * 2,
            pixelsHigh: Int(size.height) * 2,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0)
        else {
            fputs("snapshot : bitmap impossible\n", stderr)
            return false
        }
        rep.size = size
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            fputs("snapshot : encodage PNG impossible\n", stderr)
            return false
        }
        do {
            try png.write(to: file)
        } catch {
            fputs("snapshot : écriture impossible (\(error.localizedDescription))\n", stderr)
            return false
        }
        return true
    }
}

extension SetupModel {
    /// Données factices pour les captures : rien n'est lu sur la machine, rien n'est lancé.
    static func fixture(runner: SetupRunner) -> SetupModel {
        let model = SetupModel(runner: runner, editing: false)
        model.liveMode = false

        let detectJSON = """
        {"node":{"path":"/Users/exemple/.config/claude-dojo/node/bin/node","version":"v22.11.0","ok":true},
         "brew":{"path":"/opt/homebrew/bin/brew"},
         "macmon":null,
         "mediaControl":{"path":"/opt/homebrew/bin/media-control"},
         "gh":{"path":"/opt/homebrew/bin/gh","authed":false},
         "claude":{"path":"/opt/homebrew/bin/claude"},
         "settings":{"path":"/Users/exemple/.claude/settings.json","exists":true,
                     "statusLine":{"type":"command","command":"ancienne-barre.js"},
                     "heavyGatePerso":false,"hooksDojo":false},
         "install":{"installed":false,"configDir":"/Users/exemple/.config/claude-dojo","configExists":false,"launchAgents":false},
         "config":null,"home":"/Users/exemple","arch":"arm64"}
        """
        model.detect = try? JSONDecoder().decode(DetectResult.self, from: Data(detectJSON.utf8))

        let geoJSON = """
        {"results":[{"name":"Paris","country":"France","lat":48.8566,"lon":2.3522,"timezone":"Europe/Paris"}]}
        """
        model.city = "Paris"
        model.geoResults = (try? JSONDecoder().decode(GeoResponse.self, from: Data(geoJSON.utf8)))?.results ?? []
        model.weather = DojoConfig.Weather(name: "Paris", lat: 48.8566, lon: 2.3522, timezone: "Europe/Paris")

        model.owners = ["acme-labs", "exemple-org"]
        model.roots = ["~/Projets", "~/Code/clients"]
        model.onlyOwners = true
        model.calendars = ["https://calendar.example.com/feed.ics"]

        model.statusLine = .keep
        model.heavyGate = true
        model.vitestWorkers = true
        // Seuils de ce Mac (12 cœurs, 18 Go) : mêmes valeurs que setup.js renvoie pour heavy-gate.
        model.heavyLimits = HeavyLimits(suites: 4, nodes: 36)
        // Ajouts repris de la sortie réelle de merge-settings --dry-run (statusLine conservée, hooks et env ajoutés).
        model.changes = [
            "ajouté : env.VITEST_MAX_WORKERS",
            "ajouté : hooks.Notification",
            "ajouté : hooks.PreToolUse",
            "ajouté : hooks.SessionEnd",
            "ajouté : hooks.SessionStart",
            "ajouté : hooks.Stop",
            "ajouté : hooks.UserPromptSubmit"
        ]
        // Début du diff brut réel (chemins normalisés) ; la liste ci-dessus en donne l'ensemble.
        model.diff = #"""
        +   },
        +   "hooks": {
        +     "SessionStart": [
        +       {
        +         "hooks": [
        +           {
        +             "type": "command",
        +             "command": "\"/Users/exemple/.local/bin/node\" \"/Users/exemple/.config/claude-dojo/hook.js\"",
        +             "async": true
        +           }
        +         ]
        +       }
        """#
        model.autostart = true

        // Thèmes factices, sans vignettes (cadres neutres) : mêmes ids et noms que src/themes.
        model.themes = [
            ThemeInfo(id: "naruto", name: "Naruto", thumbnail: nil),
            ThemeInfo(id: "stargate-sg1", name: "Stargate SG-1", thumbnail: nil),
            ThemeInfo(id: "demon-slayer", name: "Demon Slayer", thumbnail: nil),
            ThemeInfo(id: "frieren", name: "Frieren", thumbnail: nil),
            ThemeInfo(id: "one-piece", name: "One Piece", thumbnail: nil),
            ThemeInfo(id: "my-hero-academia", name: "My Hero Academia", thumbnail: nil),
            ThemeInfo(id: "jujutsu-kaisen", name: "Jujutsu Kaisen", thumbnail: nil),
            ThemeInfo(id: "mushoku-tensei", name: "Mushoku Tensei", thumbnail: nil)
        ]
        model.themesLoaded = true
        model.themeChoice = "stargate-sg1"

        // Bande des fonds du thème choisi (appliqué : la bande est utilisable). Vignettes dessinées en code, sans fichier lu.
        model.initialTheme = "stargate-sg1"
        let pack: [(id: String, resolution: String?, current: Bool, builtin: Bool, colors: (NSColor, NSColor))] = [
            ("7x2k9q", "3840x2160", true, false, (NSColor(calibratedRed: 0.10, green: 0.16, blue: 0.32, alpha: 1), NSColor(calibratedRed: 0.52, green: 0.24, blue: 0.42, alpha: 1))),
            ("o5m8dp", "2560x1440", false, false, (NSColor(calibratedRed: 0.06, green: 0.36, blue: 0.40, alpha: 1), NSColor(calibratedRed: 0.22, green: 0.58, blue: 0.42, alpha: 1))),
            ("pd3wz1", "1920x1080", false, false, (NSColor(calibratedRed: 0.55, green: 0.22, blue: 0.14, alpha: 1), NSColor(calibratedRed: 0.90, green: 0.55, blue: 0.22, alpha: 1))),
            ("theme", nil, false, true, (NSColor(calibratedRed: 0.14, green: 0.15, blue: 0.18, alpha: 1), NSColor(calibratedRed: 0.36, green: 0.40, blue: 0.48, alpha: 1))),
        ]
        model.packWallpapers = pack.map { entry in
            let path = "/fixture/stargate-sg1/\(entry.id).jpg"
            PackThumbnails.store(fixtureThumbnail(from: entry.colors.0, to: entry.colors.1), for: path)
            return LocalWallpaper(id: entry.id, file: path, source: nil, resolution: entry.resolution,
                                  current: entry.current, builtin: entry.builtin)
        }
        // Téléchargement en cours : 5 fonds sur 18, affiché dans la bande et dans le sous-menu.
        WallpaperSyncController.shared.showFixture(progress: PackProgress(theme: "stargate-sg1", done: 5, total: 18, running: true))
        return model
    }

    /// Dégradé dessiné en code, en guise de vignette (aucune image tierce).
    private static func fixtureThumbnail(from: NSColor, to: NSColor) -> NSImage {
        NSImage(size: NSSize(width: 320, height: 200), flipped: false) { rect in
            NSGradient(starting: from, ending: to)?.draw(in: rect, angle: -30)
            NSColor.white.withAlphaComponent(0.14).setFill()
            let diameter = rect.height * 0.5
            NSBezierPath(ovalIn: NSRect(x: rect.width * 0.62, y: rect.height * 0.3, width: diameter, height: diameter)).fill()
            return true
        }
    }
}

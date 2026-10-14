// Accès aux fonds d'écran : appels `node setup.js wallpapers …` via SetupRunner, vignettes (cache mémoire seulement)
// et liens autorisés. GalleryProviding permet de remplacer ce service par des données factices.
import Cocoa
import ImageIO

/// Liens acceptés par la fenêtre : https uniquement, hôtes fixes, sans identifiants ni port explicite.
enum GalleryLinks {
    static let thumbnailHosts: Set<String> = ["th.wallhaven.cc", "w.wallhaven.cc"]
    static let sourceHosts: Set<String> = ["wallhaven.cc", "www.wallhaven.cc"]

    static func thumbnailURL(_ text: String?) -> URL? {
        secureURL(text, hosts: thumbnailHosts)
    }

    static func sourceURL(_ text: String?) -> URL? {
        secureURL(text, hosts: sourceHosts)
    }

    private static func secureURL(_ text: String?, hosts: Set<String>) -> URL? {
        guard let text = text?.trimmingCharacters(in: .whitespaces),
              let url = URL(string: text),
              url.scheme?.lowercased() == "https",
              url.user == nil,
              url.port == nil,
              let host = url.host?.lowercased(),
              hosts.contains(host) else { return nil }
        return url
    }
}

/// Ce dont la fenêtre a besoin. GalleryService l'implémente avec setup.js ; MockGalleryProvider sans réseau.
@MainActor
protocol GalleryProviding: AnyObject {
    func themes() async throws -> ThemesResponse
    func list(theme: String) async throws -> WallpaperListResponse
    func search(theme: String, page: Int) async throws -> WallpaperSearchResponse
    func local(theme: String) async throws -> WallpaperLocalResponse
    func download(id: String, theme: String) async throws -> WallpaperDownloadResponse
    /// Applique un fond du thème donné (`wallpapers use <id> <theme>`).
    func use(id: String, theme: String) async throws -> WallpaperUseResponse
    /// Vignette, ou nil si elle est absente ou refusée par GalleryLinks.
    func thumbnail(for item: WallpaperItem) async -> NSImage?
    /// Vignette déjà disponible, sans attente (nil sinon). Permet un premier rendu sans tâche asynchrone.
    func cachedThumbnail(for item: WallpaperItem) -> NSImage?
}

/// Implémentation réelle : chaque méthode lance `node setup.js wallpapers <commande>` avec son délai.
@MainActor
final class GalleryService: GalleryProviding {
    private let runner: SetupRunner
    private let thumbnails = ThumbnailCache()

    init(runner: SetupRunner) {
        self.runner = runner
    }

    func themes() async throws -> ThemesResponse {
        try await runner.call("themes", timeout: 30)
    }

    func list(theme: String) async throws -> WallpaperListResponse {
        try await runner.call("wallpapers", ["list", theme], timeout: 90)
    }

    func search(theme: String, page: Int) async throws -> WallpaperSearchResponse {
        try await runner.call("wallpapers", ["search", theme, String(page)], timeout: 90)
    }

    func local(theme: String) async throws -> WallpaperLocalResponse {
        try await runner.call("wallpapers", ["local", theme], timeout: 30)
    }

    func download(id: String, theme: String) async throws -> WallpaperDownloadResponse {
        try await runner.call("wallpapers", ["download", id, theme], timeout: 180)
    }

    func use(id: String, theme: String) async throws -> WallpaperUseResponse {
        try await GalleryService.applyBackground(runner: runner, id: id, theme: theme)
    }

    func thumbnail(for item: WallpaperItem) async -> NSImage? {
        await thumbnails.image(for: item)
    }

    func cachedThumbnail(for item: WallpaperItem) -> NSImage? {
        thumbnails.cached(for: item)
    }

    /// Passe au fond suivant du thème courant ; renvoie l'identifiant du nouveau fond.
    static func next(runner: SetupRunner) async throws -> String {
        let response: WallpaperNextResponse = try await runner.call("wallpapers", ["next"], timeout: 180)
        guard let id = response.id, !id.isEmpty else {
            throw SetupError("Fond suivant : réponse sans identifiant.")
        }
        return id
    }

    /// Fonds présents pour un thème (`wallpapers local`), fond embarqué compris.
    static func localWallpapers(runner: SetupRunner, theme: String) async throws -> [LocalWallpaper] {
        let response: WallpaperLocalResponse = try await runner.call("wallpapers", ["local", theme], timeout: 30)
        return response.wallpapers ?? []
    }

    /// Applique un fond. Wallhaven : `use <id> <thème>`. Fond embarqué : `use theme`, sans second argument (le thème actif).
    static func applyBackground(runner: SetupRunner, id: String, theme: String) async throws -> WallpaperUseResponse {
        let args = id == LocalWallpaper.builtinID ? ["use", id] : ["use", id, theme]
        return try await runner.call("wallpapers", args, timeout: 60)
    }

    /// Message pour une personne : les conseils de ligne de commande entre parenthèses (« (wallpapers download <id>) ») sont retirés.
    static func plainMessage(_ text: String) -> String {
        let stripped = text.replacingOccurrences(of: #"\s*\((?:wallpapers|node setup\.js)[^)]*\)"#, with: "", options: .regularExpression)
        let trimmed = stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "Erreur inconnue." }
        return String(first).uppercased() + String(trimmed.dropFirst())
    }
}

/// Vignettes : cache mémoire (NSCache) seulement. Téléchargement https via une session éphémère (aucun cache disque),
/// délai 15 s. Un fond déjà téléchargé sans vignette valide est lu depuis son fichier, réduit à 480 px.
@MainActor
final class ThumbnailCache {
    private let cache = NSCache<NSString, NSImage>()
    private let session: URLSession
    private var pending: [String: Task<Data?, Never>] = [:]

    init() {
        cache.countLimit = 200
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 15
        session = URLSession(configuration: configuration)
    }

    func image(for item: WallpaperItem) async -> NSImage? {
        if let url = GalleryLinks.thumbnailURL(item.thumb) {
            return await remote(url)
        }
        if let path = item.file, path.hasPrefix("/") {
            return await local(path)
        }
        return nil
    }

    /// Image déjà en cache (aucun chargement).
    func cached(for item: WallpaperItem) -> NSImage? {
        if let url = GalleryLinks.thumbnailURL(item.thumb) {
            return cache.object(forKey: url.absoluteString as NSString)
        }
        if let path = item.file, path.hasPrefix("/") {
            return cache.object(forKey: ("file:" + path) as NSString)
        }
        return nil
    }

    /// Téléchargement partagé entre les cellules qui demandent la même vignette. Les octets (Data) traversent
    /// la tâche ; le NSImage est construit ensuite sur le fil principal.
    private func remote(_ url: URL) async -> NSImage? {
        let key = url.absoluteString
        if let hit = cache.object(forKey: key as NSString) { return hit }
        let task: Task<Data?, Never>
        if let running = pending[key] {
            task = running
        } else {
            let session = self.session
            task = Task<Data?, Never> {
                let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
                do {
                    let (data, response) = try await session.data(for: request)
                    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
                    return data
                } catch {
                    return nil
                }
            }
            pending[key] = task
        }
        let data = await task.value
        pending[key] = nil
        guard let data, let image = NSImage(data: data) else { return nil }
        cache.setObject(image, forKey: key as NSString)
        return image
    }

    private func local(_ path: String) async -> NSImage? {
        let key = "file:" + path
        if let hit = cache.object(forKey: key as NSString) { return hit }
        guard let cgImage = await Task.detached(priority: .utility, operation: { ThumbnailCache.downsampled(path: path) }).value else {
            return nil
        }
        let image = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
        cache.setObject(image, forKey: key as NSString)
        return image
    }

    /// Image réduite par ImageIO : un fond 4K n'est pas décodé en entier pour une vignette.
    nonisolated static func downsampled(path: String, maxPixel: Int = 480) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}

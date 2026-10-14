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

/// Fichiers locaux d'un fond. Seuls les chemins réels situés dans le dossier des fonds (DojoPaths.configDir/backgrounds)
/// sont lus ; le fond embarqué d'un thème (builtin) doit se trouver dans DojoPaths.runtimeDir/themes. Les liens
/// symboliques sont résolus avant ce contrôle, et la lecture se fait sur ce chemin réel.
enum LocalWallpaperFiles {
    /// Chemin réel à lire, ou nil si le fichier est absent ou hors du dossier autorisé.
    static func readablePath(_ path: String, builtin: Bool) -> String? {
        guard path.hasPrefix("/"), let real = realPath(path) else { return nil }
        let root = builtin
            ? DojoPaths.runtimeDir.appendingPathComponent("themes", isDirectory: true)
            : DojoPaths.configDir.appendingPathComponent("backgrounds", isDirectory: true)
        guard let rootReal = realPath(root.path), real.hasPrefix(rootReal + "/") else { return nil }
        return real
    }

    /// Chemin canonique (liens symboliques et « .. » résolus), nil si le chemin n'existe pas.
    static func realPath(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    /// Clé du cache pour un fichier local : le fond embarqué et un fichier téléchargé ne partagent jamais une entrée.
    static func cacheKey(_ path: String, builtin: Bool) -> NSString {
        ((builtin ? "theme:" : "file:") + path) as NSString
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

/// Réception d'une miniature, sur une session dédiée dont les rappels passent par une file série.
/// Redirection : suivie seulement vers une miniature Wallhaven en https (GalleryLinks.thumbnailURL), sinon refusée.
/// Taille : une réponse hors 2xx, un Content-Length au-delà de 5 Mo ou des données reçues au-delà de 5 Mo arrêtent le flux.
final class ThumbnailDelegate: NSObject, URLSessionDataDelegate {
    /// Plafond par miniature.
    static let maxBytes = 5 * 1024 * 1024

    private final class Job {
        let continuation: CheckedContinuation<Data?, Never>
        var data = Data()
        var rejected = false

        init(_ continuation: CheckedContinuation<Data?, Never>) {
            self.continuation = continuation
        }
    }

    /// La table est lue depuis le fil principal (register) et depuis la file de la session : verrou.
    private let lock = NSLock()
    private var jobs: [Int: Job] = [:]

    /// Enregistre une tâche avant son démarrage : son résultat (octets, ou nil) est renvoyé à la fin.
    func register(_ task: URLSessionDataTask, _ continuation: CheckedContinuation<Data?, Never>) {
        lock.lock()
        defer { lock.unlock() }
        jobs[task.taskIdentifier] = Job(continuation)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // nil : redirection refusée. La réponse 3xx devient la réponse finale, rejetée ensuite (statut hors 2xx).
        let allowed = GalleryLinks.thumbnailURL(request.url?.absoluteString) != nil
        completionHandler(allowed ? request : nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let successful = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
        // expectedContentLength vaut -1 sans Content-Length : le plafond est alors vérifié sur les octets reçus.
        let tooLarge = response.expectedContentLength > Int64(Self.maxBytes)
        if successful && !tooLarge {
            completionHandler(.allow)
            return
        }
        withJob(dataTask) { $0.rejected = true }
        completionHandler(.cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        var overflow = false
        withJob(dataTask) { job in
            job.data.append(data)
            if job.data.count > Self.maxBytes {
                job.rejected = true
                job.data = Data()
                overflow = true
            }
        }
        // Arrêt du flux hors verrou : l'annulation renvoie ensuite didCompleteWithError.
        if overflow { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let job = jobs.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
        guard let job else { return }
        job.continuation.resume(returning: error == nil && !job.rejected ? job.data : nil)
    }

    private func withJob(_ task: URLSessionTask, _ body: (Job) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        if let job = jobs[task.taskIdentifier] { body(job) }
    }
}

/// Vignettes : cache mémoire (NSCache) seulement. Téléchargement https via une session éphémère (aucun cache disque),
/// délai 15 s, 5 Mo au plus par miniature. Un fond déjà téléchargé sans vignette valide est lu depuis son fichier, réduit à 480 px.
@MainActor
final class ThumbnailCache {
    private let cache = NSCache<NSString, NSImage>()
    private let delegate: ThumbnailDelegate
    private let session: URLSession
    private var pending: [String: Task<Data?, Never>] = [:]

    init() {
        cache.countLimit = 200
        let delegate = ThumbnailDelegate()
        self.delegate = delegate
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 15
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
    }

    func image(for item: WallpaperItem) async -> NSImage? {
        if let url = GalleryLinks.thumbnailURL(item.thumb) {
            return await remote(url)
        }
        if let path = item.file, path.hasPrefix("/") {
            return await local(path, builtin: item.isBuiltin)
        }
        return nil
    }

    /// Image déjà en cache (aucun chargement).
    func cached(for item: WallpaperItem) -> NSImage? {
        if let url = GalleryLinks.thumbnailURL(item.thumb) {
            return cache.object(forKey: url.absoluteString as NSString)
        }
        if let path = item.file, path.hasPrefix("/") {
            return cache.object(forKey: LocalWallpaperFiles.cacheKey(path, builtin: item.isBuiltin))
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
            task = Task<Data?, Never> { await self.download(url) }
            pending[key] = task
        }
        let data = await task.value
        pending[key] = nil
        guard let data, let image = NSImage(data: data) else { return nil }
        cache.setObject(image, forKey: key as NSString)
        return image
    }

    /// Octets de la miniature, ou nil : erreur réseau, statut hors 2xx, redirection refusée, plus de 5 Mo.
    private func download(_ url: URL) async -> Data? {
        await withCheckedContinuation { (continuation: CheckedContinuation<Data?, Never>) in
            let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
            let task = session.dataTask(with: request)
            delegate.register(task, continuation)
            task.resume()
        }
    }

    private func local(_ path: String, builtin: Bool) async -> NSImage? {
        let key = LocalWallpaperFiles.cacheKey(path, builtin: builtin)
        if let hit = cache.object(forKey: key) { return hit }
        guard let real = LocalWallpaperFiles.readablePath(path, builtin: builtin) else { return nil }
        guard let cgImage = await Task.detached(priority: .utility, operation: { ThumbnailCache.downsampled(path: real) }).value else {
            return nil
        }
        let image = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
        cache.setObject(image, forKey: key)
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

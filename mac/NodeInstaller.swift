// Installation de Node.js LTS 22 sans droits administrateur.
// Téléchargement HTTPS (progression), SHA-256 OBLIGATOIRE contre SHASUMS256.txt, contrôle des noms et des liens
// de l'archive, extraction avec /usr/bin/tar dans un dossier temporaire, vérification de `node --version`,
// puis déplacement dans ~/.config/claude-dojo/node. Rien n'est installé si une étape échoue.
import Foundation
import CryptoKit

@MainActor
final class NodeInstaller: ObservableObject {
    enum State: Equatable {
        case idle
        case working(String)
        case downloading(Double)
        case done(String)
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    var isBusy: Bool {
        switch state {
        case .working, .downloading: return true
        default: return false
        }
    }

    static let dist = URL(string: "https://nodejs.org/dist/latest-v22.x/")!

    struct Entry {
        let sha: String
        let file: String
        let version: String
        var top: String { String(file.dropLast(".tar.gz".count)) }
    }

    /// Installe la dernière LTS 22 ; renvoie le binaire node, ou nil (state = failed).
    func install() async -> URL? {
        guard !isBusy else { return nil }
        do {
            let binary = try await perform()
            state = .done("Node.js installé dans \(DojoPaths.configDir.appendingPathComponent("node").path)")
            return binary
        } catch {
            state = .failed(error.localizedDescription)
            return nil
        }
    }

    private func perform() async throws -> URL {
        let fm = FileManager.default
        let arch = NodeInstaller.architecture()
        state = .working("Recherche de la dernière version LTS 22 (\(arch))…")

        let (sums, response) = try await URLSession.shared.data(from: NodeInstaller.dist.appendingPathComponent("SHASUMS256.txt"))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw SetupError("SHASUMS256.txt inaccessible sur nodejs.org")
        }
        let entry = try NodeInstaller.parseEntry(String(decoding: sums, as: UTF8.self), arch: arch)

        let root = DojoPaths.configDir
        let work = root.appendingPathComponent(".node-install-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: work) }

        let archive = work.appendingPathComponent(entry.file)
        state = .downloading(0)
        try await NodeInstaller.download(NodeInstaller.dist.appendingPathComponent(entry.file), to: archive) { [weak self] fraction in
            Task { @MainActor in self?.state = .downloading(fraction) }
        }

        state = .working("Vérification SHA-256…")
        guard try NodeInstaller.sha256(of: archive) == entry.sha else {
            throw SetupError("Empreinte SHA-256 différente de SHASUMS256.txt : archive rejetée, rien n'a été installé.")
        }

        state = .working("Contrôle du contenu de l'archive…")
        try await NodeInstaller.checkNames(archive, top: entry.top)

        let extract = work.appendingPathComponent("extract", isDirectory: true)
        try fm.createDirectory(at: extract, withIntermediateDirectories: true)
        state = .working("Extraction…")
        let tar = try await ProcessRunner.run(
            URL(fileURLWithPath: "/usr/bin/tar"),
            ["-xzf", archive.path, "-C", extract.path, "--strip-components", "1", "--no-same-owner"],
            timeout: 300)
        guard tar.status == 0 else { throw SetupError("tar a échoué : \(ProcessRunner.tail(tar.stderr))") }
        try NodeInstaller.checkLinks(in: extract)

        let node = extract.appendingPathComponent("bin/node")
        guard fm.isExecutableFile(atPath: node.path) else { throw SetupError("bin/node absent de l'archive") }
        let check = try await ProcessRunner.run(node, ["--version"], timeout: 30)
        let reported = String(decoding: check.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard check.status == 0, reported == "v\(entry.version)" else {
            throw SetupError("version installée inattendue : \(reported)")
        }

        state = .working("Installation dans \(root.path)…")
        let dest = root.appendingPathComponent("node", isDirectory: true)
        if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
        try fm.moveItem(at: extract, to: dest)
        return dest.appendingPathComponent("bin/node")
    }

    // MARK: Étapes pures (testables)

    static func architecture() -> String {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        // hw.optional.arm64 vaut 1 sur Apple Silicon, même sous Rosetta
        if sysctlbyname("hw.optional.arm64", &value, &size, nil, 0) == 0, value == 1 { return "arm64" }
        return "x64"
    }

    /// Cherche la ligne node-vX.Y.Z-darwin-<arch>.tar.gz dans SHASUMS256.txt (une seule doit correspondre).
    static func parseEntry(_ text: String, arch: String) throws -> Entry {
        let pattern = #"^node-v(\d+\.\d+\.\d+)-darwin-"# + arch + #"\.tar\.gz$"#
        let regex = try NSRegularExpression(pattern: pattern)
        var found: [Entry] = []
        for line in text.split(whereSeparator: { $0.isNewline }) {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true)
            guard parts.count == 2 else { continue }
            let sha = parts[0].lowercased()
            let file = String(parts[1])
            guard sha.count == 64, sha.allSatisfy({ $0.isHexDigit }) else { continue }
            guard let match = regex.firstMatch(in: file, range: NSRange(file.startIndex..., in: file)),
                  let range = Range(match.range(at: 1), in: file) else { continue }
            found.append(Entry(sha: sha, file: file, version: String(file[range])))
        }
        guard found.count == 1, let entry = found.first else {
            throw SetupError("Entrée node-v…-darwin-\(arch).tar.gz introuvable ou ambiguë dans SHASUMS256.txt")
        }
        return entry
    }

    static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Noms d'entrées relatifs, dans le dossier de tête attendu, sans « .. » ; types de fichiers réguliers,
    /// dossiers ou liens symboliques seulement (pas de liens physiques ni de fichiers spéciaux).
    static func checkNames(_ archive: URL, top: String) async throws {
        let tar = URL(fileURLWithPath: "/usr/bin/tar")
        let names = try await ProcessRunner.run(tar, ["-tzf", archive.path], timeout: 120)
        let listing = try await ProcessRunner.run(tar, ["-tvzf", archive.path], timeout: 120)
        guard names.status == 0, listing.status == 0 else { throw SetupError("archive illisible") }
        for line in String(decoding: names.stdout, as: UTF8.self).split(separator: "\n") {
            let parts = line.split(separator: "/", omittingEmptySubsequences: false)
            guard !line.hasPrefix("/"), !parts.contains(".."), String(parts.first ?? "") == top else {
                throw SetupError("entrée d'archive suspecte refusée : \(line)")
            }
        }
        for line in String(decoding: listing.stdout, as: UTF8.self).split(separator: "\n") {
            guard let kind = line.first, kind == "-" || kind == "d" || kind == "l" else {
                throw SetupError("type d'entrée refusé (lien physique ou fichier spécial)")
            }
        }
    }

    /// Après extraction : tout lien symbolique doit rester dans le dossier extrait.
    static func checkLinks(in root: URL) throws {
        let fm = FileManager.default
        let base = root.resolvingSymlinksInPath().standardizedFileURL.path
        guard let walker = fm.enumerator(at: root, includingPropertiesForKeys: [.isSymbolicLinkKey], options: []) else { return }
        for case let url as URL in walker {
            guard try url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true else { continue }
            let target = try fm.destinationOfSymbolicLink(atPath: url.path)
            let resolved = URL(fileURLWithPath: target, relativeTo: url.deletingLastPathComponent())
                .resolvingSymlinksInPath().standardizedFileURL.path
            guard resolved == base || resolved.hasPrefix(base + "/") else {
                throw SetupError("lien symbolique hors de l'archive refusé : \(url.lastPathComponent)")
            }
        }
    }

    static func download(_ url: URL, to destination: URL, progress: @escaping (Double) -> Void) async throws {
        let delegate = NodeDownloadDelegate(destination: destination, progress: progress)
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            delegate.continuation = cont
            session.downloadTask(with: URLRequest(url: url, timeoutInterval: 600)).resume()
        }
    }
}

/// Délégué de téléchargement : progression, déplacement du fichier téléchargé, fin de la continuation.
final class NodeDownloadDelegate: NSObject, URLSessionDownloadDelegate {
    let destination: URL
    let progress: (Double) -> Void
    var continuation: CheckedContinuation<Void, Error>?

    init(destination: URL, progress: @escaping (Double) -> Void) {
        self.destination = destination
        self.progress = progress
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesExpectedToWrite > 0 {
            progress(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            finish(SetupError("téléchargement refusé (HTTP \(status))"))
            return
        }
        do {
            try FileManager.default.moveItem(at: location, to: destination)
            finish(nil)
        } catch {
            finish(error)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error { finish(error) }
    }

    private func finish(_ error: Error?) {
        guard let cont = continuation else { return }
        continuation = nil
        if let error = error {
            cont.resume(throwing: error)
        } else {
            cont.resume()
        }
    }
}

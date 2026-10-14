// Accès à `node setup.js` : chemins, exécution sans shell (executableURL + tableau d'arguments),
// timeout, lecture de la réponse JSON (une ligne sur stdout ; {"ok":false,"error":…} en échec).
import Foundation

struct SetupError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

enum DojoPaths {
    /// Dossier personnel : HOME si défini (permet les essais en HOME temporaire), sinon le dossier de l'utilisateur.
    static var home: String { ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory() }

    static var configDir: URL {
        URL(fileURLWithPath: home, isDirectory: true).appendingPathComponent(".config/claude-dojo", isDirectory: true)
    }

    /// Fichiers du runtime (setup.js, agent-mac.js…) : DOJO_RUNTIME pour le dev, sinon Resources/runtime du bundle.
    static var runtimeDir: URL {
        if let dev = ProcessInfo.processInfo.environment["DOJO_RUNTIME"], !dev.isEmpty {
            return URL(fileURLWithPath: (dev as NSString).expandingTildeInPath, isDirectory: true)
        }
        return (Bundle.main.resourceURL ?? URL(fileURLWithPath: ".")).appendingPathComponent("runtime", isDirectory: true)
    }

    /// Premier node 18+ utilisable : d'abord celui installé par Dojo, puis les emplacements usuels et le PATH.
    /// Chaque candidat est interrogé (`node --version`, sans shell) : une version plus ancienne passe au suivant.
    static func findNode() async -> URL? {
        let fm = FileManager.default
        var candidates = [configDir.appendingPathComponent("node/bin/node").path]
        let pathDirs = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        candidates += (["/opt/homebrew/bin", "/usr/local/bin"] + pathDirs).map { $0 + "/node" }
        for candidate in candidates where fm.isExecutableFile(atPath: candidate) {
            let exe = URL(fileURLWithPath: candidate)
            if let major = await nodeMajor(exe), major >= 18 { return exe }
        }
        return nil
    }

    /// Version majeure d'un binaire node (`node --version` affiche « v26.9.0 »). nil si inutilisable.
    static func nodeMajor(_ exe: URL) async -> Int? {
        guard let r = try? await ProcessRunner.run(exe, ["--version"], timeout: 5), r.status == 0, !r.timedOut else { return nil }
        let text = String(decoding: r.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix("v") else { return nil }
        return text.dropFirst().split(separator: ".").first.flatMap { Int($0) }
    }

    static func json<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(value)
        return String(decoding: data, as: UTF8.self)
    }
}

struct ProcessResult {
    let status: Int32
    let stdout: Data
    let stderr: Data
    let timedOut: Bool
}

/// Sortie d'un processus, lue sur un fil à part : protégée par un verrou, car ce fil peut finir après le délai de l'appelant.
private final class ProcessOutput: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func set(_ value: Data) {
        lock.lock()
        data = value
        lock.unlock()
    }

    func get() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return data
    }
}

enum ProcessRunner {
    /// Environnement hérité, PATH enrichi (une app lancée par launchd a un PATH minimal).
    static func environment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let current = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        env["PATH"] = (["/opt/homebrew/bin", "/usr/local/bin", current]).joined(separator: ":")
        return env
    }

    /// Lance un exécutable (jamais de shell), attend la fin ou le timeout, renvoie stdout/stderr.
    /// `stdin` : données envoyées sur l'entrée standard puis fermée. Pour les secrets : jamais dans argv (visible de `ps`).
    static func run(_ exe: URL, _ args: [String], timeout: TimeInterval, cwd: URL? = nil, stdin: Data? = nil) async throws -> ProcessResult {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<ProcessResult, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = exe
                process.arguments = args
                process.environment = environment()
                process.currentDirectoryURL = cwd
                let inPipe: Pipe? = stdin == nil ? nil : Pipe()
                if let inPipe {
                    // Écrire vers un enfant qui ne lit plus renvoie EPIPE, au lieu de tuer l'app par SIGPIPE.
                    _ = fcntl(inPipe.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
                    process.standardInput = inPipe
                } else {
                    process.standardInput = FileHandle.nullDevice
                }
                let outPipe = Pipe()
                let errPipe = Pipe()
                process.standardOutput = outPipe
                process.standardError = errPipe

                let out = ProcessOutput()
                let err = ProcessOutput()
                let readers = DispatchGroup()
                readers.enter()
                DispatchQueue.global().async {
                    out.set(outPipe.fileHandleForReading.readDataToEndOfFile())
                    readers.leave()
                }
                readers.enter()
                DispatchQueue.global().async {
                    err.set(errPipe.fileHandleForReading.readDataToEndOfFile())
                    readers.leave()
                }

                do {
                    try process.run()
                } catch {
                    try? outPipe.fileHandleForWriting.close()
                    try? errPipe.fileHandleForWriting.close()
                    if let inPipe {
                        try? inPipe.fileHandleForReading.close()
                        try? inPipe.fileHandleForWriting.close()
                    }
                    _ = readers.wait(timeout: .now() + 5)
                    cont.resume(throwing: SetupError("Impossible de lancer \(exe.lastPathComponent) : \(error.localizedDescription)"))
                    return
                }
                // Le processus a ses propres copies des extrémités utiles : on ferme les nôtres pour recevoir l'EOF.
                try? outPipe.fileHandleForWriting.close()
                try? errPipe.fileHandleForWriting.close()
                if let inPipe, let payload = stdin {
                    // Pas de lecteur côté parent : si l'enfant meurt sans lire, l'écriture échoue au lieu de bloquer.
                    try? inPipe.fileHandleForReading.close()
                    // Écriture sur une file à part, pour ne pas bloquer le fil d'attente pendant que l'enfant écrit sa sortie.
                    let writer = inPipe.fileHandleForWriting
                    DispatchQueue.global().async {
                        try? writer.write(contentsOf: payload)
                        try? writer.close()
                    }
                }

                let lock = NSLock()
                var timedOut = false
                let killer = DispatchWorkItem {
                    lock.lock()
                    timedOut = true
                    lock.unlock()
                    guard process.isRunning else { return }
                    process.terminate()
                    // SIGTERM ignoré : SIGKILL 3 s plus tard. Le pid reste valide tant que le processus tourne.
                    DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                    }
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
                process.waitUntilExit()
                killer.cancel()
                // Un petit-enfant qui garde le tube ouvert ne doit pas bloquer l'appelant : 5 s d'attente au plus.
                _ = readers.wait(timeout: .now() + 5)

                lock.lock()
                let didTimeOut = timedOut
                lock.unlock()
                cont.resume(returning: ProcessResult(status: process.terminationStatus, stdout: out.get(), stderr: err.get(), timedOut: didTimeOut))
            }
        }
    }

    /// Dernières lignes d'une sortie, pour les messages d'erreur.
    static func tail(_ data: Data) -> String {
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = text.split(separator: "\n").suffix(3).joined(separator: " ")
        return String(lines.prefix(400))
    }
}

/// Exécute `node setup.js <cmd> [args…]` et gère l'agent lancé depuis l'assistant.
@MainActor
final class SetupRunner: ObservableObject {
    /// Commande en cours, pour l'affichage.
    @Published private(set) var running: String?
    private var agent: Process?
    private var agentLog: FileHandle?

    var runtimeDir: URL { DojoPaths.runtimeDir }

    /// Appel générique : décode la réponse dans T. Les champs de T sont optionnels, un champ absent ne bloque pas.
    /// `stdin` : JSON envoyé sur l'entrée standard (argument `-`), pour que les secrets n'apparaissent pas dans argv.
    func call<T: Decodable>(_ cmd: String, _ args: [String] = [], timeout: TimeInterval = 60, stdin: Data? = nil) async throws -> T {
        let script = runtimeDir.appendingPathComponent("setup.js")
        guard FileManager.default.fileExists(atPath: script.path) else {
            throw SetupError("setup.js introuvable dans \(runtimeDir.path)")
        }
        guard let node = await DojoPaths.findNode() else {
            throw SetupError("Node.js introuvable : installe Node.js 18 ou plus récent.")
        }
        running = cmd
        defer { running = nil }
        let result = try await ProcessRunner.run(node, [script.path, cmd] + args, timeout: timeout, cwd: runtimeDir, stdin: stdin)
        if result.timedOut { throw SetupError("setup.js \(cmd) : délai dépassé (\(Int(timeout)) s)") }

        let lines = String(decoding: result.stdout, as: UTF8.self)
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let data = Data((lines.last ?? "").utf8)
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else {
            let stderr = ProcessRunner.tail(result.stderr)
            throw SetupError("setup.js \(cmd) : réponse illisible" + (stderr.isEmpty ? "" : " (\(stderr))"))
        }
        if envelope.ok == false {
            throw SetupError(envelope.error ?? "setup.js \(cmd) a échoué")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw SetupError("setup.js \(cmd) : format de réponse inattendu")
        }
    }

    /// Lance agent-mac.js depuis ~/.config/claude-dojo (détaché : il survit à l'assistant). Journal : cache/agent-app.log.
    func startAgent(node: URL, dir: URL) throws {
        let fm = FileManager.default
        let script = dir.appendingPathComponent("agent-mac.js")
        guard fm.fileExists(atPath: script.path) else {
            throw SetupError("agent-mac.js introuvable dans \(dir.path)")
        }
        let logURL = dir.appendingPathComponent("cache/agent-app.log")
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logURL.path) { _ = fm.createFile(atPath: logURL.path, contents: nil) }
        let process = Process()
        process.executableURL = node
        process.arguments = [script.path]
        process.currentDirectoryURL = dir
        process.environment = ProcessRunner.environment()
        process.standardInput = FileHandle.nullDevice
        if let handle = try? FileHandle(forWritingTo: logURL) {
            handle.seekToEndOfFile()
            process.standardOutput = handle
            process.standardError = handle
            agentLog = handle
        }
        try process.run()
        agent = process
    }
}

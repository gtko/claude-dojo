// Point d'entrée de DojoWallpaper.app : fond d'écran Dojo, menu barre et assistant de réglage (macOS 12+).
// Options : --setup (ouvre l'assistant), --snapshot <dossier> (captures PNG de l'assistant, sans réseau).
import Cocoa

let launchArguments = CommandLine.arguments
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

if let i = launchArguments.firstIndex(of: "--snapshot") {
    let dir = i + 1 < launchArguments.count ? launchArguments[i + 1] : "snapshots"
    Task { @MainActor in exit(SnapshotRenderer.run(into: dir)) }
    app.run()
    exit(0)
}

let delegate = AppDelegate(forceSetup: launchArguments.contains("--setup"))
app.delegate = delegate
app.run()

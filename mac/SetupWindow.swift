// Fenêtre de l'assistant (taille : SetupLayout) : héberge SetupWizardView dans un NSHostingView.
import Cocoa
import SwiftUI

@MainActor
final class SetupWindowController: NSWindowController, NSWindowDelegate {
    var onWillClose: (() -> Void)?

    init(model: SetupModel) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: SetupLayout.width, height: SetupLayout.height),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false)
        window.title = model.editing ? "Réglages de Claude Dojo" : "Installer Claude Dojo"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: SetupWizardView(model: model))
        window.center()
        super.init(window: window)
        window.delegate = self
    }

    required init?(coder: NSCoder) {
        fatalError("SetupWindowController n'est pas créé depuis un fichier nib")
    }

    func windowWillClose(_ notification: Notification) {
        onWillClose?()
    }
}

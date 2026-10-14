// Étape « Zone de travail » : garde les fenêtres des autres apps hors des panneaux du fond d'écran.
// Rien n'est écrit ici : le choix part à la dernière étape (SetupModel.apply), avec le reste de config.json.
import SwiftUI
import UniformTypeIdentifiers

struct WindowZoneStep: View {
    @ObservedObject var model: SetupModel
    @State private var trusted = WindowZoneManager.isTrusted
    @State private var refusedKeys = WindowZoneHotKeys.currentRefused
    private let poll = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            StepTitle(
                title: "Zone de travail",
                subtitle: "Garde les fenêtres des autres apps hors des panneaux du fond d'écran (Dojo, usage IA, système, horloge), pour qu'ils restent visibles. Désactivé par défaut.")
            Toggle("Recadrer les fenêtres dans la zone libre", isOn: $model.windowZone.enabled)
                .toggleStyle(.checkbox)

            if model.windowZone.enabled && !trusted {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Autorisation requise", systemImage: "lock.fill")
                        .foregroundColor(.orange)
                        .font(.callout.weight(.semibold))
                    Notice(text: "Déplacer les fenêtres d'autres apps demande l'autorisation Accessibilité. Sans elle, Dojo ne touche à aucune fenêtre.")
                    Button("Ouvrir Réglages Système › Accessibilité") { WindowZoneManager.requestAccess() }
                }
            }
            if WallpaperController.stageManagerActive {
                Notice(text: "Stage Manager est actif : sa bande gauche est réservée en plus des panneaux. Il regroupe lui-même les fenêtres : si les deux se gênent, désactive l'un des deux.")
            }

            if model.windowZone.enabled && !refusedKeys.isEmpty {
                Notice(text: "Raccourcis déjà utilisés par une autre app (Rectangle, Magnet, Raycast…) : \(refusedKeys.joined(separator: " ")). Les actions restent dans le menu Zone de travail.")
            }

            Group {
                Stepper(value: $model.windowZone.margin, in: WindowZoneConfig.marginRange, step: 2) {
                    Text("Marge autour des panneaux : \(Int(model.windowZone.margin)) pt")
                }
                Picker("Zones réservées", selection: $model.windowZone.reserveTop) {
                    Text("Côtés seulement").tag(false)
                    Text("Côtés + haut").tag(true)
                }
                .pickerStyle(.segmented)
                Notice(text: "« Côtés + haut » réserve aussi le bandeau horloge / météo.")
            }
            .disabled(!model.windowZone.enabled)

            Divider()
            Text("Apps exclues").font(.callout).fontWeight(.medium)
            ForEach(model.windowZone.exclude.indices, id: \.self) { index in
                HStack {
                    TextField("", text: $model.windowZone.exclude[index])
                        .textFieldStyle(.roundedBorder)
                    RemoveButton { model.windowZone.exclude.remove(at: index) }
                }
            }
            HStack {
                Button("Ajouter une app…") { chooseApp() }
                Spacer()
            }
            if model.windowZone.exclude.isEmpty {
                Notice(text: "Aucune app exclue. Raccourcis une fois l'option active : ⌃⌥↩ agrandit la fenêtre dans la zone, ⌃⌥← et ⌃⌥→ la placent sur sa moitié gauche ou droite.")
            }
        }
        .onReceive(poll) { _ in
            trusted = WindowZoneManager.isTrusted
            refusedKeys = WindowZoneHotKeys.currentRefused
        }
    }

    private func chooseApp() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.application]
        panel.directoryURL = URL(fileURLWithPath: "/Applications", isDirectory: true)
        panel.message = "Choisis les apps dont les fenêtres ne doivent jamais être déplacées."
        panel.prompt = "Exclure"
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            guard let id = Bundle(url: url)?.bundleIdentifier, !model.windowZone.exclude.contains(id) else { continue }
            model.windowZone.exclude.append(id)
        }
    }
}

// Étape « Thème » : grille de vignettes (une par thème de src/themes), options terminal et fond d'écran.
// Installation : rien n'est écrit ici, le choix part à la dernière étape (SetupModel.apply). Réglages : les cases
// options terminal s'appliquent tout de suite (SetupModel.setTerminal).
import SwiftUI

struct ThemeStep: View {
    @ObservedObject var model: SetupModel
    /// Changement automatique du fond : lu et écrit dans UserDefaults (WallpaperAutoChange), pas dans l'assistant.
    @State private var autoChange = WallpaperAutoChange.seconds
    /// Téléchargement automatique du pack : l'état et son écriture (config.json) sont dans WallpaperSyncController.
    @ObservedObject private var sync = WallpaperSyncController.shared

    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 12)]

    private var autoChangeBinding: Binding<Int> {
        Binding(
            get: { autoChange },
            set: { value in
                autoChange = value
                WallpaperAutoChange.seconds = value
            })
    }

    private var autoDownloadBinding: Binding<Bool> {
        Binding(
            get: { sync.autoDownload },
            set: { value in sync.setAutoDownload(value, runner: model.runner) })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            StepTitle(
                title: "Thème",
                subtitle: "Couleurs, vocabulaire et personnages du dojo. Le thème et le fond sont appliqués à la dernière étape, et modifiables ensuite depuis le menu ⛩.")
            if !model.themesLoaded {
                ProgressView().scaleEffect(0.6)
            } else if let error = model.themesError {
                Notice(text: "Thèmes indisponibles : \(error)", isError: true)
            } else if model.themes.isEmpty {
                Notice(text: "Aucun thème trouvé dans l'application.")
            } else {
                LazyVGrid(columns: columns, spacing: 14) {
                    ForEach(model.themes) { theme in
                        ThemeCard(theme: theme, selected: theme.id == model.themeChoice) {
                            model.themeChoice = theme.id
                        }
                    }
                }
            }
            Divider()
            TerminalOptionsSection(model: model)
            Divider()
            Text("Fond d'écran").font(.callout).fontWeight(.medium)
            if !model.themeChoice.isEmpty {
                WallpaperBandView(model: model)
            }
            Notice(text: "Fond sélectionné : \(model.backgroundLabel)")
            HStack(spacing: 10) {
                Button("Choisir un fond…") { chooseBackground() }
                Button("Fond du thème") { model.resetBackground() }
                    .disabled(model.backgroundUsesTheme)
                Button("Galerie de fonds d'écran…") { GalleryWindowController.show(runner: model.runner, theme: nil) }
                Spacer()
            }
            Notice(text: "Images jpg, png, heic ou webp : Dojo en garde une copie dans sa configuration.")
            if model.editing {
                Divider()
                HStack(spacing: 10) {
                    Text("Changer de fond automatiquement")
                    Picker("Changer de fond automatiquement", selection: autoChangeBinding) {
                        ForEach(WallpaperAutoChange.options) { option in
                            Text(option.label).tag(option.seconds)
                        }
                    }
                    .labelsHidden()
                    .fixedSize()
                    Spacer()
                }
                Notice(text: "Passe au fond suivant parmi les fonds téléchargés du thème actif. Sans fond téléchargé, rien ne change.")
                Toggle("Télécharger automatiquement le pack du thème", isOn: autoDownloadBinding)
                    .toggleStyle(.checkbox)
                if let message = sync.autoDownloadMessage {
                    Notice(text: message, isError: true)
                }
            }
        }
    }

    private func chooseBackground() {
        guard let path = BackgroundPicker.pick() else { return }
        model.backgroundChange = .file(path)
    }
}

/// Options terminal : aperçu du logo du thème choisi, puis une case par cible (Ghostty, Terminal, message d'accueil).
struct TerminalOptionsSection: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Terminal").font(.callout).fontWeight(.medium)
            TerminalPreview(logoPath: model.selectedTheme?.terminalLogo)
            if let error = model.terminalLoadError {
                Notice(text: "Options terminal indisponibles : \(error)", isError: true)
            }
            optionToggle("Appliquer aussi à Ghostty", \.ghostty,
                         missing: model.terminalStatus?.ghostty?.available == false ? "Ghostty n'est pas installé." : nil)
            optionToggle("Appliquer aussi à Terminal", \.terminalApp,
                         missing: model.terminalStatus?.terminalApp?.available == false ? "Terminal.app introuvable." : nil)
            optionToggle("Message d'accueil du terminal", \.welcome, missing: nil)
            if model.terminalChoice.terminalApp, model.terminalStatus?.terminalApp?.running == true,
               model.terminalStatus?.terminalApp?.applied != true {
                Notice(text: "Terminal est ouvert : le profil \(model.editing ? "s'ouvre" : "s'ouvrira") pour que tu l'importes (double-clic).")
            }
            if let error = model.terminalError {
                Notice(text: error, isError: true)
            }
        }
    }

    /// Une case. `missing` : mention discrète et case désactivée quand l'application n'est pas installée.
    private func optionToggle(_ title: String, _ key: WritableKeyPath<TerminalOptions, Bool>, missing: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Toggle(title, isOn: Binding(
                get: { model.terminalChoice[keyPath: key] },
                set: { model.setTerminal(key, $0) }))
                .toggleStyle(.checkbox)
                .disabled((missing != nil && !model.terminalChoice[keyPath: key]) || model.terminalBusy || model.terminalStatus == nil)
            if let missing {
                Text(missing).font(.caption).foregroundColor(.secondary)
            }
        }
    }
}

/// Aperçu du terminal : logo du thème sur fond sombre. Sans logo pour ce thème, une mention neutre.
struct TerminalPreview: View {
    let logoPath: String?
    @State private var image: NSImage?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.88))
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .padding(12)
            } else {
                Text("Pas de logo de terminal pour ce thème.")
                    .font(.caption)
                    .foregroundColor(.white.opacity(0.6))
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 120)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.35)))
        .task(id: logoPath) {
            image = logoPath.flatMap { NSImage(contentsOfFile: $0) }
        }
    }
}

/// Vignette d'un thème : image (cadre neutre sans vignette), bordure et coche quand il est sélectionné.
struct ThemeCard: View {
    let theme: ThemeInfo
    let selected: Bool
    let onSelect: () -> Void
    @State private var image: NSImage?

    var body: some View {
        Button(action: onSelect) {
            VStack(spacing: 6) {
                Color.clear
                    .frame(maxWidth: .infinity)
                    .aspectRatio(1.6, contentMode: .fit)
                    .overlay(thumbnail)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(selected ? Color.accentColor : Color.secondary.opacity(0.35),
                                          lineWidth: selected ? 3 : 1)
                    )
                    .overlay(alignment: .topTrailing) {
                        if selected {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.title3)
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, Color.accentColor)
                                .padding(6)
                        }
                    }
                Text(theme.name)
                    .font(.callout)
                    .fontWeight(selected ? .semibold : .regular)
                    .lineLimit(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .task(id: theme.thumbnail) {
            image = theme.thumbnail.flatMap { NSImage(contentsOfFile: $0) }
        }
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let image {
            Image(nsImage: image)
                .resizable()
                .scaledToFill()
        } else {
            Color.secondary.opacity(0.15)
                .overlay(Image(systemName: "photo").foregroundColor(.secondary))
        }
    }
}

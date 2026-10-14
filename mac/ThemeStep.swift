// Étape « Thème » : grille de vignettes (une par thème de src/themes) et fond d'écran.
// Rien n'est écrit ici : le choix part à la dernière étape (SetupModel.apply).
import SwiftUI

struct ThemeStep: View {
    @ObservedObject var model: SetupModel
    /// Changement automatique du fond : lu et écrit dans UserDefaults (WallpaperAutoChange), pas dans l'assistant.
    @State private var autoChange = WallpaperAutoChange.seconds

    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 12)]

    private var autoChangeBinding: Binding<Int> {
        Binding(
            get: { autoChange },
            set: { value in
                autoChange = value
                WallpaperAutoChange.seconds = value
            })
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
            }
        }
    }

    private func chooseBackground() {
        guard let path = BackgroundPicker.pick() else { return }
        model.backgroundChange = .file(path)
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

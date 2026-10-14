// Bande des fonds du thème choisi (étape Thème et Réglages) : vignettes des fonds présents, coche sur le fond courant,
// progression du téléchargement du pack, crédit des images. Miniatures : PackThumbnails (cache mémoire, 320 px).
import Cocoa
import SwiftUI

/// Miniatures des fonds présents : lues depuis le fichier local, réduites à 320 px. Cache mémoire (NSCache) seulement.
enum PackThumbnails {
    private static let cache: NSCache<NSString, NSImage> = {
        let cache = NSCache<NSString, NSImage>()
        cache.countLimit = 120
        return cache
    }()

    /// Image déjà en cache (aucun chargement).
    static func cached(_ path: String?) -> NSImage? {
        guard let path else { return nil }
        return cache.object(forKey: path as NSString)
    }

    /// Image en cache, ou lue en arrière-plan puis gardée. nil si le fichier manque ou n'est pas une image.
    static func load(_ path: String?) async -> NSImage? {
        guard let path, !path.isEmpty else { return nil }
        if let hit = cached(path) { return hit }
        let decoded = await Task.detached(priority: .utility) { ThumbnailCache.downsampled(path: path, maxPixel: 320) }.value
        guard let decoded else { return nil }
        let image = NSImage(cgImage: decoded, size: NSSize(width: decoded.width, height: decoded.height))
        cache.setObject(image, forKey: path as NSString)
        return image
    }

    /// Image fabriquée (captures) gardée sous un chemin : aucun fichier n'est lu.
    static func store(_ image: NSImage, for path: String) {
        cache.setObject(image, forKey: path as NSString)
    }
}

/// Bande de l'étape Thème : fonds présents du thème choisi, progression du téléchargement, crédit Wallhaven.
struct WallpaperBandView: View {
    @ObservedObject var model: SetupModel
    @ObservedObject private var sync = WallpaperSyncController.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let p = sync.progress, p.running, p.theme == model.themeChoice {
                Text("Téléchargement du pack : \(p.done)/\(p.total)")
                    .font(.caption)
                    .foregroundColor(.secondary)
                ProgressView(value: Double(p.done), total: Double(max(p.total, 1)))
            }
            if let error = model.packError {
                Notice(text: "Fonds du thème indisponibles : \(error)", isError: true)
            } else if model.packWallpapers.isEmpty {
                Notice(text: "Aucun fond pour l'instant : le pack du thème se télécharge en arrière-plan.")
            } else {
                strip
            }
            if let message = model.packMessage {
                Notice(text: message, isError: true)
            }
            if !model.packUsable && !model.packWallpapers.isEmpty {
                Notice(text: "Le fond se choisit une fois le thème appliqué, à la dernière étape.")
            }
            Text("Images Wallhaven, propriété de leurs auteurs")
                .font(.caption2)
                .foregroundColor(.secondary)
            if let failure = sync.failure, failure.theme == model.themeChoice {
                Text(failure.message)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
        }
    }

    private var strip: some View {
        let names = LocalWallpaper.names(model.packWallpapers)
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 10) {
                ForEach(model.packWallpapers.indices, id: \.self) { index in
                    PackCell(wallpaper: model.packWallpapers[index], name: names[index],
                             enabled: model.packUsable && !model.packBusy) {
                        model.usePackWallpaper(model.packWallpapers[index])
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }
}

/// Vignette d'un fond : cadre et coche sur le fond courant, nom dessous. Inactive tant que le thème choisi n'est pas appliqué.
struct PackCell: View {
    let wallpaper: LocalWallpaper
    let name: String
    let enabled: Bool
    let onSelect: () -> Void
    @State private var loaded: NSImage?

    /// Lecture synchrone du cache d'abord : une image déjà chargée s'affiche sans attendre la tâche.
    private var image: NSImage? { loaded ?? PackThumbnails.cached(wallpaper.file) }
    private var current: Bool { wallpaper.current == true }

    var body: some View {
        Button(action: onSelect) {
            VStack(spacing: 4) {
                ZStack(alignment: .topTrailing) {
                    thumbnail
                        .frame(width: 120, height: 75)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .strokeBorder(current ? Color.accentColor : Color.secondary.opacity(0.35),
                                              lineWidth: current ? 3 : 1)
                        )
                    if current {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.body)
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, Color.accentColor)
                            .padding(4)
                    }
                }
                Text(name)
                    .font(.caption)
                    .fontWeight(current ? .semibold : .regular)
                    .lineLimit(1)
                    .frame(width: 120)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.6)
        .accessibilityAddTraits(current ? .isSelected : [])
        .task(id: wallpaper.file) {
            loaded = await PackThumbnails.load(wallpaper.file)
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

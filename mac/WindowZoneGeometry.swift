// Zone de travail : géométrie pure (aucune dépendance à AppKit ni à l'API Accessibilité), donc testable en CI
// (test/swift/main.swift, via scripts/test-swift.sh).
//
// Repère : celui de l'API Accessibilité et de CoreGraphics, origine en haut à gauche de l'écran principal, y vers le bas,
// en points (jamais en pixels : l'échelle Retina n'intervient pas). Les rectangles de la page sont en px CSS,
// dans le repère de la fenêtre du fond d'écran (qui couvre exactement un écran).
import CoreGraphics
import Foundation

/// Rectangles occupés par les panneaux de la page, en px CSS (réponse de `window.dojoReservedRects()`).
struct ReservedCSSRects: Equatable {
    var viewport: CGSize
    var left: CGRect?
    var right: CGRect?
    var top: CGRect?
}

/// Zone de travail d'un écran et zones réservées, en points, repère haut-gauche.
struct ScreenZone: Equatable {
    /// Écran entier.
    var screen: CGRect
    /// Écran sans barre de menus ni Dock.
    var visible: CGRect
    /// Rectangle central libre.
    var zone: CGRect
    /// Zones réservées (colonnes gauche et droite, bandeau haut, bande de Stage Manager), marge comprise.
    var bands: [CGRect]
}

enum WindowZoneGeometry {
    /// En dessous, la zone libre est jugée inutilisable : on ne recadre rien sur cet écran.
    static let minZoneSize = CGSize(width: 320, height: 240)
    /// Part maximale de la largeur visible réservée par une colonne, et de la hauteur par le bandeau haut : la page
    /// (donc un thème) ne peut pas confisquer l'écran.
    static let maxColumnShare: CGFloat = 0.5
    static let maxTopShare: CGFloat = 0.4
    /// La zone finale doit garder au moins cette part de la largeur et de la hauteur visibles, sinon on ne recadre rien.
    static let minZoneShare: CGFloat = 0.5
    /// Bornes d'une réponse de la page (px CSS) : au-delà, la mesure est rejetée.
    static let maxViewport: CGFloat = 20_000
    static let viewportSlack: CGFloat = 8
    /// Chevauchement toléré (pt) avant de parler de débordement.
    static let tolerance: CGFloat = 1

    /// Rectangle Cocoa (origine en bas à gauche de l'écran principal) vers le repère Accessibilité (origine en haut).
    static func axRect(fromCocoa r: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    /// Rectangle de la page (px CSS) vers l'écran (points). `screen` est le cadre de l'écran que la fenêtre du fond couvre :
    /// l'échelle est celle de la fenêtre (zoom de la page, Retina compris), déduite de la taille CSS de la fenêtre.
    static func screenRect(fromCSS r: CGRect, viewport: CGSize, screen: CGRect) -> CGRect {
        guard viewport.width > 0, viewport.height > 0 else { return .null }
        let sx = screen.width / viewport.width
        let sy = screen.height / viewport.height
        return CGRect(x: screen.minX + r.minX * sx, y: screen.minY + r.minY * sy, width: r.width * sx, height: r.height * sy)
    }

    /// Une mesure de la page est-elle plausible ? Valeurs finies, viewport entre 1 et 20000 px, rectangles non vides
    /// et contenus dans le viewport (à quelques px près).
    static func isPlausible(_ r: ReservedCSSRects) -> Bool {
        let v = r.viewport
        guard v.width.isFinite, v.height.isFinite, v.width > 0, v.height > 0, v.width <= maxViewport, v.height <= maxViewport else { return false }
        for box in [r.left, r.right, r.top] {
            guard let b = box else { continue }
            let values = [b.minX, b.minY, b.width, b.height]
            guard values.allSatisfy({ $0.isFinite }), b.width > 0, b.height > 0,
                  b.minX >= -viewportSlack, b.minY >= -viewportSlack,
                  b.maxX <= v.width + viewportSlack, b.maxY <= v.height + viewportSlack else { return false }
        }
        return true
    }

    /// Taille maximale d'une réponse de la page (octets) : au-delà, elle est rejetée sans être lue.
    static let maxReplyBytes = 2048

    /// Réponse JSON de `window.dojoReservedRects()` : {"viewport":{w,h},"left":{x,y,w,h}|null,"right":…,"top":…}.
    /// nil si le texte est absent, trop long, mal formé, ou si une valeur est non finie, un rectangle vide ou hors viewport.
    static func parseRects(_ json: String?) -> ReservedCSSRects? {
        struct Box: Decodable { let x, y, w, h: Double }
        struct Reply: Decodable { struct Size: Decodable { let w, h: Double }; let viewport: Size; let left, right, top: Box? }
        guard let data = json?.data(using: .utf8), data.count <= maxReplyBytes,
              let reply = try? JSONDecoder().decode(Reply.self, from: data) else { return nil }
        // Largeur et hauteur lues telles quelles : un CGRect remplacerait une hauteur négative par sa valeur absolue.
        for b in [reply.left, reply.right, reply.top] {
            if let b, !(b.w > 0 && b.h > 0) { return nil }
        }
        func rect(_ b: Box?) -> CGRect? { b.map { CGRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h) } }
        let result = ReservedCSSRects(viewport: CGSize(width: reply.viewport.w, height: reply.viewport.h),
                                      left: rect(reply.left), right: rect(reply.right), top: rect(reply.top))
        return isPlausible(result) ? result : nil
    }

    /// Zone de travail d'un écran : la zone visible moins les colonnes de panneaux (gauche, droite), le bandeau du haut
    /// si `reserveTop`, la bande de Stage Manager (`stageStrip`, à gauche) et `margin` autour des panneaux.
    /// Les colonnes sont réservées sur toute la hauteur : la zone reste un seul rectangle.
    /// Renvoie nil si la zone libre serait trop petite pour servir.
    static func screenZone(screen: CGRect, visible: CGRect, reserved: ReservedCSSRects?,
                           margin: CGFloat, reserveTop: Bool, stageStrip: CGFloat = 0) -> ScreenZone? {
        let m = max(0, margin)
        var x0 = visible.minX + max(0, stageStrip)
        var x1 = visible.maxX
        var y0 = visible.minY
        let y1 = visible.maxY
        // Mesure aberrante (valeurs non finies, hors viewport) : rien n'est réservé de ce côté, on ne devine pas.
        if let reserved, isPlausible(reserved) {
            func toScreen(_ r: CGRect?) -> CGRect? {
                guard let r, r.width > 0, r.height > 0 else { return nil }
                let s = screenRect(fromCSS: r, viewport: reserved.viewport, screen: screen)
                return s.isNull ? nil : s
            }
            let colLimit = visible.width * maxColumnShare
            if let l = toScreen(reserved.left) { x0 = max(x0, min(l.maxX + m, visible.minX + colLimit)) }
            if let r = toScreen(reserved.right) { x1 = min(x1, max(r.minX - m, visible.maxX - colLimit)) }
            if reserveTop, let t = toScreen(reserved.top) { y0 = max(y0, min(t.maxY + m, visible.minY + visible.height * maxTopShare)) }
        }
        guard x1 - x0 >= minZoneSize.width, y1 - y0 >= minZoneSize.height,
              x1 - x0 >= visible.width * minZoneShare, y1 - y0 >= visible.height * minZoneShare else { return nil }
        let zone = CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
        var bands: [CGRect] = []
        if x0 > visible.minX { bands.append(CGRect(x: visible.minX, y: visible.minY, width: x0 - visible.minX, height: visible.height)) }
        if x1 < visible.maxX { bands.append(CGRect(x: x1, y: visible.minY, width: visible.maxX - x1, height: visible.height)) }
        if y0 > visible.minY { bands.append(CGRect(x: visible.minX, y: visible.minY, width: visible.width, height: y0 - visible.minY)) }
        return ScreenZone(screen: screen, visible: visible, zone: zone, bands: bands)
    }

    /// Écran d'une fenêtre : celui qu'elle recouvre le plus. nil si elle n'en touche aucun.
    static func zoneIndex(for window: CGRect, in zones: [ScreenZone]) -> Int? {
        var best: (index: Int, area: CGFloat)?
        for (index, z) in zones.enumerated() {
            let i = window.intersection(z.screen)
            guard !i.isNull, i.width > 0, i.height > 0 else { continue }
            let area = i.width * i.height
            if best == nil || area > best!.area { best = (index, area) }
        }
        return best?.index
    }

    /// La fenêtre déborde-t-elle sur une zone réservée de cet écran ?
    static func needsFit(_ window: CGRect, in z: ScreenZone) -> Bool {
        z.bands.contains { band in
            let i = window.intersection(band)
            return !i.isNull && i.width > tolerance && i.height > tolerance
        }
    }

    /// Recadre `frame` dans `zone` : déplacée d'abord (taille conservée), réduite seulement si elle est plus grande que la zone,
    /// sans descendre sous `minSize` (taille minimale réellement acceptée par la fenêtre, .zero si inconnue).
    /// Une fenêtre qui ne peut pas tenir (minimum plus grand que la zone) est collée au coin haut-gauche de la zone.
    static func fit(_ frame: CGRect, minSize: CGSize = .zero, in zone: CGRect) -> CGRect {
        func axis(_ origin: CGFloat, _ length: CGFloat, _ minLength: CGFloat, _ lo: CGFloat, _ span: CGFloat) -> (CGFloat, CGFloat) {
            let len = max(min(length, span), minLength)
            if len >= span { return (lo, len) }
            return (min(max(origin, lo), lo + span - len), len)
        }
        let (x, w) = axis(frame.minX, frame.width, minSize.width, zone.minX, zone.width)
        let (y, h) = axis(frame.minY, frame.height, minSize.height, zone.minY, zone.height)
        return CGRect(x: x.rounded(), y: y.rounded(), width: w.rounded(), height: h.rounded())
    }

    enum Side { case left, right }

    /// Moitié gauche ou droite de la zone, séparées de `gap` points.
    static func half(of zone: CGRect, _ side: Side, gap: CGFloat = 4) -> CGRect {
        let w = ((zone.width - gap) / 2).rounded(.down)
        let x = side == .left ? zone.minX : zone.maxX - w
        return CGRect(x: x, y: zone.minY, width: w, height: zone.height)
    }
}

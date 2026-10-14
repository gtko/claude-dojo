// Tests de mac/WindowZoneGeometry.swift (calcul de zone, conversions de repère, recadrage). Lancés par scripts/test-swift.sh.
// Aucune API Accessibilité ici : ce comportement-là ne se teste qu'à la main (voir README, « Window zone »).
import CoreGraphics
import Foundation

var failures = 0
var checks = 0

func check(_ ok: Bool, _ message: String, line: Int = #line) {
    checks += 1
    if !ok {
        failures += 1
        print("ECHEC (ligne \(line)) : \(message)")
    }
}

func eq(_ a: CGRect, _ b: CGRect, _ message: String, line: Int = #line) {
    checks += 1
    let ok = abs(a.minX - b.minX) < 0.01 && abs(a.minY - b.minY) < 0.01 && abs(a.width - b.width) < 0.01 && abs(a.height - b.height) < 0.01
    if !ok {
        failures += 1
        print("ECHEC (ligne \(line)) : \(message) : obtenu \(a), attendu \(b)")
    }
}

typealias G = WindowZoneGeometry

// MacBook Retina 1728 x 1117 pt (3456 x 2234 px, échelle 2). Barre de menus 38 pt, Dock masqué.
let mbp = CGRect(x: 0, y: 0, width: 1728, height: 1117)
let mbpVisible = CGRect(x: 0, y: 38, width: 1728, height: 1079)
// Page : zoom 0,68 -> fenêtre de 1728 / 0,68 = 2541,18 px CSS de large.
let zoom: CGFloat = 0.68
let viewport = CGSize(width: mbp.width / zoom, height: mbp.height / zoom)
// Colonne gauche 500 px CSS à x = 18, colonne droite 360 px CSS à 40 px du bord, bandeau de 720 px CSS centré, 140 px CSS de haut.
let leftCol = CGRect(x: 18, y: 18 + 38 / zoom, width: 500, height: 900)
let rightCol = CGRect(x: viewport.width - 40 - 360, y: 18 + 38 / zoom, width: 360, height: 800)
let hero = CGRect(x: (viewport.width - 720) / 2, y: 0, width: 720, height: 140)
let reserved = ReservedCSSRects(viewport: viewport, left: leftCol, right: rightCol, top: hero)

// ── Conversions de repère ──────────────────────────────────────────────

// Cocoa -> Accessibilité : écran principal 1117 de haut, écran secondaire posé au-dessus (y Cocoa positif) -> y négatif.
eq(G.axRect(fromCocoa: CGRect(x: 0, y: 0, width: 1728, height: 1117), primaryHeight: 1117), mbp, "écran principal inchangé")
eq(G.axRect(fromCocoa: CGRect(x: 100, y: 1117, width: 1920, height: 1080), primaryHeight: 1117),
   CGRect(x: 100, y: -1080, width: 1920, height: 1080), "écran au-dessus : y négatif")
eq(G.axRect(fromCocoa: CGRect(x: -1920, y: -200, width: 1920, height: 1080), primaryHeight: 1117),
   CGRect(x: -1920, y: 237, width: 1920, height: 1080), "écran à gauche, plus bas : x négatif, y décalé")

// CSS -> points : indépendant de l'échelle Retina (on travaille en points), proportionnel au zoom de la page.
eq(G.screenRect(fromCSS: CGRect(x: 18, y: 0, width: 500, height: 100), viewport: viewport, screen: mbp),
   CGRect(x: 18 * zoom, y: 0, width: 500 * zoom, height: 100 * zoom), "Retina, zoom 0,68")
// Écran secondaire (1920 x 1080 à x = 1728, non Retina), zoom 0,75 : l'origine de l'écran est ajoutée.
let ext = CGRect(x: 1728, y: -100, width: 1920, height: 1080)
eq(G.screenRect(fromCSS: CGRect(x: 100, y: 200, width: 400, height: 300), viewport: CGSize(width: 2560, height: 1440), screen: ext),
   CGRect(x: 1728 + 75, y: -100 + 150, width: 300, height: 225), "écran secondaire décalé")
check(G.screenRect(fromCSS: CGRect(x: 0, y: 0, width: 1, height: 1), viewport: .zero, screen: mbp).isNull, "viewport vide : null")

// ── Zone de travail ────────────────────────────────────────────────────

let side8 = G.screenZone(screen: mbp, visible: mbpVisible, reserved: reserved, margin: 8, reserveTop: false)!
eq(side8.zone, CGRect(x: 18 * zoom + 500 * zoom + 8, y: 38, width: 1728 - 40 * zoom - 360 * zoom - 8 - (18 * zoom + 500 * zoom + 8), height: 1079),
   "côtés seulement : colonnes + 8 pt, toute la hauteur visible")
check(side8.bands.count == 2, "côtés seulement : deux bandes")
let withTop = G.screenZone(screen: mbp, visible: mbpVisible, reserved: reserved, margin: 8, reserveTop: true)!
eq(withTop.zone, CGRect(x: side8.zone.minX, y: 140 * zoom + 8, width: side8.zone.width, height: 1117 - (140 * zoom + 8)),
   "côtés + haut : sous le bandeau + 8 pt")
check(withTop.bands.count == 3, "côtés + haut : trois bandes")
let noMargin = G.screenZone(screen: mbp, visible: mbpVisible, reserved: reserved, margin: 0, reserveTop: false)!
check(noMargin.zone.minX < side8.zone.minX, "marge 0 : zone plus large")
// Stage Manager : bande gauche de 165 pt réservée même sans colonne.
let stage = G.screenZone(screen: mbp, visible: mbpVisible, reserved: nil, margin: 8, reserveTop: true, stageStrip: 165)!
eq(stage.zone, CGRect(x: 165, y: 38, width: 1728 - 165, height: 1079), "Stage Manager sans page mesurée")
check(stage.bands.count == 1, "Stage Manager : une bande")
// Page non mesurée, pas de Stage Manager : tout l'écran visible est libre.
let free = G.screenZone(screen: mbp, visible: mbpVisible, reserved: nil, margin: 8, reserveTop: true)!
eq(free.zone, mbpVisible, "aucune mesure : zone = zone visible")
check(free.bands.isEmpty, "aucune mesure : aucune bande")
// Thème malveillant : colonnes de 90 % de l'écran. Chacune est plafonnée à 50 % de la largeur visible, donc la zone
// tombe sous le seuil de 50 % et on ne recadre rien (nil).
let wide = ReservedCSSRects(viewport: viewport, left: CGRect(x: 0, y: 0, width: 2300, height: 100), right: CGRect(x: 300, y: 0, width: 2200, height: 100), top: nil)
check(G.screenZone(screen: mbp, visible: mbpVisible, reserved: wide, margin: 8, reserveTop: true) == nil, "colonnes de 90 % : nil")
// Une seule colonne énorme (90 %) : plafonnée à 50 %, la zone garde la moitié droite.
let oneWide = ReservedCSSRects(viewport: viewport, left: CGRect(x: 0, y: 0, width: 2300, height: 100), right: nil, top: nil)
eq(G.screenZone(screen: mbp, visible: mbpVisible, reserved: oneWide, margin: 8, reserveTop: true)!.zone,
   CGRect(x: 864, y: 38, width: 864, height: 1079), "colonne de 90 % plafonnée à 50 %")
// Bandeau haut énorme (95 % de la hauteur) : plafonné à 40 % de la hauteur visible.
let tallTop = ReservedCSSRects(viewport: viewport, left: nil, right: nil, top: CGRect(x: 100, y: 0, width: 800, height: 1560))
eq(G.screenZone(screen: mbp, visible: mbpVisible, reserved: tallTop, margin: 8, reserveTop: true)!.zone,
   CGRect(x: 0, y: 38 + 1079 * 0.4, width: 1728, height: 1079 * 0.6), "bandeau plafonné à 40 %")
// Stage Manager + colonne : la zone doit rester au moins à moitié de l'écran.
check(G.screenZone(screen: mbp, visible: mbpVisible, reserved: nil, margin: 8, reserveTop: true, stageStrip: 1000) == nil, "bande de 1000 pt : nil")

// Mesures aberrantes de la page : jamais plausibles.
func rects(_ viewport: CGSize = viewport, left: CGRect? = leftCol, right: CGRect? = nil, top: CGRect? = nil) -> ReservedCSSRects {
    ReservedCSSRects(viewport: viewport, left: left, right: right, top: top)
}
check(G.isPlausible(reserved), "mesure normale plausible")
check(G.isPlausible(rects(left: nil)), "aucun panneau : plausible")
check(!G.isPlausible(rects(CGSize(width: 0, height: 800))), "viewport nul")
check(!G.isPlausible(rects(CGSize(width: 25_000, height: 800))), "viewport > 20000")
check(!G.isPlausible(rects(CGSize(width: CGFloat.nan, height: 800))), "viewport NaN")
check(!G.isPlausible(rects(left: CGRect(x: 0, y: 0, width: 0, height: 100))), "largeur nulle")
check(!G.isPlausible(rects(left: CGRect(x: CGFloat.infinity, y: 0, width: 100, height: 100))), "x infini")
check(!G.isPlausible(rects(left: CGRect(x: 0, y: 0, width: CGFloat.nan, height: 100))), "largeur NaN")
check(!G.isPlausible(rects(left: CGRect(x: 2000, y: 0, width: 1000, height: 100))), "rectangle hors viewport")
check(!G.isPlausible(rects(left: CGRect(x: -500, y: 0, width: 600, height: 100))), "rectangle à gauche du viewport")
// Réponse JSON de la page : bornes de taille et de valeurs.
let okJSON = #"{"viewport":{"w":2541,"h":1642},"left":{"x":18,"y":18,"w":500,"h":659},"right":null,"top":{"x":920,"y":18,"w":700,"h":138}}"#
check(G.parseRects(okJSON)?.left == CGRect(x: 18, y: 18, width: 500, height: 659), "JSON valide")
check(G.parseRects(okJSON)?.right == nil, "null = panneau absent")
check(G.parseRects(nil) == nil && G.parseRects("") == nil && G.parseRects("pas du json") == nil, "texte absent ou invalide")
check(G.parseRects(okJSON + String(repeating: " ", count: 3000)) == nil, "réponse > 2 Ko")
check(G.parseRects(#"{"viewport":{"w":2541,"h":1642},"left":{"x":18,"y":18,"w":500,"h":-5}}"#) == nil, "hauteur négative")
check(G.parseRects(#"{"viewport":{"w":2541,"h":1642},"left":{"x":18,"y":18,"w":0,"h":50}}"#) == nil, "largeur nulle")
check(G.parseRects(#"{"viewport":{"w":0,"h":1642}}"#) == nil, "viewport nul")
check(G.parseRects(#"{"viewport":{"w":30000,"h":1642}}"#) == nil, "viewport > 20000")
check(G.parseRects(#"{"viewport":{"w":2541,"h":1642},"left":{"x":2000,"y":0,"w":900,"h":50}}"#) == nil, "hors viewport")
check(G.parseRects(#"{"viewport":{"w":2541,"h":1642},"left":{"x":1e999,"y":0,"w":10,"h":50}}"#) == nil, "valeur non finie")
// screenZone ignore une mesure aberrante : rien n'est réservé.
eq(G.screenZone(screen: mbp, visible: mbpVisible, reserved: rects(left: CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 100)), margin: 8, reserveTop: true)!.zone,
   mbpVisible, "mesure aberrante ignorée")
// Rectangle de page vide ou à largeur nulle (panneau masqué) : ignoré.
let hidden = ReservedCSSRects(viewport: viewport, left: CGRect(x: 0, y: 0, width: 0, height: 0), right: nil, top: nil)
eq(G.screenZone(screen: mbp, visible: mbpVisible, reserved: hidden, margin: 8, reserveTop: true)!.zone, mbpVisible, "panneau masqué ignoré")
// Dock à gauche : la zone visible commence après le Dock, la colonne dépasse ou non.
let dockVisible = CGRect(x: 70, y: 38, width: 1658, height: 1079)
let dockZone = G.screenZone(screen: mbp, visible: dockVisible, reserved: nil, margin: 8, reserveTop: true)!
eq(dockZone.zone, dockVisible, "Dock à gauche")

// ── Multi-écrans : chaque écran a sa zone, la fenêtre va avec l'écran qu'elle recouvre le plus ──

let extVisible = CGRect(x: 1728, y: -100, width: 1920, height: 1080)
let extReserved = ReservedCSSRects(viewport: CGSize(width: 2560, height: 1440),
                                   left: CGRect(x: 18, y: 18, width: 500, height: 800),
                                   right: CGRect(x: 2560 - 400, y: 18, width: 360, height: 800), top: nil)
let extZone = G.screenZone(screen: ext, visible: extVisible, reserved: extReserved, margin: 8, reserveTop: true)!
// colonne gauche : 18 + 500 = 518 css = 388,5 pt ; droite : 2160 css = 1620 pt (depuis x = 1728)
eq(extZone.zone, CGRect(x: 1728 + 388.5 + 8, y: -100, width: (1620 - 8) - (388.5 + 8), height: 1080), "second écran : zone propre")
let zones = [withTop, extZone]
check(G.zoneIndex(for: CGRect(x: 600, y: 300, width: 800, height: 600), in: zones) == 0, "fenêtre sur l'écran principal")
check(G.zoneIndex(for: CGRect(x: 2200, y: 0, width: 800, height: 600), in: zones) == 1, "fenêtre sur l'écran externe")
check(G.zoneIndex(for: CGRect(x: 1500, y: 300, width: 800, height: 600), in: zones) == 1, "à cheval : l'écran le plus recouvert (500 pt à droite de 1728 > 228 à gauche)")
check(G.zoneIndex(for: CGRect(x: 1000, y: 300, width: 800, height: 600), in: zones) == 0, "à cheval : principal plus recouvert")
check(G.zoneIndex(for: CGRect(x: -5000, y: 0, width: 400, height: 400), in: zones) == nil, "hors de tout écran : nil")

// ── Débordement ────────────────────────────────────────────────────────

let zone = withTop.zone
check(!G.needsFit(CGRect(x: zone.minX + 10, y: zone.minY + 10, width: 400, height: 300), in: withTop), "fenêtre dans la zone : rien à faire")
check(!G.needsFit(zone, in: withTop), "fenêtre = zone : rien à faire")
check(G.needsFit(CGRect(x: 100, y: 300, width: 600, height: 400), in: withTop), "déborde sur la colonne gauche")
check(G.needsFit(CGRect(x: 1300, y: 300, width: 400, height: 400), in: withTop), "déborde sur la colonne droite")
check(G.needsFit(CGRect(x: zone.minX + 50, y: 40, width: 500, height: 400), in: withTop), "déborde sur le bandeau")
check(!G.needsFit(CGRect(x: zone.minX + 50, y: 40, width: 500, height: 400), in: side8), "bandeau non réservé : pas de débordement")
check(!G.needsFit(CGRect(x: zone.minX - 0.5, y: 300, width: 400, height: 300), in: withTop), "0,5 pt de recouvrement toléré")
check(G.needsFit(CGRect(x: 0, y: 300, width: 100, height: 100), in: withTop), "entièrement dans la colonne gauche")
check(!G.needsFit(CGRect(x: 3000, y: 300, width: 100, height: 100), in: withTop), "hors de cet écran : ignorée")

// ── Recadrage ──────────────────────────────────────────────────────────

let z = CGRect(x: 400, y: 100, width: 800, height: 700)
// Plus petite que la zone, à cheval sur la colonne gauche : déplacée, taille conservée.
eq(G.fit(CGRect(x: 300, y: 200, width: 500, height: 400), in: z), CGRect(x: 400, y: 200, width: 500, height: 400), "petite : déplacée à droite")
// À cheval sur la colonne droite.
eq(G.fit(CGRect(x: 1000, y: 200, width: 500, height: 400), in: z), CGRect(x: 700, y: 200, width: 500, height: 400), "petite : déplacée à gauche")
// Sous le bandeau.
eq(G.fit(CGRect(x: 500, y: 20, width: 300, height: 300), in: z), CGRect(x: 500, y: 100, width: 300, height: 300), "petite : descendue sous le bandeau")
// Plus grande que la zone : réduite à la zone.
eq(G.fit(CGRect(x: 0, y: 0, width: 1728, height: 1117), in: z), z, "plus grande : réduite à la zone")
eq(G.fit(CGRect(x: 500, y: 150, width: 1000, height: 300), in: z), CGRect(x: 400, y: 150, width: 800, height: 300), "plus large seulement : largeur réduite")
// Entièrement dans une zone réservée : ramenée dans la zone, taille conservée.
eq(G.fit(CGRect(x: 20, y: 300, width: 300, height: 250), in: z), CGRect(x: 400, y: 300, width: 300, height: 250), "entièrement dans la colonne gauche")
eq(G.fit(CGRect(x: 1500, y: 300, width: 200, height: 250), in: z), CGRect(x: 1000, y: 300, width: 200, height: 250), "entièrement dans la colonne droite")
// Taille minimale : jamais en dessous, même si la zone est plus petite (collée au coin haut-gauche).
eq(G.fit(CGRect(x: 0, y: 0, width: 1728, height: 1117), minSize: CGSize(width: 900, height: 400), in: z),
   CGRect(x: 400, y: 100, width: 900, height: 700), "minimum plus large que la zone : minimum respecté, calé à gauche")
eq(G.fit(CGRect(x: 300, y: 200, width: 100, height: 100), minSize: CGSize(width: 450, height: 120), in: z),
   CGRect(x: 400, y: 200, width: 450, height: 120), "plus petite que son minimum : agrandie au minimum")
// Idempotence : recadrer une fenêtre déjà recadrée ne la bouge plus.
let once = G.fit(CGRect(x: 100, y: 10, width: 1500, height: 900), in: z)
eq(G.fit(once, in: z), once, "idempotent")
// Valeurs entières (pas de demi-points envoyés à l'API Accessibilité).
let frac = G.fit(CGRect(x: 300.4, y: 200.6, width: 500.5, height: 400.2), in: z)
check(frac.minX == frac.minX.rounded() && frac.minY == frac.minY.rounded() && frac.width == frac.width.rounded(), "arrondi aux points")

// ── Moitiés ────────────────────────────────────────────────────────────

eq(G.half(of: z, .left), CGRect(x: 400, y: 100, width: 398, height: 700), "moitié gauche")
eq(G.half(of: z, .right), CGRect(x: 802, y: 100, width: 398, height: 700), "moitié droite")

print("\(checks - failures)/\(checks) vérifications réussies")
exit(failures == 0 ? 0 : 1)

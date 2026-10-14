"""Terminal spec for the Mushoku Tensei theme: a mage's magic circle with a staff and a grimoire.

The artwork is original, drawn with Pillow (no official image). A mana circle with a triangle and a
core sits in the middle, a staff with a glowing orb stands on the right, an open grimoire lies on the
left and sparks rise from the circle. For t from 0 to 1 the circle is traced, the sigils appear, the
staff lights up, the book opens and the sparks rise (t = 1 is the final logo).
"""
import math
import random

from PIL import Image, ImageDraw

import common as C
from common import Canvas, blur_glow, clamp, paint, smooth

ID = "mushoku-tensei"
TITLE = "Guilde des Mages"
SUBTITLE = "Terminal de l'académie · mana stable"
FOOTER = "● cercle scellé · sorts prêts"
KEY1 = "rang de magie"
KEY2 = "sort"
ACCENT = (95, 220, 236)    # mana cyan, cursor and keys (theme.json purple)
VALUE = (230, 246, 239)    # foreground of the theme.json palette
FETCH = {"user": "mage", "host": "académie", "os": "grimoire", "cpu": "mana",
         "memory": "réserve", "uptime": "en service"}

# Chromatic slots follow the mana palette (cyan, mint, gold) on the dark teal background.
# Neutral slots and the bright-black slot come from theme.json, then gen.py enforces contrast.
ANSI = {
    1: "#e0685a", 2: "#6fd4a0", 3: "#e9b96a", 4: "#4fa8dc", 5: "#b98ee0", 6: "#5fdcec",
    9: "#f08a7a", 10: "#8ff2c4", 11: "#f6d98e", 12: "#7fc0ef", 13: "#d4aef0", 14: "#a6f0fa",
}

# Random lists for the launcher: magic ranks with their level, then spells (short, evocative).
LIST1 = [
    "Débutant · niv. 1",
    "Intermédiaire · niv. 2",
    "Avancé · niv. 3",
    "Expert · niv. 4",
    "Saint · niv. 5",
    "Roi · niv. 6",
    "Empereur · niv. 7",
    "Dieu · niv. 8",
    "Maîtrise de l'eau · niv. 4",
    "Maîtrise du feu · niv. 3",
    "Maîtrise de la terre · niv. 3",
    "Maîtrise du vent · niv. 4",
]
LIST2 = [
    "Boule de feu · projectile ardent",
    "Mur de pierre · bouclier de terre",
    "Soin · lumière apaisante",
    "Lame de vent · tranchant invisible",
    "Glace éternelle · pilier de givre",
    "Éclair · foudre dirigée",
    "Lévitation · pas dans l'air",
    "Bouclier d'eau · voile liquide",
    "Flèche de mana · trait pur",
    "Téléportation · pas de l'ombre",
    "Détection de mana · sens éveillé",
    "Brume dissipante · voile levé",
    "Pluie de pierres · éboulis",
    "Tornade · colonne de vent",
    "Lumière guérisseuse · aube douce",
    "Barrière d'ombre · nuit close",
]

MANA = (95, 220, 236)       # cyan, as ACCENT
MANA_HI = (206, 250, 255)   # core and orb highlight
MINT = (143, 242, 196)      # theme.json pink
GOLD = (246, 217, 142)      # theme.json yellow
WOOD = (139, 90, 43)        # theme.json propColors[0]
ORB_DIM = (38, 72, 84)
ORB = (110, 200, 255)       # theme.json propColors[1]
CREAM = (243, 233, 210)
INK = (10, 40, 38)          # spine line, close to the theme background

# Sigils: short strokes in a unit box (x along the tangent, y outwards), drawn on the annulus.
SIGILS = [
    [[(0, 1), (0, -1)], [(0, -1), (-0.7, -0.35)], [(0, -1), (0.7, -0.35)]],
    [[(-0.5, 1), (-0.5, -1)], [(-0.5, -1), (0.5, -0.3)], [(-0.5, -0.1), (0.5, -0.7)]],
    [[(0, -1), (0.8, 0), (0, 1), (-0.8, 0), (0, -1)]],
    [[(-0.5, 1), (-0.5, -1)], [(-0.5, -1), (0.5, -0.2)], [(0.5, -0.2), (-0.5, 0.6)]],
]


def _radius(cv):
    """Magic circle radius in units, from the canvas height (wide banners are capped)."""
    return min(0.60, cv.half_h * 0.80)


def _width(cv, final_px):
    """Stroke width in units for a width in final pixels."""
    return final_px * C.SUPERSAMPLE / cv.U


def _mask(cv):
    return Image.new("L", (cv.W, cv.H), 0)


def _disc(cv, mask, centre, radius, fill=255):
    cx, cy = cv.P(*centre)
    r = radius * cv.U
    ImageDraw.Draw(mask).ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)


def _stroke(draw, cv, pts, width, fill=255):
    """Polyline with round ends, points in units."""
    if len(pts) < 2:
        return
    w = max(1, round(width * cv.U))
    xy = [cv.P(u, v) for u, v in pts]
    draw.line(xy, fill=fill, width=w, joint="curve")
    r = w / 2
    for x, y in (xy[0], xy[-1]):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def _arc(r, a0, sweep, steps=160):
    """Arc of radius r (units) centred on the origin, from angle a0 over sweep (radians, negative = anticlockwise)."""
    if abs(sweep) < 1e-3:
        return []
    n = max(2, int(steps * abs(sweep) / (2 * math.pi)))
    return [(r * math.cos(a0 + sweep * i / n), r * math.sin(a0 + sweep * i / n)) for i in range(n + 1)]


def _lit(cv, img, mask, rgb, glow_radius, glow_alpha):
    """Soft glow under a shape, then the shape itself in one colour."""
    if glow_alpha > 0:
        img = Image.alpha_composite(img, blur_glow(cv, mask, rgb, glow_radius, glow_alpha))
    return Image.alpha_composite(img, paint(mask, rgb))


def _scaled(mask, factor):
    return mask.point(lambda v: int(v * clamp(factor)))


def draw_logo(t, size=C.LOGO_SIZE):
    """RGBA logo for progress t in [0, 1]. t = 1 is the final image; the background is transparent."""
    t = clamp(t)
    cv = Canvas(size)
    R = _radius(cv)
    w_main = _width(cv, cv.h / 24 * 1.5)    # about one and a half sub-rows of the text logo
    w_thin = _width(cv, cv.h / 24 * 0.9)
    w_staff = _width(cv, cv.h / 24 * 1.3)

    p_ring = smooth(t / 0.45)               # the magic circle is traced
    p_inner = smooth((t - 0.10) / 0.45)
    p_tri = smooth((t - 0.30) / 0.40)       # triangle edges, one after the other
    p_runes = smooth((t - 0.50) / 0.30)
    p_staff = smooth((t - 0.20) / 0.40)     # the staff grows from its foot
    p_orb = smooth((t - 0.55) / 0.30)       # the orb lights up
    p_book = smooth((t - 0.25) / 0.45)      # the grimoire opens from its spine
    p_core = smooth((t - 0.60) / 0.40)

    img = Image.new("RGBA", (cv.W, cv.H), (0, 0, 0, 0))

    # Wide aura, kept faint so the canvas edges stay transparent.
    aura = _mask(cv)
    _disc(cv, aura, (0, 0), 1.25 * R)
    img = Image.alpha_composite(img, blur_glow(cv, aura, MANA, 0.45 * R, 0.05 + 0.10 * p_core))

    # Inner gold ring, turning the other way, then the mint triangle.
    inner = _mask(cv)
    _stroke(ImageDraw.Draw(inner), cv, _arc(0.78 * R, -math.pi / 2, -2 * math.pi * p_inner), w_thin)
    img = _lit(cv, img, inner, GOLD, 0.10 * R, 0.30 * p_inner)

    tri = _mask(cv)
    draw = ImageDraw.Draw(tri)
    verts = [(0.70 * R * math.cos(a), 0.70 * R * math.sin(a)) for a in (-math.pi / 2, math.pi / 6, 5 * math.pi / 6)]
    progress = p_tri * 3
    for k in range(3):
        f = clamp(progress - k)
        if f <= 0:
            break
        (x0, y0), (x1, y1) = verts[k], verts[(k + 1) % 3]
        _stroke(draw, cv, [(x0, y0), (x0 + (x1 - x0) * f, y0 + (y1 - y0) * f)], w_thin)
    img = _lit(cv, img, tri, MINT, 0.10 * R, 0.35)

    # Sigils on the annulus between the rings.
    runes = _mask(cv)
    draw = ImageDraw.Draw(runes)
    size_s = 0.07 * R
    for k in range(8):
        theta = -math.pi / 2 + (k + 0.5) * 2 * math.pi / 8
        rx, ry = math.cos(theta), math.sin(theta)       # outwards
        tx, ty = -ry, rx                                # tangent
        ox, oy = 0.88 * R * rx, 0.88 * R * ry
        for stroke in SIGILS[k % len(SIGILS)]:
            pts = [(ox + size_s * (gx * tx + gy * rx), oy + size_s * (gx * ty + gy * ry)) for gx, gy in stroke]
            _stroke(draw, cv, pts, w_thin * 0.7)
    img = Image.alpha_composite(img, paint(_scaled(runes, p_runes), MANA, 0.8))

    # Main ring, the strongest line of the emblem.
    ring = _mask(cv)
    _stroke(ImageDraw.Draw(ring), cv, _arc(R, -math.pi / 2, 2 * math.pi * p_ring), w_main)
    img = _lit(cv, img, ring, MANA, 0.14 * R, 0.45)

    # Grimoire on the left: two pages opening from the spine, with a cyan halo.
    x0 = -1.30 * R
    hw = 0.20 * R * (0.15 + 0.85 * p_book)
    top_out, top_spine, bot_spine, bot_out = -0.12 * R, 0.02 * R, 0.62 * R, 0.50 * R
    pages = _mask(cv)
    draw = ImageDraw.Draw(pages)
    for side in (-1, 1):
        poly = [(x0, top_spine), (x0 + side * hw, top_out), (x0 + side * hw, bot_out), (x0, bot_spine)]
        draw.polygon([cv.P(u, v) for u, v in poly], fill=255)
    img = Image.alpha_composite(img, blur_glow(cv, pages, MANA, 0.12 * R, 0.35 * p_book))
    img = Image.alpha_composite(img, paint(pages, CREAM, max(p_book, 0.001)))
    lines = _mask(cv)
    draw = ImageDraw.Draw(lines)
    for side in (-1, 1):
        for v in (0.12 * R, 0.30 * R):
            _stroke(draw, cv, [(x0 + side * 0.04 * R, v), (x0 + side * (hw - 0.03 * R), v)], w_thin * 0.5)
    img = Image.alpha_composite(img, paint(_scaled(lines, p_book), MANA, 0.9))
    spine = _mask(cv)
    _stroke(ImageDraw.Draw(spine), cv, [(x0, top_spine), (x0, bot_spine)], w_thin * 0.9)
    img = Image.alpha_composite(img, paint(_scaled(spine, p_book), INK))

    # Staff on the right: the shaft grows from its foot, then the cradle and the orb.
    foot = (1.22 * R, 0.98 * R)
    head = (1.27 * R, -0.92 * R)
    tip = (foot[0] + (head[0] - foot[0]) * p_staff, foot[1] + (head[1] - foot[1]) * p_staff)
    shaft = _mask(cv)
    _stroke(ImageDraw.Draw(shaft), cv, [foot, tip], w_staff)
    img = Image.alpha_composite(img, paint(shaft, WOOD))

    cradle = _mask(cv)
    cradle_pts = [(head[0] + u, head[1] + v) for u, v in _arc(0.20 * R, 0.2 * math.pi, 0.6 * math.pi)]
    _stroke(ImageDraw.Draw(cradle), cv, cradle_pts, w_staff * 0.9)
    img = Image.alpha_composite(img, paint(_scaled(cradle, p_orb), WOOD))

    orb = _mask(cv)
    _disc(cv, orb, head, 0.14 * R)
    orb_rgb = C.mix(ORB_DIM, ORB, p_orb)
    img = _lit(cv, img, orb, orb_rgb, 0.22 * R, 0.15 + 0.70 * p_orb)

    # Core at the centre of the triangle.
    core = _mask(cv)
    _disc(cv, core, (0, 0), 0.12 * R)
    img = _lit(cv, img, _scaled(core, 0.35 + 0.65 * p_core), MANA_HI, 0.22 * R, 0.5 * p_core)

    # Sparks: fixed final spots that rise into place, staggered in time (t = 1 is their final place).
    rng = random.Random(7)
    cyan_spots, gold_spots = _mask(cv), _mask(cv)
    count = 14
    for i in range(count):
        angle = math.pi / count + 2 * math.pi * i / count + rng.uniform(-0.12, 0.12)
        birth = 0.15 + 0.55 * i / count + rng.uniform(0.0, 0.08)
        p = smooth((t - birth) / 0.35)
        near_book = abs(math.remainder(angle - math.pi, 2 * math.pi)) < 0.45
        if p <= 0 or near_book:
            continue
        # Ellipse just outside the ring: wider than tall, to stay inside the canvas height.
        pos = (1.28 * R * math.cos(angle), 1.14 * R * math.sin(angle) + (1 - p) * 0.22 * R)
        target = gold_spots if i % 3 == 0 else cyan_spots
        _disc(cv, target, pos, max(0.05 * R, _width(cv, 3.4)), fill=int(255 * p))
    img = _lit(cv, img, cyan_spots, MANA, 0.06 * R, 0.6)
    img = _lit(cv, img, gold_spots, GOLD, 0.06 * R, 0.6)

    return cv.finish(img)

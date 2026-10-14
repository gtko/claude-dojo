"""Terminal spec for the Frieren theme: a magic circle with runes, a five-petal flower and a staff.

The artwork is original, drawn with Pillow (no official image). The layers are drawn in order, so the
logo builds itself: outer circle, runes, inner circle, hexagram, flower, staff (t from 0 to 0.66). Then
the whole circle lights up and the petals settle (t from 0.55 to 1). t = 1 is the final logo.
"""
import math

from PIL import Image, ImageDraw

import common as C
from common import Canvas, blur_glow, clamp, smooth

ID = "frieren"
TITLE = "Voyage de Frieren"
SUBTITLE = "Terminal de la mage · mille ans de grimoires"
FOOTER = "✦ mana stable · cercle ouvert"
KEY1 = "sort"
KEY2 = "grimoire"
ACCENT = (226, 189, 122)   # gold (theme.json orange), cursor and keys
VALUE = (238, 240, 250)    # foreground of the theme.json palette
FETCH = {"user": "mage", "host": "forêt", "os": "grimoire", "cpu": "mana",
         "memory": "réserve", "uptime": "mille ans"}

# Chromatic ANSI slots follow the theme.json hues (rose, sage, gold, blue, mauve, cyan).
ANSI = {
    1: "#d98a93", 2: "#8fc79c", 3: "#e2bd7a", 4: "#7f9fd8", 5: "#b89ad6", 6: "#8ccbd6",
    9: "#ec9ea5", 10: "#a8dcb4", 11: "#f0d78e", 12: "#a9c4f0", 13: "#d0b5e8", 14: "#bfe3f0",
}

# Random lists for the launcher: spells and grimoires (invented titles).
LIST1 = [
    "Zoltraak · trait de magie pure",
    "Sort de défense · bouclier de givre",
    "Sort pour faire fleurir · éveil des pétales",
    "Lumière de l'aube · éclat sur la route",
    "Flamme · boule de feu brève",
    "Brume d'argent · voile de protection",
    "Pas du vent · course légère",
    "Sceau de l'elfe · marque de mana",
    "Gel de la clairière · barrière bleue",
    "Racine de songe · entrave végétale",
    "Étoile du matin · flèche lumineuse",
    "Mana de la forêt · soin doux",
    "Pluie de pétales · illusion légère",
    "Chant de mille ans · sort de mémoire",
]
LIST2 = [
    "Le Recueil des fleurs oubliées",
    "Traité des cercles de mana",
    "Chronique du vent de l'Est",
    "Grimoire des mille hivers",
    "Carnet de route d'un elfe",
    "Herbier des montagnes du nord",
    "Journal de la clairière bleue",
    "Codex des runes anciennes",
    "Le Livre des sceaux dormants",
    "Atlas des villages sans nom",
    "Mémoires d'une mage solitaire",
    "Psaumes pour les morts du soir",
    "Notes sur la lenteur du temps",
    "Almanach des pluies de pétales",
    "Les Sept Serments de l'aube",
]

GOLD = (226, 189, 122)     # theme.json orange: circles, hexagram, orb
RUNE = (240, 215, 142)     # theme.json yellow: runes
PALE = (238, 240, 250)     # theme.json foreground: petals
BLUE = (169, 208, 245)     # theme.json pink (light blue): halo and petals
PURPLE = (184, 154, 214)   # theme.json purple: aura and petals
WOOD = (170, 181, 216)     # theme.json muted: staff

R_OUT, R_RUNE, R_IN = 0.52, 0.4225, 0.33          # outer circle, rune band, inner circle (units)
LW_RING, LW_INNER, LW_LINE, LW_RUNE = 0.04, 0.035, 0.035, 0.035
RUNE_S = 0.085                                   # a rune box (1 x 1) is drawn at this size
STAFF_X, STAFF_TOP, STAFF_BOT, LW_STAFF = 0.62, -0.46, 0.50, 0.045
FLOWER_LEN, PETAL_HALF = 0.18, 0.07

# Petals around the circle: x, y (final place), angle, length, colour, time they start to land.
PETALS = [
    (-0.62, -0.10, 35, 0.085, PALE, 0.62),
    (-0.46, 0.36, -30, 0.075, BLUE, 0.64),
    (0.44, 0.40, 60, 0.07, PURPLE, 0.68),
    (-0.80, -0.40, 150, 0.065, PURPLE, 0.70),
    (0.86, -0.20, 120, 0.075, PALE, 0.72),
    (-0.90, 0.14, 80, 0.07, BLUE, 0.74),
    (0.96, 0.30, -20, 0.065, PURPLE, 0.76),
    (0.30, -0.66, -60, 0.06, BLUE, 0.78),
]


def _circle_pts(radius, n=28):
    return [(radius * math.cos(2 * math.pi * i / n), radius * math.sin(2 * math.pi * i / n))
            for i in range(n + 1)]


# Original runes in a 1 x 1 box centred on (0, 0). Each glyph is a list of polylines.
RUNES = [
    [[(-0.45, 0.5), (0.0, -0.5), (0.45, 0.5)], [(-0.22, 0.12), (0.22, 0.12)]],
    [[(-0.3, -0.5), (-0.3, 0.5), (0.3, 0.5)], [(0.3, 0.0), (-0.3, 0.0)]],
    [[(-0.45, -0.5), (0.45, -0.1), (-0.45, 0.3), (0.45, 0.5)]],
    [[(0.0, -0.5), (0.0, 0.5)], [(-0.4, -0.2), (0.0, -0.5), (0.4, -0.2)]],
    [[(-0.45, 0.5), (-0.45, -0.5), (0.45, 0.5)]],
    [_circle_pts(0.42)],
]


def _win(t, a, b):
    """Progress of t inside the window [a, b], clamped to [0, 1]."""
    return clamp((t - a) / (b - a))


def _polar(radius, angle_deg):
    a = math.radians(angle_deg)
    return (radius * math.cos(a), radius * math.sin(a))


def _arc(radius, p, n=160):
    """Circle from the top, clockwise, over the fraction p of a turn."""
    steps = int(round(n * clamp(p)))
    if steps < 1:
        return []
    return [_polar(radius, -90 + 360 * i / n) for i in range(steps + 1)]


def _partial(pts, p):
    """Start of a polyline covering the fraction p of its length (empty when p is 0)."""
    p = clamp(p)
    if p <= 0.0 or len(pts) < 2:
        return []
    lengths = [math.dist(a, b) for a, b in zip(pts, pts[1:])]
    target = sum(lengths) * p
    out, acc = [pts[0]], 0.0
    for (a, b), seg in zip(zip(pts, pts[1:]), lengths):
        if acc + seg >= target:
            k = (target - acc) / seg if seg else 0.0
            out.append((a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k))
            return out
        out.append(b)
        acc += seg
    return out


def _stroke(draw, cv, pts, width, fill):
    """Polyline in units, with round joins and caps."""
    if len(pts) < 2:
        return
    px = [cv.P(u, v) for u, v in pts]
    w = max(2, int(round(width * cv.U)))
    draw.line(px, fill=fill, width=w, joint="curve")
    r = w / 2
    for x, y in (px[0], px[-1]):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def _disc(draw, cv, centre, radius, fill):
    if radius <= 0:
        return
    x, y = cv.P(*centre)
    r = radius * cv.U
    draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def _leaf(cv, draw, centre, angle, start, length, half, fill):
    """Leaf-shaped petal from start to start + length along angle (degrees), offset from centre."""
    if length <= 0:
        return
    a = math.radians(angle)
    ux, uy = math.cos(a), math.sin(a)
    nx, ny = -uy, ux
    n = 24
    right, left = [], []
    for i in range(n + 1):
        s = i / n
        d = start + length * s
        w = half * math.sin(math.pi * s) ** 0.8
        cx, cy = centre[0] + ux * d, centre[1] + uy * d
        right.append(cv.P(cx + nx * w, cy + ny * w))
        left.append(cv.P(cx - nx * w, cy - ny * w))
    draw.polygon(right + left[::-1], fill=fill)


def draw_logo(t, size=C.LOGO_SIZE):
    """RGBA logo for progress t in [0, 1]. t = 1 is the final image; the background is transparent."""
    t = clamp(t)
    cv = Canvas(size)
    emb = Image.new("RGBA", (cv.W, cv.H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(emb)
    light = smooth(_win(t, 0.55, 0.85))      # the circle lights up once it is drawn

    # Outer circle, drawn in one turn.
    _stroke(draw, cv, _arc(R_OUT, _win(t, 0.00, 0.22)), LW_RING, GOLD + (255,))

    # Twelve runes in the band between the two circles, each one drawn stroke by stroke.
    for i in range(12):
        start = 0.16 + 0.02 * i
        q = _win(t, start, start + 0.08)
        cx, cy = _polar(R_RUNE, -90 + 30 * i)
        for line in RUNES[(i * 5) % len(RUNES)]:
            pts = [(cx + u * RUNE_S, cy + v * RUNE_S) for u, v in line]
            _stroke(draw, cv, _partial(pts, q), LW_RUNE, RUNE + (255,))

    # Inner circle, then the hexagram (two triangles, one after the other).
    _stroke(draw, cv, _arc(R_IN, _win(t, 0.34, 0.50)), LW_INNER, GOLD + (255,))
    p = _win(t, 0.46, 0.66)
    tri_a = [_polar(R_IN, a) for a in (-90, 30, 150)]
    tri_b = [_polar(R_IN, a) for a in (90, -30, 210)]
    _stroke(draw, cv, _partial(tri_a + tri_a[:1], 2 * p), LW_LINE, GOLD + (255,))
    _stroke(draw, cv, _partial(tri_b + tri_b[:1], 2 * p - 1), LW_LINE, GOLD + (255,))

    # Five-petal flower in the hexagram, petals opening one after the other.
    for k in range(5):
        g = smooth(_win(t, 0.60 + 0.03 * k, 0.72 + 0.03 * k))
        _leaf(cv, draw, (0.0, 0.0), -90 + 72 * k, 0.0, FLOWER_LEN * g, PETAL_HALF * g,
              PALE + (235,))
    _disc(draw, cv, (0.0, 0.0), 0.045 * smooth(_win(t, 0.74, 0.84)), GOLD + (255,))

    # Staff beside the circle: grows from its foot, the orb comes last.
    staff = [(STAFF_X, STAFF_BOT), (STAFF_X, STAFF_TOP)]
    _stroke(draw, cv, _partial(staff, _win(t, 0.30, 0.56)), LW_STAFF, WOOD + (255,))
    orb = smooth(_win(t, 0.56, 0.66))
    _disc(draw, cv, (STAFF_X, STAFF_TOP), 0.06 * orb, GOLD + (255,))
    _disc(draw, cv, (STAFF_X, STAFF_TOP), 0.025 * orb, PALE + (255,))

    # Petals drift down onto their places.
    for x, y, angle, length, colour, t0 in PETALS:
        prog = smooth(_win(t, t0, t0 + 0.2))
        if prog <= 0:
            continue
        cy = y - 0.10 * (1 - prog)
        _leaf(cv, draw, (x, cy), angle, -length / 2, length, length * 0.42,
              colour + (int(255 * prog),))

    # Light: a soft purple aura behind the circle, a blue halo around the drawing.
    aura_mask = Image.new("L", (cv.W, cv.H), 0)
    r = R_OUT * cv.U
    ImageDraw.Draw(aura_mask).ellipse([cv.cx - r, cv.cy - r, cv.cx + r, cv.cy + r], fill=255)
    img = blur_glow(cv, aura_mask, PURPLE, 0.09, 0.18 * light)
    img = Image.alpha_composite(img, blur_glow(cv, emb.getchannel("A"), BLUE, 0.018, 0.45 * light))
    img = Image.alpha_composite(img, emb)
    return cv.finish(img)

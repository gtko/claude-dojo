"""Terminal spec for the Jujutsu Kaisen theme: a cursed seal that cracks, lights up and unfolds into a domain.

The artwork is original, drawn with Pillow (no official image). The sequence follows the idea of a
sealed talisman: a small dim seal with fractures, the fractures and the eye light up, then the domain
unfolds to its full radius (t from 0 to 1, t = 1 is the final logo).
"""
import math
import random

from PIL import Image, ImageChops, ImageDraw

import common as C
from common import Canvas, blur_glow, clamp, paint, poly_mask, smooth

ID = "jujutsu-kaisen"
TITLE = "Lycée d'Exorcisme"
SUBTITLE = "Terminal du Jujutsu · domaine déployé"
FOOTER = "● énergie maudite stable · domaine ouvert"
KEY1 = "technique"
KEY2 = "fléau"
ACCENT = (176, 108, 255)   # violet, cursor and keys (theme.json purple)
VALUE = (241, 236, 251)    # foreground (theme.json fg)
FETCH = {"user": "exorciste", "host": "lycée", "os": "grimoire", "cpu": "énergie",
         "memory": "réserve", "uptime": "en exorcisme"}

# Chromatic slots keep the theme.json hues (violet, pink-red, blue, teal). Neutrals and the
# bright-black slot come from theme.json, then gen.py enforces the contrast.
ANSI = {
    1: "#e23a4e", 2: "#6fd6a0", 3: "#f0c36b", 4: "#6fa8ff", 5: "#b06cff", 6: "#5ef0e4",
    9: "#ff6b7d", 10: "#9ff0c4", 11: "#ffd98a", 12: "#9cc4ff", 13: "#cba0ff", 14: "#9ff7ef",
}

# Technique names are invented or generic (no names from the series).
LIST1 = [
    "Expansion de domaine · sphère close",
    "Poing divergent · frappe retardée",
    "Lame de ténèbres · coupe sans bruit",
    "Frappe inversée · énergie retournée",
    "Sceau du silence · mot interdit",
    "Corde d'ombre · entrave au sol",
    "Marque maudite · traceur d'énergie",
    "Bouclier de cendres · barrière dense",
    "Vrille du néant · spirale de fond",
    "Chaîne de sang · liens tendus",
    "Projection d'âme · esprit à distance",
    "Lanterne funèbre · lumière qui guide",
    "Écho de malédiction · ricochet",
    "Fissure spatiale · couper l'espace",
]
# Curse ranks, from grade 4 to special grade.
LIST2 = [
    "Fléau de grade 4 · murmure de couloir",
    "Fléau de grade 4 · ombre de cantine",
    "Fléau de grade 3 · esprit de chantier",
    "Fléau de grade 3 · masque de carnaval",
    "Fléau de grade 2 · possédé de quartier",
    "Fléau de grade 2 · rituel raté",
    "Fléau de grade semi-1 · gardien de gare",
    "Fléau de grade 1 · malédiction d'hôpital",
    "Fléau de grade 1 · sceau de temple",
    "Fléau de grade 1 · brume de lycée",
    "Fléau de grade spécial · cauchemar urbain",
    "Fléau de grade spécial · calamité de Tokyo",
    "Fléau de grade spécial · fléau sans nom",
    "Grade spécial · fléau au-delà des rangs",
]

VIOLET = (176, 108, 255)
VIOLET_HI = (206, 168, 255)
PINK = (226, 58, 78)
CORE = (255, 214, 230)     # hot core of the fractures
PALE = (236, 228, 252)     # outline of the eye
SCLERA = (210, 194, 240)   # lavender white, so the iris stays visible
INK = (40, 16, 72)         # centre of the domain
DEEP = (12, 7, 24)         # rim of the domain, near the background

RIM_FULL = 0.50            # radius of the unfolded domain, in units
EYE_W, EYE_H = 0.34, 0.19  # half width and half height of the open eye, at full radius
GLYPH_COUNT = 10


def _layer(cv):
    return Image.new("RGBA", (cv.W, cv.H), (0, 0, 0, 0))


def _disk(cv, r):
    img = Image.new("L", (cv.W, cv.H), 0)
    x0, y0 = cv.P(-r, -r)
    x1, y1 = cv.P(r, r)
    ImageDraw.Draw(img).ellipse([x0, y0, x1, y1], fill=255)
    return img


def _ring(cv, r, width):
    """L mask of a circle outline centred on radius r."""
    img = Image.new("L", (cv.W, cv.H), 0)
    outer = r + width / 2
    x0, y0 = cv.P(-outer, -outer)
    x1, y1 = cv.P(outer, outer)
    ImageDraw.Draw(img).ellipse([x0, y0, x1, y1], outline=255, width=max(1, int(round(width * cv.U))))
    return img


def _domain(cv, r, centre, rim, steps=36):
    """Opaque disc with a radial gradient, painted as concentric discs from the rim inwards."""
    img = _layer(cv)
    draw = ImageDraw.Draw(img)
    for i in range(steps, 0, -1):
        f = i / steps
        x0, y0 = cv.P(-r * f, -r * f)
        x1, y1 = cv.P(r * f, r * f)
        draw.ellipse([x0, y0, x1, y1], fill=C.mix(centre, rim, f) + (255,))
    return img


def _stroke(cv, draw, pts, width, fill):
    """Polyline in units with round joints and caps."""
    w = max(1, int(round(width * cv.U)))
    px = [cv.P(u, v) for u, v in pts]
    if len(px) > 1:
        draw.line(px, fill=fill, width=w, joint="curve")
    for x, y in px:
        draw.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=fill)


def _partial(pts, f):
    """Start of a polyline up to the fraction f of its length (by segment)."""
    n = len(pts) - 1
    idx = clamp(f) * n
    whole = int(idx)
    out = list(pts[: whole + 1])
    frac = idx - whole
    if whole < n and frac > 0:
        (u0, v0), (u1, v1) = pts[whole], pts[whole + 1]
        out.append((u0 + (u1 - u0) * frac, v0 + (v1 - v0) * frac))
    return out


def _fractures():
    """Paths in units of the domain radius (1 = rim), from inside the seal out past the rim."""
    rng = random.Random(7)
    paths = []
    for k in range(7):
        angle = 2 * math.pi * k / 7 + rng.uniform(-0.25, 0.25)
        rho = rng.uniform(0.18, 0.30)
        pts = []
        for _ in range(9):
            pts.append((rho * math.cos(angle), rho * math.sin(angle)))
            angle += rng.uniform(-0.35, 0.35)
            rho += rng.uniform(0.07, 0.12)
        paths.append(pts)
    return paths


def _glyph(rng):
    """Kanji-like strokes in a 1 x 1 box centred on 0, original shapes."""
    strokes = []
    for _ in range(rng.randint(2, 4)):
        kind = rng.choice(["h", "v", "diag", "hook", "dot"])
        x, y = rng.uniform(-0.22, 0.22), rng.uniform(-0.22, 0.22)
        n = rng.uniform(0.28, 0.46)
        if kind == "h":
            strokes.append([(x - n, y), (x + n, y)])
        elif kind == "v":
            strokes.append([(x, y - n), (x, y + n)])
        elif kind == "diag":
            sign = rng.choice([-1, 1])
            strokes.append([(x - n, y - n * sign), (x + n, y + n * sign)])
        elif kind == "hook":
            strokes.append([(x - n, y), (x + n * 0.4, y), (x + n * 0.4, y + n)])
        else:
            strokes.append([(x, y), (x + 0.04, y + 0.04)])
    return strokes


CRACKS = _fractures()
_GLYPH_RNG = random.Random(11)
GLYPHS = [_glyph(_GLYPH_RNG) for _ in range(GLYPH_COUNT)]


def _cracks(cv, rad, f, bright):
    """Fractures of the seal: a glowing core over a pink halo, cut by the reveal fraction f."""
    glow = Image.new("L", (cv.W, cv.H), 0)
    core = _layer(cv)
    gdraw, cdraw = ImageDraw.Draw(glow), ImageDraw.Draw(core)
    for path in CRACKS:
        pts = [(rad * u, rad * v) for u, v in _partial(path, f)]
        if len(pts) < 2:
            continue
        _stroke(cv, gdraw, pts, 0.03, 255)
        _stroke(cv, cdraw, pts, 0.012, CORE + (int(255 * bright),))
    halo = blur_glow(cv, glow, PINK, 0.03, 0.7 * bright)
    return Image.alpha_composite(halo, core)


def _trails(cv, alpha):
    """Two thin energy trails leaving the domain sideways; they fade before the canvas edges."""
    mask = Image.new("L", (cv.W, cv.H), 0)
    draw = ImageDraw.Draw(mask)
    xs = [-cv.half_w + 2 * cv.half_w * i / 239 for i in range(240)]
    for offset, amp, freq, width in [(-0.08, 0.025, 2.6, 0.02), (0.10, 0.02, 3.4, 0.012)]:
        pts = [(u, offset + amp * math.sin(freq * u)) for u in xs]
        _stroke(cv, draw, pts, width, 255)
    fade = C.fade_mask(cv, lambda u: C.ramp_down(abs(u), 0.9, cv.half_w * 0.95))
    return paint(ImageChops.multiply(mask, fade), VIOLET_HI, alpha)


def _lens(w, h, n=48):
    """Closed almond outline (pointed ends) with half width w and half height h, in units."""
    top = []
    for i in range(n + 1):
        s = 2 * i / n - 1
        top.append((w * s, -h * (1 - s * s) ** 0.6))
    bottom = [(u, -v) for u, v in reversed(top)]
    return top + bottom[1:]


def _eye(cv, sc, opening, light):
    """Almond eye: pale sclera, violet-pink iris and a dark vertical pupil."""
    w = EYE_W * sc
    h = max(0.012, EYE_H * sc * opening)
    outline = _lens(w, h)
    lens = poly_mask(cv, outline)
    img = blur_glow(cv, lens, VIOLET, 0.06 * sc, 0.25 + 0.55 * light)
    img = Image.alpha_composite(img, paint(lens, SCLERA, 0.92))

    iris_r = min(h * 0.95, w * 0.85)
    iris = _domain(cv, iris_r, (255, 176, 210), (150, 60, 210), steps=24)
    iris.putalpha(ImageChops.multiply(iris.getchannel("A"), lens))
    img = Image.alpha_composite(img, iris)

    pupil = _layer(cv)
    pw, ph = max(0.018, 0.045 * sc), h * 0.9
    x0, y0 = cv.P(-pw, -ph)
    x1, y1 = cv.P(pw, ph)
    ImageDraw.Draw(pupil).ellipse([x0, y0, x1, y1], fill=DEEP + (255,))
    pupil.putalpha(ImageChops.multiply(pupil.getchannel("A"), lens))
    img = Image.alpha_composite(img, pupil)

    edge = _layer(cv)
    _stroke(cv, ImageDraw.Draw(edge), outline + outline[:1], 0.016 * sc, VIOLET_HI + (255,))
    return Image.alpha_composite(img, edge)


def draw_logo(t, size=C.LOGO_SIZE):
    """RGBA logo for progress t in [0, 1]. t = 1 is the final image; the background is transparent."""
    t = clamp(t)
    cv = Canvas(size)
    full = min(RIM_FULL, cv.half_h * 0.9)      # the domain always stays inside the canvas
    sc = full / RIM_FULL                       # scale of the emblem details
    expand = smooth((t - 0.35) / 0.65)         # the domain unfolds in the second half
    rad = full * (0.52 + 0.48 * expand)
    light = smooth((t - 0.15) / 0.55)          # the fractures and the core light up
    crack = smooth(t / 0.4)                    # the fractures run from the centre out
    opening = smooth((t - 0.25) / 0.5)         # the eye opens
    wave = clamp((t - 0.3) / 0.7)              # shock wave of the expansion, gone at t = 1

    img = _layer(cv)
    img = Image.alpha_composite(img, blur_glow(cv, _disk(cv, rad * 1.05), VIOLET, 0.14 * sc, 0.14 + 0.30 * light))
    img = Image.alpha_composite(img, _trails(cv, 0.15 + 0.5 * expand))

    shock = smooth((t - 0.2) / 0.2) * (1 - wave) ** 1.5 * 0.7
    if shock > 0.01:
        img = Image.alpha_composite(img, paint(_ring(cv, full * (0.6 + 0.45 * wave), 0.02 * sc), PALE, shock))

    img = Image.alpha_composite(img, _domain(cv, rad, C.mix(INK, VIOLET, 0.35 * light), DEEP))

    glyphs = _layer(cv)
    gdraw = ImageDraw.Draw(glyphs)
    theta = 1.6 * (1 - t) ** 2                 # the glyphs turn while the domain unfolds
    ring_r = rad * 0.80
    gsize = 0.10 * sc
    g_alpha = int(255 * (0.25 + 0.55 * smooth((t - 0.3) / 0.7)))
    for i, strokes in enumerate(GLYPHS):
        a = theta + 2 * math.pi * i / GLYPH_COUNT
        cx, cy = ring_r * math.cos(a), ring_r * math.sin(a)
        for stroke in strokes:
            pts = [(cx + x * gsize, cy + y * gsize) for x, y in stroke]
            _stroke(cv, gdraw, pts, 0.03 * sc, VIOLET_HI + (g_alpha,))
    img = Image.alpha_composite(img, glyphs)

    rim = _ring(cv, rad, 0.05 * sc)
    img = Image.alpha_composite(img, blur_glow(cv, rim, VIOLET, 0.03 * sc, 0.45 + 0.35 * light))
    img = Image.alpha_composite(img, paint(rim, VIOLET_HI))
    img = Image.alpha_composite(img, paint(_ring(cv, rad * 0.9, 0.012 * sc), PINK, 0.6))

    img = Image.alpha_composite(img, _cracks(cv, rad, crack, 0.35 + 0.65 * light))
    img = Image.alpha_composite(img, _eye(cv, rad / RIM_FULL, opening, light))
    return cv.finish(img)

"""Terminal spec for the Demon Slayer theme: a nichirin blade drawn from its scabbard, a checkered
haori band, and a flame strand and a water strand weaving around the blade.

The artwork is original, drawn with Pillow (no official image). Timeline for t in [0, 1]: the
haori band unrolls, the blade slides out of the scabbard, then the flame and the water strands
wind around the blade. t = 1 is the final logo.
"""
import math

from PIL import Image, ImageChops, ImageDraw

import common as C
from common import Canvas, blur_glow, clamp, paint, ramp_down, smooth, fade_mask

ID = "demon-slayer"
TITLE = "Corps des Pourfendeurs"
SUBTITLE = "Terminal du Corps · rang Hashira"
FOOTER = "● souffle stable · nichirin prête"
KEY1 = "souffle"
KEY2 = "forme"
ACCENT = (185, 162, 236)   # purple #b9a2ec: keys and cursor, the theme's main accent
VALUE = (243, 238, 250)    # foreground #f3eefa of the theme.json palette
FETCH = {"user": "pourfendeur", "host": "corps", "os": "nichirin", "cpu": "souffle",
         "memory": "endurance", "uptime": "de garde"}

# Chromatic ANSI slots follow the palette: pink, orange, gold, water blue, purple, green (haori).
# Neutral slots come from theme.json, then gen.py enforces the contrast ratios.
ANSI = {
    1: "#e0607a", 2: "#5fb08a", 3: "#e8c060", 4: "#7f9ee8", 5: "#b9a2ec", 6: "#7fc7c0",
    9: "#f08a9a", 10: "#8fd4a8", 11: "#f2c26a", 12: "#a4b8f2", 13: "#f2a6c8", 14: "#a8e0d8",
}

# Breaths (souffles) for the launcher line, then forms (formes) with their ordinal.
LIST1 = [
    "Eau", "Flamme", "Foudre", "Vent", "Pierre", "Brume", "Amour",
    "Serpent", "Insecte", "Son", "Soleil", "Fleur", "Bête",
]
LIST2 = [
    "Première forme · Tranche de surface",
    "Deuxième forme · Roue d'eau",
    "Troisième forme · Danse fluide",
    "Quatrième forme · Marée déferlante",
    "Cinquième forme · Tourbillon",
    "Sixième forme · Pluie bénie",
    "Première forme · Feu inconscient",
    "Deuxième forme · Soleil ardent",
    "Troisième forme · Univers flamboyant",
    "Quatrième forme · Tigre de feu",
    "Première forme · Éclair et foudre",
    "Deuxième forme · Éclair multiple",
    "Première forme · Tourbillon de poussière",
    "Deuxième forme · Griffe de vent",
    "Première forme · Peau de pierre",
    "Deuxième forme · Mur de roc",
    "Première forme · Brume aveuglante",
    "Deuxième forme · Voile de brouillard",
    "Première forme · Cercle de l'amour",
    "Première forme · Bête déchaînée",
    "Deuxième forme · Mâchoire sauvage",
    "Première forme · Danse du dieu du feu",
    "Deuxième forme · Vague de chaleur",
    "Première forme · Fleur de cerisier",
]

# Palette of the artwork (theme.json values, plus two lighter tints for the highlights).
HAORI_GREEN = (47, 143, 107)    # #2f8f6b
HAORI_BLACK = (27, 31, 36)      # #1b1f24
STEEL = (118, 124, 166)
STEEL_HI = (206, 212, 240)
NICHIRIN = (242, 166, 200)      # #f2a6c8, the glint on the edge
GUARD = (217, 164, 65)          # #d9a441
GUARD_HOLE = (14, 12, 30)
SCABBARD = (72, 62, 112)
SCABBARD_HI = (160, 140, 220)
CORD = HAORI_GREEN
FLAME_LO = (232, 113, 74)       # #e8714a
FLAME_HI = (242, 227, 179)      # #f2e3b3
WATER_LO = (110, 130, 225)
WATER_HI = (185, 162, 236)      # #b9a2ec
AURA = (150, 112, 230)

# Geometry, in units of U (see common.Canvas). The axis points up and to the right.
ANGLE = math.radians(32)
AX = (math.cos(ANGLE), math.sin(ANGLE))
NX = (-math.sin(ANGLE), math.cos(ANGLE))
SCAB_LEN = 0.70                 # scabbard, from its rounded end to the mouth (s = 0)
BLADE_LEN = 0.84                # blade, from the guard to the tip
MID_S = (BLADE_LEN - SCAB_LEN) / 2   # axis position at the centre of the emblem
HALF_BLADE = 0.044
HALF_SCAB = 0.066
TAPER = 0.15
GUARD_R = 0.085
HELIX_START = 0.11              # the strands start beyond the guard
HELIX_END = BLADE_LEN - 0.08
HELIX_PERIOD = 0.36
HELIX_AMP = 0.13
CHECK = 0.095                   # side of one haori square; the band is two squares high


def _pt(s, o):
    """Blade frame (s along the axis from the mouth, o across it) -> units, y up."""
    s -= MID_S
    return (s * AX[0] + o * NX[0], s * AX[1] + o * NX[1])


def _mask(cv, pts):
    """L mask of a polygon given in y-up units."""
    img = Image.new("L", (cv.W, cv.H), 0)
    ImageDraw.Draw(img).polygon([cv.P(x, -y) for x, y in pts], fill=255)
    return img


def _layer(cv):
    return Image.new("RGBA", (cv.W, cv.H), (0, 0, 0, 0))


def _disc(cx, cy, r, n=48):
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n))
            for i in range(n)]


def _band(cv, reveal):
    """Checkered haori band behind the emblem. It unrolls from the centre and fades at the sides."""
    layer = _layer(cv)
    draw = ImageDraw.Draw(layer)
    cols = int(cv.half_w / CHECK) + 2
    for i in range(-cols, cols):
        for j in (-1, 0):
            colour = HAORI_GREEN if (i + j) % 2 == 0 else HAORI_BLACK
            draw.rectangle([cv.P(i * CHECK, j * CHECK), cv.P((i + 1) * CHECK, (j + 1) * CHECK)],
                           fill=colour + (255,))
    width = 0.22 + reveal * (cv.half_w + 0.1)
    reveal_mask = fade_mask(cv, lambda u: ramp_down(abs(u), width * 0.75, width))
    side_mask = fade_mask(cv, lambda u: ramp_down(abs(u), cv.half_w * 0.7, cv.half_w))
    alpha = ImageChops.multiply(ImageChops.multiply(layer.getchannel("A"), reveal_mask), side_mask)
    layer.putalpha(alpha)
    return layer


def _scabbard(cv):
    """Lacquered scabbard lying on the axis, rounded end at s = -SCAB_LEN, straight mouth at s = 0."""
    hs = HALF_SCAB
    c = -SCAB_LEN + hs
    outline = [(0.0, -hs), (c, -hs)]
    for k in range(25):                               # rounded end, from one side to the other
        a = -math.pi / 2 - math.pi * k / 24
        outline.append((c + hs * math.cos(a), hs * math.sin(a)))
    outline += [(c, hs), (0.0, hs)]
    pts = [_pt(s, o) for s, o in outline]
    body = paint(_mask(cv, pts), SCABBARD)
    # highlight along the upper edge and a green cord wrap near the mouth
    hi = [_pt(s, o) for s, o in [(-SCAB_LEN + 0.07, hs * 0.55), (-0.03, hs * 0.55),
                                 (-0.03, hs * 0.35), (-SCAB_LEN + 0.07, hs * 0.35)]]
    body = Image.alpha_composite(body, paint(_mask(cv, hi), SCABBARD_HI, 0.8))
    wrap = [_pt(s, o) for s, o in [(-0.24, -hs - 0.01), (-0.17, -hs - 0.01),
                                   (-0.17, hs + 0.01), (-0.24, hs + 0.01)]]
    return Image.alpha_composite(body, paint(_mask(cv, wrap), CORD))


def _blade(cv, tip):
    """Nichirin blade from its guard (tip - BLADE_LEN) to the tip. Clipped under the scabbard at the base."""
    guard = tip - BLADE_LEN
    start = max(guard, -SCAB_LEN + 0.06)     # the rest is hidden under the scabbard
    if tip - start <= 0.02:
        return _layer(cv)
    taper = min(TAPER, tip - start)
    outline = [(start, -HALF_BLADE), (tip - taper, -HALF_BLADE), (tip, 0.0),
               (tip - taper, HALF_BLADE), (start, HALF_BLADE)]
    body_mask = _mask(cv, [_pt(s, o) for s, o in outline])
    img = paint(body_mask, STEEL)
    glint = [(start + 0.02, HALF_BLADE * 0.55), (max(start + 0.03, tip - taper - 0.02), HALF_BLADE * 0.55),
             (max(start + 0.03, tip - taper - 0.02), HALF_BLADE * 0.72), (start + 0.02, HALF_BLADE * 0.72)]
    img = Image.alpha_composite(img, paint(_mask(cv, [_pt(s, o) for s, o in glint]), NICHIRIN, 0.95))
    ridge = [(start + 0.02, -0.004), (tip - taper, -0.004), (tip - taper, 0.004), (start + 0.02, 0.004)]
    img = Image.alpha_composite(img, paint(_mask(cv, [_pt(s, o) for s, o in ridge]), STEEL_HI, 0.7))
    glow = blur_glow(cv, body_mask, NICHIRIN, 0.012, 0.45)
    return Image.alpha_composite(glow, img)


def _guard(cv, tip):
    """Round tsuba centred on the guard. Only its part beyond the mouth shows, so it slides out of the scabbard."""
    guard = tip - BLADE_LEN
    outer = _mask(cv, [_pt(s, o) for s, o in [(0.0, -1.0), (1.5, -1.0), (1.5, 1.0), (0.0, 1.0)]])
    disc = _disc(*_pt(guard, 0.0), GUARD_R)
    ring = paint(_mask(cv, disc), GUARD)
    hole = paint(_mask(cv, _disc(*_pt(guard, 0.0), GUARD_R * 0.45)), GUARD_HOLE)
    img = Image.alpha_composite(ring, hole)
    img.putalpha(ImageChops.multiply(img.getchannel("A"), outer))
    return img


def _helix(cv, phase, reach, root, tip_col, width_fn, glow_rgb):
    """A strand that winds around the blade, from HELIX_START up to `reach`.

    The strand is in front of the blade where its depth cos(angle) is positive and behind it
    elsewhere, so the two strands alternate over and under the blade. Returns (back, front).
    """
    back, front = _layer(cv), _layer(cv)
    span = reach - HELIX_START
    if span < 0.004:
        return back, front
    count = max(4, int(span / 0.005))
    samples = []
    for i in range(count + 1):
        s = HELIX_START + span * i / count
        angle = 2 * math.pi * (s - HELIX_START) / HELIX_PERIOD + phase
        flare = 0.7 + 0.3 * (s / BLADE_LEN)        # the coil opens toward the tip
        o = HELIX_AMP * flare * smooth((s - HELIX_START) / 0.12) * math.sin(angle)
        samples.append((s, o, math.cos(angle), width_fn(s)))
    pts = [_pt(s, o) for s, o, _, _ in samples]
    edges = []
    for i, (x, y) in enumerate(pts):
        ax_, ay_ = pts[max(i - 1, 0)]
        bx_, by_ = pts[min(i + 1, len(pts) - 1)]
        tx, ty = bx_ - ax_, by_ - ay_
        length = math.hypot(tx, ty) or 1.0
        nx, ny = -ty / length, tx / length
        half = samples[i][3] / 2
        edges.append(((x + nx * half, y + ny * half), (x - nx * half, y - ny * half)))

    mask = Image.new("L", (cv.W, cv.H), 0)
    draw_back, draw_front, draw_mask = ImageDraw.Draw(back), ImageDraw.Draw(front), ImageDraw.Draw(mask)
    chunk = 6
    for start in range(0, len(edges) - 1, chunk):
        end = min(start + chunk, len(edges) - 1)
        seg = edges[start:end + 1]
        poly = [cv.P(x, -y) for x, y in [left for left, _ in seg] + [right for _, right in reversed(seg)]]
        mid = (start + end) // 2
        colour = C.mix(root, tip_col, samples[mid][0] / BLADE_LEN)
        (draw_front if samples[mid][2] > 0 else draw_back).polygon(poly, fill=colour + (255,))
        draw_mask.polygon(poly, fill=255)
    back = Image.alpha_composite(blur_glow(cv, mask, glow_rgb, 0.018, 0.5), back)
    return back, front


def _flame_width(s):
    """Flame licks: each tongue swells at its root and tapers toward the tip of the blade."""
    lick = ((s - HELIX_START) / 0.16) % 1.0
    return (0.088 - 0.030 * s / BLADE_LEN) * (0.30 + 0.70 * (1.0 - lick) ** 0.8)


def _water_width(s):
    """Water: even ribbon with crest bulges."""
    return 0.068 * (0.78 + 0.22 * math.cos(2 * math.pi * (s - HELIX_START) / 0.16))


def _aura(cv, strength):
    mask = Image.new("L", (cv.W, cv.H), 0)
    r = min(0.5, cv.half_h * 0.6) * cv.U   # keep the halo inside the canvas, no hard edge
    ImageDraw.Draw(mask).ellipse([cv.cx - r, cv.cy - r, cv.cx + r, cv.cy + r], fill=255)
    return blur_glow(cv, mask, AURA, 0.20, 0.30 * strength)


def draw_logo(t, size=C.LOGO_SIZE):
    """RGBA logo for progress t in [0, 1]. t = 1 is the final image; the background is transparent."""
    t = clamp(t)
    cv = Canvas(size)
    blade_out = smooth(t / 0.5)                       # the blade slides out of the scabbard
    band = smooth(t / 0.3)                            # the haori band unrolls
    flame = smooth((t - 0.40) / 0.50)                 # the flame winds up the blade
    water = smooth((t - 0.50) / 0.50)                 # the water follows
    tip = BLADE_LEN * blade_out

    img = _aura(cv, 0.4 + 0.6 * band)
    img = Image.alpha_composite(img, _band(cv, band))
    flame_back, flame_front = _helix(cv, 0.0, HELIX_START + (HELIX_END - HELIX_START) * flame,
                                     FLAME_LO, FLAME_HI, _flame_width, FLAME_LO)
    water_back, water_front = _helix(cv, math.pi, HELIX_START + (HELIX_END - HELIX_START) * water,
                                     WATER_LO, WATER_HI, _water_width, WATER_HI)
    img = Image.alpha_composite(img, flame_back)
    img = Image.alpha_composite(img, water_back)
    img = Image.alpha_composite(img, _blade(cv, tip))
    img = Image.alpha_composite(img, _guard(cv, tip))
    img = Image.alpha_composite(img, _scabbard(cv))
    img = Image.alpha_composite(img, flame_front)
    img = Image.alpha_composite(img, water_front)
    return cv.finish(img)

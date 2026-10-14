"""Terminal spec for the My Hero Academia theme: a hero licence badge crackling with green lightning.

The artwork is original, drawn with Pillow (no official image). Layers, back to front: electric aura,
arcs striking off the rim, the badge (green rim, navy field with a PLUS ULTRA chevron texture, a
charge front rising from the bottom), the lightning bolt and a yellow star. t from 0 to 1: the badge
charges, the arcs strike, then it settles and the arcs die out (t = 1 is the final logo).
"""
import math
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter

import common as C
from common import Canvas, blur_glow, clamp, paint, poly_mask, smooth, vgradient, with_alpha
from common import scale_about_centre, scale_alpha

ID = "my-hero-academia"
TITLE = "Agence de Héros"
SUBTITLE = "Terminal du lycée · Plus Ultra"
FOOTER = "● énergie stable · Plus Ultra"
KEY1 = "alter"
KEY2 = "mission de héros"
ACCENT = (60, 245, 154)   # #3cf59a, the green of the theme palette (cursor and keys)
VALUE = (238, 244, 248)   # #eef4f8, the foreground of the theme palette
FETCH = {"user": "élève", "host": "lycée", "os": "campus", "cpu": "quirk",
         "memory": "énergie", "uptime": "patrouille"}

# Chromatic slots use the theme hues (red, green, yellow) and clear blue, violet and cyan.
# Neutral slots come from theme.json, then gen.py enforces the contrast ratios.
ANSI = {
    1: "#ff4b4b", 2: "#3cf59a", 3: "#ffd60a", 4: "#4aa3ff", 5: "#c792ea", 6: "#38d6e6",
    9: "#ff7a7a", 10: "#8dffc4", 11: "#ffe36b", 12: "#8cc4ff", 13: "#dcb8ff", 14: "#8fe9f5",
}

# Launcher lists: alters are invented, generic descriptions; missions are everyday hero work.
LIST1 = [
    "Cowl · puissance démultipliée",
    "Flammes · la chaleur déforme l'air",
    "Vent · un souffle qui écarte les nuages",
    "Gel · cristaux sur tout ce qu'il touche",
    "Gravité · les objets flottent autour de lui",
    "Ombre · se fondre dans la nuit",
    "Miroir · copie les gestes à distance",
    "Lianes · des plantes poussent en un clin d'œil",
    "Ondes sonores · les vitres tremblent",
    "Flash · une lumière qui aveugle un instant",
    "Eau · jets sous pression et vagues",
    "Peau d'acier · impossible à entailler",
    "Mémoire · retient tout ce qu'il lit",
    "Éponge · absorbe les liquides autour de lui",
]
LIST2 = [
    "Secourir un chat coincé dans un arbre",
    "Évacuer un immeuble en feu",
    "Escorter des touristes perdus en ville",
    "Arrêter un cambrioleur qui court trop vite",
    "Sécuriser un pont après un séisme",
    "Retrouver un sac à dos égaré dans le métro",
    "Rassurer les habitants après un orage",
    "Porter les courses d'une grand-mère au 5e",
    "Surveiller le tournoi sportif du quartier",
    "Dégager une route bloquée par la neige",
    "Éteindre un feu de forêt avant la nuit",
    "Sortir une personne d'un ascenseur bloqué",
    "Calmer un monstre de boue qui boude",
    "Patrouiller le marché de nuit",
    "Guider une classe de maternelle à la sortie",
    "Réparer un réverbère qui clignote depuis 3 ans",
]

GREEN = (60, 245, 154)
GREEN_DK = (14, 120, 84)
GREEN_HI = (150, 255, 210)
CORE = (236, 255, 246)
YELLOW = (255, 214, 10)
NAVY_TOP = (34, 46, 72)
NAVY_BOT = (12, 16, 30)

RIM_TOP = -0.44      # badge outline, in base units (v grows downwards, 0 is the centre)
BOLT = [(0.07, -0.24), (-0.16, 0.03), (-0.02, 0.03), (-0.08, 0.24), (0.16, -0.04), (0.02, -0.04)]

# Crackling arcs: (angle in degrees, start time, seed). Fixed at import, so every run draws the same.
_strike_rng = random.Random(1603)
STRIKES = [(_strike_rng.uniform(0.0, 360.0), _strike_rng.uniform(0.05, 0.75), _strike_rng.randrange(1, 1 << 30))
           for _ in range(18)]
IDLE_ANGLES = (200.0, 335.0)


# --------------------------------------------------------------------------- geometry (base units)

def _quad(p0, p1, p2, n):
    out = []
    for i in range(n + 1):
        t = i / n
        a, b, c = (1 - t) ** 2, 2 * (1 - t) * t, t * t
        out.append((a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]))
    return out


def _cubic(p0, p1, p2, p3, n):
    out = []
    for i in range(n + 1):
        t = i / n
        a, b = (1 - t) ** 3, 3 * (1 - t) ** 2 * t
        c, d = 3 * (1 - t) * t * t, t ** 3
        out.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return out


def _shield(scale=1.0, dy=0.0):
    """Badge outline: flat top with rounded corners, straight flanks, pointed base."""
    half = 0.38 * scale
    top = RIM_TOP * scale + dy
    side = 0.02 * scale + dy
    tip = 0.50 * scale + dy
    r = 0.09 * scale
    pts = [(-half + r, top), (half - r, top)]
    pts += _quad((half - r, top), (half, top), (half, top + r), 8)[1:]
    pts += [(half, side)]
    pts += _cubic((half, side), (half, side + 0.30 * scale), (0.20 * scale, tip - 0.12 * scale), (0.0, tip), 24)[1:]
    pts += _cubic((0.0, tip), (-0.20 * scale, tip - 0.12 * scale), (-half, side + 0.30 * scale), (-half, side), 24)[1:]
    pts += [(-half, top + r)]
    pts += _quad((-half, top + r), (-half, top), (-half + r, top), 8)[1:]
    return pts


def _star(cx, cy, outer, inner):
    pts = []
    for k in range(10):
        ang = -math.pi / 2 + k * math.pi / 5
        rad = outer if k % 2 == 0 else inner
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    return pts


def _sc(pts, k):
    return [(u * k, v * k) for u, v in pts]


# --------------------------------------------------------------------------- layers

def _aura(cv, k, charge):
    mask = poly_mask(cv, _sc(_shield(1.12, -0.02), k))
    return blur_glow(cv, mask, GREEN, 0.12, 0.16 + 0.32 * charge)


def _arcs(cv, t, k):
    """Jagged arcs striking off the rim. They re-jag on every frame and die out as the badge settles."""
    fade = 1.0 - smooth((t - 0.55) / 0.45)
    active = []
    for angle, t0, seed in STRIKES:
        phase = (t - t0) / 0.18
        if 0.0 <= phase <= 1.0:
            flash = math.sin(math.pi * phase) ** 0.7 * fade
            if flash >= 0.03:
                active.append((angle, flash, seed))
    # Idle sparks: a faint flicker on the settled badge, so the final logo keeps its electric aura.
    idle = 0.5 * smooth((t - 0.6) / 0.4)
    for j, angle in enumerate(IDLE_ANGLES):
        phase = (t * 2.5 + j * 0.41) % 1.0
        flash = math.sin(math.pi * phase) ** 3 * idle
        if flash >= 0.03:
            active.append((angle, flash, 900 + j))

    layer = Image.new("RGBA", (cv.W, cv.H), (0, 0, 0, 0))
    mask = Image.new("L", (cv.W, cv.H), 0)
    draw, mdraw = ImageDraw.Draw(layer), ImageDraw.Draw(mask)
    width = max(2, int(0.011 * cv.U))
    ex, ey = cv.half_w * 0.9, cv.half_h * 0.9
    for angle, flash, seed in active:
        rng = random.Random(seed * 31 + int(round(t * 15)))
        a = math.radians(angle)
        ca, sa = math.cos(a), math.sin(a)
        f = rng.uniform(0.7, 1.0)
        start = (ca * 0.36 * k, sa * 0.40 * k)
        end = (ca * ex * f, sa * ey * f)
        pts, segs = [start], 10
        dx, dy = end[0] - start[0], end[1] - start[1]
        length = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / length, dx / length
        for i in range(1, segs):
            s = i / segs
            off = rng.uniform(-0.05, 0.05) * k * math.sin(math.pi * s)
            pts.append((start[0] + dx * s + nx * off, start[1] + dy * s + ny * off))
        pts.append(end)
        px = [cv.P(u, v) for u, v in pts]
        draw.line(px, fill=GREEN + (int(255 * flash),), width=width, joint="curve")
        mdraw.line(px, fill=int(255 * flash), width=width * 3, joint="curve")
    glow = blur_glow(cv, mask, GREEN, 0.02, 0.9)
    return Image.alpha_composite(glow, layer)


def _chevrons(cv, k, inner, alpha):
    """Rows of upward chevrons (the PLUS ULTRA motif), clipped to the badge field."""
    layer = Image.new("RGBA", (cv.W, cv.H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    unit = cv.U * k
    width = max(2, int(0.012 * unit))
    half_w, height = 0.075 * unit, 0.05 * unit
    step_x, step_y = 0.16 * unit, 0.13 * unit
    row, y = 0, -0.46 * unit
    while y <= 0.46 * unit:
        offset = step_x / 2 if row % 2 else 0.0
        for col in range(-8, 9):
            cx = cv.cx + col * step_x + offset
            cy = cv.cy + y
            draw.line([(cx - half_w, cy + height), (cx, cy), (cx + half_w, cy + height)],
                      fill=GREEN + (alpha,), width=width, joint="curve")
        row, y = row + 1, y + step_y
    layer.putalpha(ImageChops.multiply(layer.getchannel("A"), inner))
    return layer


def _charge(cv, k, inner, t, settle):
    """Green charge rising from the bottom of the field, with a soft front; it fades a little on settle."""
    level = 0.46 + (-0.42 - 0.46) * smooth(t / 0.55)
    front = poly_mask(cv, _sc([(-1.0, level), (1.0, level), (1.0, 1.0), (-1.0, 1.0)], k))
    front = front.filter(ImageFilter.GaussianBlur(0.008 * cv.U))
    amount = 0.9 * (1.0 - 0.6 * settle)
    mask = ImageChops.multiply(front, inner).point(lambda v: int(v * amount))
    grad = vgradient(cv, [(-0.42 * k, GREEN), (0.44 * k, GREEN_DK)])
    return with_alpha(grad, mask)


def _emblem(cv, k, t, charge, settle):
    outer = poly_mask(cv, _sc(_shield(), k))
    inner = poly_mask(cv, _sc(_shield(0.86, -0.005), k))
    rim = ImageChops.subtract(outer, inner)

    img = blur_glow(cv, outer, GREEN, 0.05, 0.22 + 0.30 * charge + 0.20 * settle)
    field = with_alpha(vgradient(cv, [(-0.45 * k, NAVY_TOP), (0.45 * k, NAVY_BOT)]), inner)
    img = Image.alpha_composite(img, field)
    img = Image.alpha_composite(img, _chevrons(cv, k, inner, int(44 * (0.35 + 0.65 * charge))))
    img = Image.alpha_composite(img, _charge(cv, k, inner, t, settle))

    rim_img = with_alpha(vgradient(cv, [(-0.44 * k, GREEN_HI), (0.5 * k, GREEN)]), rim)
    img = Image.alpha_composite(img, scale_alpha(rim_img, 0.35 + 0.65 * charge))

    bolt_a = smooth((t - 0.35) / 0.30)
    if bolt_a > 0.0:
        bolt = poly_mask(cv, _sc(BOLT, k))
        core = poly_mask(cv, _sc([(u * 0.55, v * 0.55) for u, v in BOLT], k))
        img = Image.alpha_composite(img, blur_glow(cv, bolt, GREEN, 0.03, 0.9 * bolt_a))
        img = Image.alpha_composite(img, paint(bolt, GREEN, bolt_a))
        img = Image.alpha_composite(img, paint(core, CORE, 0.85 * bolt_a))

    star_a = smooth((t - 0.70) / 0.30)
    if star_a > 0.0:
        star = poly_mask(cv, _sc(_star(0.0, -0.30, 0.06, 0.026), k))
        img = Image.alpha_composite(img, blur_glow(cv, star, YELLOW, 0.02, 0.7 * star_a))
        img = Image.alpha_composite(img, paint(star, YELLOW, star_a))
    return img


def draw_logo(t, size=C.LOGO_SIZE):
    """RGBA logo for progress t in [0, 1]. t = 1 is the final image; the background is transparent."""
    t = clamp(t)
    cv = Canvas(size)
    k = min(1.5, cv.half_h * 1.72)        # badge height fills about 86 % of the canvas height
    charge = smooth(t / 0.55)              # the field fills from the bottom
    settle = smooth((t - 0.55) / 0.45)     # the badge snaps into place in the second half

    img = _aura(cv, k, charge)
    img = Image.alpha_composite(img, _arcs(cv, t, k))
    emblem = _emblem(cv, k, t, charge, settle)
    emblem = scale_about_centre(emblem, 1.0 + 0.06 * (1.0 - settle))
    img = Image.alpha_composite(img, emblem)
    return cv.finish(img)

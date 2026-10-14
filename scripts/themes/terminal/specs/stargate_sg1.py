"""Terminal spec for the Stargate SG-1 theme: the gate seen face-on, nine chevrons, an event horizon.

The artwork is original, drawn with Pillow (no official image). Layers, from the back: aura, outer
ring with 39 generated glyphs, groove, inner ring, event horizon, nine chevrons on the rim (the top
one lights orange). Animation (t from 0 to 1): the ring spins and stops, the chevrons lock one by
one, a blue kawoosh flashes, then the horizon settles. t = 1 is the final logo.

Geometry is in units of R, the outer radius of the ring, so the gate fits any canvas size.
"""
import math
import random

from PIL import Image, ImageDraw

import common as C
from common import Canvas, blur_glow, clamp, smooth

ID = "stargate-sg1"
TITLE = "STARGATE COMMAND"
SUBTITLE = "Terminal du SGC · Cheyenne Mountain"
FOOTER = "● horizon stable · 9 chevrons verrouillés"
KEY1 = "destination"
KEY2 = "adresse"
ACCENT = (224, 168, 74)    # theme.json orange: cursor and keys
VALUE = (238, 242, 246)    # theme.json foreground: values
FETCH = {"user": "opérateur", "host": "cheyenne", "os": "système",
         "cpu": "processeur", "memory": "réserve ZPM", "uptime": "en service"}

# Launcher destinations: invented P3X / P4X / M4C codes with a short description.
LIST1 = [
    "P3X-112 · forêt de cristal, brume bleue",
    "P3X-238 · désert ocre, tempête de sable",
    "P3X-377 · océan sans rive, marées hautes",
    "P4X-441 · jungle humide, ruines sous les lianes",
    "P3X-505 · glaciers et aurores boréales",
    "P4X-618 · cité pyramidale abandonnée",
    "M4C-022 · station minière, équipe réduite",
    "P3X-729 · plaines d'herbe, vent constant",
    "P4X-853 · volcans actifs, cendres au ciel",
    "P3X-964 · village de pêcheurs, marché au poisson",
    "M4C-137 · lune sans air, dôme scellé",
    "P3X-281 · marais toxiques, brume verte",
    "P4X-396 · temple doré, gardes en armure",
    "P3X-450 · canyons rouges, falaises sculptées",
    "P3X-573 · archipel de glace, navires gelés",
    "M4C-300 · épave de vaisseau, gravité faible",
    "P4X-684 · steppes froides, nomades à cheval",
    "P3X-717 · vallée des mégalithes",
    "P3X-802 · mer de sel, cristaux blancs",
    "P4X-905 · forêt de bambous géants",
    "P3X-939 · cité flottante sur un lac",
    "M4C-416 · relais orbital, réseau de capteurs",
    "P3X-058 · champs de maïs, ciel d'orage",
    "P4X-172 · mines abandonnées, galeries effondrées",
    "P3X-233 · récif de corail, lagons calmes",
    "P3X-348 · toundra, aurores vertes",
    "P4X-487 · cité de verre, reflets au soleil",
    "M4C-551 · astéroïde creux, base de réparation",
    "P3X-612 · désert de sel, mirages",
    "P4X-739 · forêt de brumes, sentinelles muettes",
    "P3X-868 · plateau de basalte, sources chaudes",
    "P3X-993 · colline de pierre, ruines de tours",
]

# Launcher addresses: seven glyphs, six constellations and the point of origin, drawn with a fixed seed.
CONSTELLATIONS = [  # real names, short enough to keep an address on one launcher line
    "Aquarius", "Aquila", "Aries", "Auriga", "Boötes", "Cancer", "Cetus", "Columba", "Corvus",
    "Crater", "Cygnus", "Dorado", "Draco", "Eridanus", "Fornax", "Gemini", "Grus", "Hercules",
    "Hydra", "Lacerta", "Leo", "Lepus", "Libra", "Lupus", "Lynx", "Lyra", "Norma", "Octans",
    "Orion", "Pavo", "Pegasus", "Perseus", "Phoenix", "Pisces", "Puppis", "Sagitta", "Scorpius",
    "Sculptor", "Serpens", "Sextans", "Taurus", "Vela", "Virgo",
]
ADDRESS_SEED = 1997
ORIGIN = "point d'origine"


def _addresses(count=60, seed=ADDRESS_SEED):
    rng = random.Random(seed)
    seen, out = set(), []
    while len(out) < count:
        line = " · ".join(rng.sample(CONSTELLATIONS, 6) + [ORIGIN])
        if len(line) <= 72 and line not in seen:  # "l2|" + line stays under 76 characters
            seen.add(line)
            out.append(line)
    return out


LIST2 = _addresses()

# Colours. Metal and glyphs follow the cool grey-blue of theme.json, the horizon its blue and cyan.
METAL_LO = (30, 38, 56)
METAL_MID = (120, 136, 160)
METAL_HI = (212, 226, 242)
GROOVE = (10, 14, 24)
GLYPH = (228, 244, 252)
HOLE = (8, 12, 22)                       # the gate before the horizon forms
HORIZON_CORE = (150, 232, 255)
HORIZON_MID = (44, 122, 212)
HORIZON_EDGE = (14, 38, 96)
KAWOOSH = (120, 210, 255)
AURA = (50, 120, 210)
CHEVRON_BODY = (108, 124, 148)
CHEVRON_EDGE = (214, 226, 240)
LAMP_ON = (255, 186, 90)
LAMP_TOP = (255, 160, 48)

LIGHT = -math.pi / 4                     # light from the top left
GLYPH_R = 0.92                           # centre radius of the glyph band
GROOVE_IN, INNER_IN = 0.78, 0.70         # inner ring 0.70 to 0.78; horizon radius 0.70
RING_IN, RING_OUT = 0.84, 1.00           # outer ring
CHEVRON_LOCK = [4, 5, 3, 6, 2, 7, 1, 8]  # side chevrons in lock order; the top one (0) locks last


def _glyph(index):
    """Original glyph: a short stroke on a 3 x 3 grid, plus a dot. Deterministic per index."""
    rng = random.Random(1000 + index)
    grid = [(x, y) for y in (-1, 0, 1) for x in (-1, 0, 1)]
    strokes = rng.sample(grid, rng.randint(3, 5))
    dot = rng.choice(grid) if rng.random() < 0.6 else None
    return strokes, dot


GLYPHS = [_glyph(i) for i in range(39)]


class Gate:
    """Gate geometry on a canvas. R is the outer ring radius in canvas units, chevrons reach 1.10 R."""

    def __init__(self, cv):
        self.cv = cv
        self.R = min(cv.half_w, cv.half_h) * 0.94 / 1.12

    def pt(self, angle, radius, along=0.0):
        """Pixel at `radius` R from the centre, `angle` clockwise from the top, shifted `along` R sideways."""
        s, c = math.sin(angle), math.cos(angle)
        x = (radius * s + along * c) * self.R
        y = (-radius * c + along * s) * self.R
        return self.cv.P(x, y)

    def disc_mask(self, radius):
        cv = self.cv
        r = radius * self.R * cv.U
        mask = Image.new("L", (cv.W, cv.H), 0)
        ImageDraw.Draw(mask).ellipse([cv.cx - r, cv.cy - r, cv.cx + r, cv.cy + r], fill=255)
        return mask


def _blank(cv):
    return Image.new("RGBA", (cv.W, cv.H), (0, 0, 0, 0))


def _metal(angle, p):
    """Metal colour across a band (p: 0 inner edge, 1 outer edge), lit from the top left."""
    facing = math.cos(angle - LIGHT)          # 1 where the surface faces the light
    bevel = math.sin(math.pi * p)             # 0 on both edges, 1 in the middle
    lum = 0.46 + 0.30 * facing * (0.35 + 0.65 * p) + 0.10 * bevel
    return C.interp_stops(clamp(lum), [(0.0, METAL_LO), (0.5, METAL_MID), (1.0, METAL_HI)])


def _band(gate, r0, r1, colour_fn, steps=288, layers=4):
    """Annulus from r0 to r1 (in R), built from angular segments so that the shading follows the light."""
    cv = gate.cv
    layer = _blank(cv)
    draw = ImageDraw.Draw(layer)
    for i in range(steps):
        a0, a1 = 2 * math.pi * i / steps, 2 * math.pi * (i + 1) / steps
        for j in range(layers):
            ra = r0 + (r1 - r0) * j / layers
            rb = r0 + (r1 - r0) * (j + 1) / layers
            rgb = tuple(colour_fn((a0 + a1) / 2, (j + 0.5) / layers)) + (255,)
            draw.polygon([gate.pt(a0, ra), gate.pt(a1, ra), gate.pt(a1, rb), gate.pt(a0, rb)],
                         fill=rgb, outline=rgb)
    return layer


def _glyph_band(gate, rot):
    cv = gate.cv
    layer = _blank(cv)
    draw = ImageDraw.Draw(layer)
    width = max(2, round(0.024 * gate.R * cv.U))
    for i, (strokes, dot) in enumerate(GLYPHS):
        a = rot + (i + 0.5) * 2 * math.pi / len(GLYPHS)

        def at(gx, gy, a=a):
            return gate.pt(a, GLYPH_R + gy * 0.045, along=gx * 0.042)

        draw.line([at(gx, gy) for gx, gy in strokes], fill=GLYPH + (255,), width=width, joint="curve")
        if dot:
            x, y = at(*dot)
            rd = width * 0.7
            draw.ellipse([x - rd, y - rd, x + rd, y + rd], fill=GLYPH + (255,))
    return layer


def _disc(gate, radius, colour_fn, phase=0.0, layers=72, steps=240):
    """Filled disc of `radius` R, drawn as concentric wobbling rings (rho 1 at the edge, 0 at the centre)."""
    cv = gate.cv
    layer = _blank(cv)
    draw = ImageDraw.Draw(layer)
    for j in range(layers):
        rho = 1.0 - j / layers
        rr = radius * rho
        pts = []
        for s in range(steps):
            a = 2 * math.pi * s / steps
            wobble = 1 + 0.010 * math.sin(3 * a + phase) + 0.006 * math.sin(5 * a - 1.3 * phase)
            pts.append(gate.pt(a, rr * wobble))
        rgb = tuple(colour_fn(rho)) + (255,)
        draw.polygon(pts, fill=rgb, outline=rgb)
    return layer


def _horizon_rgb(rho, vis, amp, phase):
    base = C.interp_stops(rho, [(0.0, HORIZON_CORE), (0.45, HORIZON_MID), (1.0, HORIZON_EDGE)])
    ripple = 0.5 + 0.5 * math.sin(rho * 2 * math.pi * 5.0 - phase)   # rings moving outwards
    lit = C.mix(base, HORIZON_CORE, amp * 0.8 * ripple)
    return C.mix(HOLE, lit, vis)


def _aura(gate, strength):
    return blur_glow(gate.cv, gate.disc_mask(1.05), AURA, 0.20 * gate.R, strength)


def _kawoosh(gate, wave, flash):
    """Blue wave leaving the gate centre: an expanding disc with a soft halo, fading with `flash`."""
    cv = gate.cv
    mask = gate.disc_mask((0.15 + 0.75 * wave) * INNER_IN)
    halo = blur_glow(cv, mask, KAWOOSH, 0.12 * gate.R, 0.9 * flash)
    core = Image.new("RGBA", (cv.W, cv.H), KAWOOSH + (0,))
    core.putalpha(mask.point(lambda v: int(v * 0.85 * flash)))
    return Image.alpha_composite(halo, core)


def _lamp(k, t):
    """Lamp level of chevron k: 0 unlit, 0.35 engaged (locked), 1 at the moment of the lock."""
    if k == 0:
        return smooth((t - 0.60) / 0.04)
    tt = t - (0.10 + CHEVRON_LOCK.index(k) * 0.06)
    if tt < 0:
        return 0.0
    return 0.35 + 0.65 * (1 - smooth(tt / 0.08))


def _chevrons(gate, t):
    cv = gate.cv
    bodies = _blank(cv)
    body_draw = ImageDraw.Draw(bodies)
    side_glow = Image.new("L", (cv.W, cv.H), 0)
    top_glow = Image.new("L", (cv.W, cv.H), 0)
    lamps = _blank(cv)
    lamp_draw = ImageDraw.Draw(lamps)
    for k in range(9):
        a = 2 * math.pi * k / 9
        body = [gate.pt(a, 0.88, -0.13), gate.pt(a, 0.88, 0.13), gate.pt(a, 1.12, 0.17), gate.pt(a, 1.12, -0.17)]
        body_draw.polygon(body, fill=CHEVRON_BODY + (255,), outline=CHEVRON_BODY + (255,))
        body_draw.line([gate.pt(a, 1.12, -0.17), gate.pt(a, 1.12, 0.17)], fill=CHEVRON_EDGE + (255,),
                       width=max(2, round(0.035 * gate.R * cv.U)))

        # the lamp fills the block: steel when unlit, amber when engaged, orange for the top one
        level = _lamp(k, t)
        lamp = [gate.pt(a, 1.07, -0.12), gate.pt(a, 1.07, 0.12), gate.pt(a, 0.94, 0.08), gate.pt(a, 0.94, -0.08)]
        if k == 0:
            colour = C.mix(CHEVRON_BODY, LAMP_TOP, level)
            ImageDraw.Draw(top_glow).polygon(lamp, fill=int(255 * level))
        else:
            colour = C.mix(CHEVRON_BODY, LAMP_ON, level)
            ImageDraw.Draw(side_glow).polygon(lamp, fill=int(255 * level))
        lamp_draw.polygon(lamp, fill=tuple(colour) + (255,))

    # the lamps glow only when lit; the top glow is stronger, it is the one that lights orange
    glow = blur_glow(cv, side_glow, LAMP_ON, 0.05 * gate.R, 0.8)
    glow = Image.alpha_composite(glow, blur_glow(cv, top_glow, LAMP_TOP, 0.06 * gate.R, 0.95))
    return Image.alpha_composite(Image.alpha_composite(bodies, glow), lamps)


def draw_logo(t, size=C.LOGO_SIZE):
    """RGBA logo for progress t in [0, 1]. t = 1 is the final image; the background is transparent."""
    t = clamp(t)
    cv = Canvas(size)
    gate = Gate(cv)

    spin = 0.75 * 2 * math.pi * (1 - smooth(min(t, 0.6) / 0.6))   # the ring spins, then stops at t = 0.6
    horizon = smooth((t - 0.62) / 0.24)                            # the horizon forms during the kawoosh
    flash = smooth((t - 0.60) / 0.06) * (1 - smooth((t - 0.66) / 0.26))
    wave = clamp((t - 0.60) / 0.30)
    amp = 0.30 + 0.45 * (1 - smooth((t - 0.70) / 0.30))            # ripples settle to a gentle motion
    phase = 5.0 * t

    img = _aura(gate, 0.10 + 0.22 * horizon + 0.35 * flash)
    img = Image.alpha_composite(img, _band(gate, RING_IN, RING_OUT, _metal))
    img = Image.alpha_composite(img, _glyph_band(gate, spin))
    img = Image.alpha_composite(img, _band(gate, GROOVE_IN, RING_IN, lambda a, p: GROOVE))
    img = Image.alpha_composite(img, _band(gate, INNER_IN, GROOVE_IN, _metal))
    img = Image.alpha_composite(img, _disc(gate, INNER_IN, lambda rho: _horizon_rgb(rho, horizon, amp, phase),
                                           phase=phase))
    if 0.0 < wave and t < 0.90:
        img = Image.alpha_composite(img, _kawoosh(gate, wave, flash))
    img = Image.alpha_composite(img, _chevrons(gate, t))
    return cv.finish(img)

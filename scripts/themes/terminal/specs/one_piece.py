"""Terminal spec for the One Piece theme: a log pose over the sea, a straw hat at its centre.

The artwork is original, drawn with Pillow: no official image and no Jolly Roger. Layers, back to
front: halo, back swell, ship's-wheel rim, compass face with its rose, needle, straw hat, front sea.
Animation (t from 0 to 1): the needle spins, slows down and locks on north, the swell rolls.
t = 1 is the final logo.
"""
import math

from PIL import Image, ImageChops, ImageDraw

import common as C
from common import Canvas, blur_glow, clamp, paint, poly_mask, vgradient, with_alpha

ID = "one-piece"
TITLE = "Grand Line"
SUBTITLE = "Journal de bord · équipage pirate"
FOOTER = "● cap tenu · log pose calé"
KEY1 = "prime"
KEY2 = "île"
ACCENT = (247, 214, 112)  # gold: cursor and keys (the yellow of theme.json)
VALUE = (244, 241, 230)   # cream: the foreground of theme.json
FETCH = {"user": "pirate", "host": "navire", "os": "carte", "cpu": "vigie",
         "memory": "cale", "uptime": "traversée"}

# Maritime slots: coral red, sea green, gold, ocean blue, violet, lagoon teal (contrast checked by gen.py).
ANSI = {
    1: "#ff6b5e", 2: "#5cc08a", 3: "#f7d670", 4: "#3f8fd6", 5: "#b07ad9", 6: "#4fd1c5",
    9: "#ff8a7f", 10: "#8ad9a8", 11: "#ffe08a", 12: "#7fb5ec", 13: "#c99be6", 14: "#9ce6dd",
}

# Random lists for the launcher: bounties (invented pirates) and seas or islands (invented or generic).
LIST1 = [
    "Sourire-de-Glace · 1 200 000 000 berrys",
    "Capitaine Coquille · 80 000 000 berrys",
    "Mousse Bancal · 15 000 000 berrys",
    "Vigie Sans-Nom · 500 000 000 berrys",
    "Cuistot Flamme-Bleue · 330 000 000 berrys",
    "Épéiste Tranchemer · 1 000 000 000 berrys",
    "Navigatrice Ondine · 3 000 000 000 berrys",
    "Tireur Cent-Balles · 120 000 000 berrys",
    "Médecin Cul-de-Rhum · 60 000 000 berrys",
    "Charpentier Marteau-Doux · 45 000 000 berrys",
    "Archère Aile-de-Corbeau · 210 000 000 berrys",
    "Musicien Chant-du-Flot · 88 000 000 berrys",
    "Ex-Marine Sabre-Gris · 25 000 000 berrys",
    "Pilote Vent-d'Ouest · 2 000 000 000 berrys",
]
LIST2 = [
    "Île du Ciel · cité suspendue aux nuages",
    "Archipel des Tempêtes",
    "Mer des Brumes · sans fond connu",
    "Récif du Tonnerre",
    "Mer Calme · pas un souffle de vent",
    "Île des Géants · tables de pierre",
    "Baie du Requin Blanc",
    "Îles Dorées · ruines d'un ancien royaume",
    "Mer de Sable · dunes de cendre",
    "Île Glacée · au bout du monde",
    "Port-Frappe · marché noir et contrebande",
    "Archipel des Mille Voiles",
    "Îlot des Sirènes",
    "Cap Sans-Retour · courants mortels",
    "Volcan Cœur-de-Feu",
    "Île aux Fleurs Mouvantes",
]

# Drawing constants, in canvas units (0, 0 is the centre of the canvas, 1 unit is about 1/3 of the height).
CY = -0.10                 # compass centre
FACE_R, RIM_R = 0.30, 0.355
SPOKE_R, KNOB_R = 0.40, 0.03
FACE = (14, 46, 78)
GOLD = (247, 214, 112)
GOLD_D = (222, 150, 70)
CORAL = (255, 107, 94)
CREAM = (244, 236, 214)
CREAM_D = (206, 190, 150)
SEA_BACK = ((79, 209, 197), (34, 130, 178), (16, 70, 116))   # crest, mid, deep
SEA_FRONT = ((60, 170, 200), (20, 92, 146), (8, 38, 70))


# --------------------------------------------------------------------------- masks

def _ellipse(cv, u0, v0, rx, ry):
    img = Image.new("L", (cv.W, cv.H), 0)
    x0, y0 = cv.P(u0 - rx, v0 - ry)
    x1, y1 = cv.P(u0 + rx, v0 + ry)
    ImageDraw.Draw(img).ellipse([x0, y0, x1, y1], fill=255)
    return img


def _rect(cv, u0, v0, u1, v1):
    img = Image.new("L", (cv.W, cv.H), 0)
    x0, y0 = cv.P(u0, v0)
    x1, y1 = cv.P(u1, v1)
    ImageDraw.Draw(img).rectangle([x0, y0, x1, y1], fill=255)
    return img


def _dir(phi):
    """Unit vector for an angle phi measured clockwise from north (screen y points down)."""
    return math.sin(phi), -math.cos(phi)


def _flank(cv, cu, cv_v, phi, length, half_w, side):
    """Triangle from the centre to a tip at `length` along phi; `side` (+1 or -1) picks a flank."""
    dx, dy = _dir(phi)
    px, py = -dy * side, dx * side
    pts = [(cu, cv_v), (cu + dx * length, cv_v + dy * length), (cu + px * half_w, cv_v + py * half_w)]
    return poly_mask(cv, pts)


def _bar(cv, cu, cv_v, phi, r0, r1, half_w):
    dx, dy = _dir(phi)
    px, py = -dy * half_w, dx * half_w
    pts = [(cu + dx * r0 + px, cv_v + dy * r0 + py), (cu + dx * r1 + px, cv_v + dy * r1 + py),
           (cu + dx * r1 - px, cv_v + dy * r1 - py), (cu + dx * r0 - px, cv_v + dy * r0 - py)]
    return poly_mask(cv, pts)


def _over(base, layer):
    return Image.alpha_composite(base, layer)


# --------------------------------------------------------------------------- parts

def _halo(cv):
    """Warm gold glow behind the compass, kept inside the canvas."""
    return blur_glow(cv, _ellipse(cv, 0, CY, RIM_R + 0.04, RIM_R + 0.04), GOLD, 0.12, 0.26)


def _wheel(cv):
    """Ship's-wheel rim: a gold ring with eight spokes and a knob at each end."""
    rim = ImageChops.subtract(_ellipse(cv, 0, CY, RIM_R, RIM_R), _ellipse(cv, 0, CY, FACE_R, FACE_R))
    spokes = Image.new("L", (cv.W, cv.H), 0)
    knobs = Image.new("L", (cv.W, cv.H), 0)
    for k in range(8):
        phi = k * math.pi / 4
        spokes = ImageChops.lighter(spokes, _bar(cv, 0, CY, phi, RIM_R - 0.01, SPOKE_R, 0.024))
        dx, dy = _dir(phi)
        knobs = ImageChops.lighter(knobs, _ellipse(cv, dx * (SPOKE_R + 0.02), CY + dy * (SPOKE_R + 0.02),
                                                   KNOB_R, KNOB_R))
    layer = paint(rim, GOLD)
    layer = _over(layer, paint(ImageChops.lighter(spokes, knobs), GOLD_D))
    return layer


def _face(cv):
    """Navy compass face with a gold rose: long points on the cardinal directions, two-tone flanks."""
    img = paint(_ellipse(cv, 0, CY, FACE_R, FACE_R), FACE)
    for k in range(8):
        phi = k * math.pi / 4
        cardinal = k % 2 == 0
        length = 0.27 if cardinal else 0.18
        half_w = 0.07 if cardinal else 0.05
        img = _over(img, paint(_flank(cv, 0, CY, phi, length, half_w, +1), GOLD))
        img = _over(img, paint(_flank(cv, 0, CY, phi, length, half_w, -1), GOLD_D))
    return img


def _needle(cv, phi):
    """Coral north half, cream south half. The north half is short enough to end under the hat."""
    img = paint(_flank(cv, 0, CY, phi, 0.12, 0.07, +1), CORAL)
    img = _over(img, paint(_flank(cv, 0, CY, phi, 0.12, 0.07, -1), CORAL))
    south = phi + math.pi
    img = _over(img, paint(_flank(cv, 0, CY, south, 0.22, 0.07, +1), CREAM))
    img = _over(img, paint(_flank(cv, 0, CY, south, 0.22, 0.07, -1), CREAM_D))
    return img


def _hat(cv):
    """Straw hat: cream brim (0.28 x 0.06), domed crown in shade and light, coral band at CY-0.02..CY+0.02."""
    brim = _ellipse(cv, 0, CY, 0.28, 0.06)
    dome = ImageChops.multiply(_ellipse(cv, 0, CY - 0.02, 0.11, 0.14),
                               _rect(cv, -0.11, CY - 0.2, 0.11, CY - 0.02))
    band = _rect(cv, -0.11, CY - 0.02, 0.11, CY + 0.02)
    crown = ImageChops.lighter(dome, band)
    shade = ImageChops.multiply(crown, _rect(cv, 0.0, CY - 0.2, 0.2, CY + 0.1))
    img = paint(brim, CREAM)
    img = _over(img, paint(crown, CREAM))
    img = _over(img, paint(shade, CREAM_D))
    img = _over(img, paint(band, CORAL))
    return img


def _swell(cv, base, amp, freq, phase, colours):
    """A wave band: sine surface at `base`, filled down to the bottom edge, colour by depth."""
    crest, mid, deep = colours
    n = 200
    top = []
    for i in range(n + 1):
        u = -cv.half_w - 0.05 + (2 * cv.half_w + 0.10) * i / n
        top.append((u, base + amp * math.sin(2 * math.pi * freq * u + phase)))
    bottom = cv.half_h + 0.1
    mask = poly_mask(cv, top + [(cv.half_w + 0.05, bottom), (-cv.half_w - 0.05, bottom)])
    stops = [(base - 0.06, crest), (base + 0.05, mid), (bottom, deep)]
    return with_alpha(vgradient(cv, stops), mask)


# --------------------------------------------------------------------------- logo

def draw_logo(t, size=C.LOGO_SIZE):
    """RGBA logo for progress t in [0, 1]. t = 1 is the final image; the background is transparent."""
    t = clamp(t)
    cv = Canvas(size)
    needle = 2 * math.pi * 2.5 * (1.0 - t) ** 2.2   # 2.5 turns that slow down, exactly north at t = 1
    roll = 2 * math.pi * t                          # the swell rolls one full period

    img = _halo(cv)
    img = _over(img, _swell(cv, 0.24, 0.035, 1.6, roll + 1.3, SEA_BACK))
    img = _over(img, _wheel(cv))
    img = _over(img, _face(cv))
    img = _over(img, _needle(cv, needle))
    img = _over(img, _hat(cv))
    img = _over(img, _swell(cv, 0.33, 0.025, 2.2, roll, SEA_FRONT))
    return cv.finish(img)

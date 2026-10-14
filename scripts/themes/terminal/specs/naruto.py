"""Terminal spec for the Naruto theme: a Konoha headband plate with a chakra vortex.

The artwork is original, drawn with Pillow (no official image). The layers follow the usual
headband composition: aura, chakra rings, fabric band, tails, plate, then the vortex that fades out
as the plate settles (t from 0 to 1).
"""
import math

from PIL import Image, ImageChops, ImageDraw

import common as C
from common import Canvas, blur_glow, clamp, paint, poly_mask, ramp_down, rrect_mask
from common import scale_about_centre, scale_alpha, smooth, vgradient, with_alpha, fade_mask

ID = "naruto"
TITLE = "Dojo de Konoha"
SUBTITLE = "Terminal du dojo · rang jōnin"
FOOTER = "● chakra stable · sceau verrouillé"
KEY1 = "mission"
KEY2 = "jutsu"
ACCENT = (242, 140, 40)    # orange, cursor and keys
VALUE = (248, 248, 242)    # foreground of the theme.json palette
FETCH = {"user": "ninja", "host": "village", "os": "parchemin",
         "cpu": "chakra", "memory": "réserve", "uptime": "en mission"}

# Chromatic ANSI slots keep the Ninja Dojo palette (Konoha orange, band blue, leaf green).
# Neutral slots and the bright-black slot come from theme.json, then gen.py enforces contrast.
ANSI = {
    1: "#c0392b", 2: "#6aa84f", 3: "#e0a53a", 4: "#4a6fc0", 5: "#9a5fb0", 6: "#4fa3b8",
    9: "#e0584a", 10: "#8fcf6a", 11: "#f28c28", 12: "#7d9be0", 13: "#bb85d0", 14: "#7fc7d8",
}

# Random lists for the launcher (missions and techniques, taken from play.zsh).
LIST1 = [
    "Escorter le pont de Tazuna",
    "Retrouver le chat Tora",
    "Infiltrer Ame",
    "Protéger le daimyō",
    "Traquer un ninja déserteur",
    "Livrer un parchemin scellé",
    "Garder les portes de Konoha",
    "Nettoyer la forêt de la mort",
    "Escorter une caravane jusqu'à Suna",
    "Sceller un démon au Pays de l'Eau",
    "Patrouiller la frontière du Pays du Feu",
    "Espionner un repaire de l'Akatsuki",
    "Ramasser des herbes pour le médecin du village",
    "Chasser les bandits du Pays des Vagues",
]
LIST2 = [
    "Kage Bunshin · clones d'ombre",
    "Rasengan · sphère de chakra",
    "Chidori · mille oiseaux",
    "Kawarimi · substitution",
    "Shunshin · pas éclair",
    "Katon · Gōkakyū, grande boule de feu",
    "Doton · Doryūheki, mur de terre",
    "Hiraishin · marque éclair",
    "Tsukuyomi · monde d'illusion",
    "Rasen Shuriken · tourbillon tranchant",
]

ORANGE = (242, 140, 40)
BLUE = (59, 91, 165)
BLUE_HI = (127, 155, 216)
CREAM = (243, 233, 210)
NAVY = (14, 18, 34)
DEEP = (8, 10, 20)

PLATE_W, PLATE_H, PLATE_R, BEVEL = 0.46, 0.36, 0.12, 0.022
LEAF_LEN, LEAF_HALF = 0.50, 0.17


def _shade(rgb, factor):
    return tuple(int(clamp(c * factor, 0, 255)) for c in rgb)


def _leaf_outline(n=72):
    right, left = [], []
    for i in range(n + 1):
        t = i / n
        v = -LEAF_LEN / 2 + LEAF_LEN * t
        half = LEAF_HALF * math.sin(math.pi * t) ** 0.85
        bow = 0.03 * math.sin(math.pi * t)
        right.append((bow + half, v))
        left.append((bow - half, v))
    return right + left[::-1]


def _spiral(cv):
    """Orange chakra spiral engraved in the leaf: returns the colour layer and its mask."""
    layer = Image.new("RGBA", (cv.W, cv.H), (0, 0, 0, 0))
    mask = Image.new("L", (cv.W, cv.H), 0)
    draw, mdraw = ImageDraw.Draw(layer), ImageDraw.Draw(mask)
    steps, prev = 240, None
    for j in range(steps + 1):
        s = j / steps
        th = 0.6 + s * 7.4
        r = 0.010 + 0.0125 * th
        point = cv.P(r * math.cos(th), r * math.sin(th))
        if prev is not None:
            w = max(2, int((0.040 - 0.024 * s) * cv.U))
            draw.line([prev, point], fill=ORANGE + (255,), width=w)
            draw.ellipse([point[0] - w / 2, point[1] - w / 2, point[0] + w / 2, point[1] + w / 2],
                         fill=ORANGE + (255,))
            mdraw.line([prev, point], fill=255, width=w)
        prev = point
    return layer, mask


def _plate(cv):
    """Metal plate with bevel, engraved leaf and chakra spiral (static, RGBA)."""
    full = rrect_mask(cv, PLATE_W, PLATE_H, PLATE_R)
    lower = rrect_mask(cv, PLATE_W, PLATE_H, PLATE_R, dx=BEVEL, dy=BEVEL)
    upper = rrect_mask(cv, PLATE_W, PLATE_H, PLATE_R, dx=-BEVEL, dy=-BEVEL)
    metal = vgradient(cv, [(-0.36, (226, 231, 242)), (-0.20, (150, 160, 186)),
                           (-0.02, (96, 105, 134)), (0.14, (62, 68, 96)), (0.36, (30, 34, 52))],
                      seed=7, amp=0.025)
    img = with_alpha(metal, full)
    img = Image.alpha_composite(img, paint(ImageChops.subtract(full, lower), CREAM, 0.9))
    img = Image.alpha_composite(img, paint(ImageChops.subtract(full, upper), DEEP, 0.85))

    leaf = poly_mask(cv, _leaf_outline())
    offset = int(0.012 * cv.U)
    leaf_shifted = ImageChops.offset(leaf, -offset, -offset)
    img = Image.alpha_composite(img, paint(leaf, NAVY))
    img = Image.alpha_composite(img, paint(ImageChops.subtract(leaf, leaf_shifted), CREAM, 0.55))

    layer, mask = _spiral(cv)
    img = Image.alpha_composite(img, blur_glow(cv, mask, ORANGE, 0.02, 0.7))
    return Image.alpha_composite(img, layer)


def _aura(cv, p):
    mask = Image.new("L", (cv.W, cv.H), 0)
    r = min(0.5, cv.half_h * 0.6) * cv.U   # keep the halo inside the canvas, no hard edge
    ImageDraw.Draw(mask).ellipse([cv.cx - r, cv.cy - r, cv.cx + r, cv.cy + r], fill=255)
    return blur_glow(cv, mask, ORANGE, 0.22, 0.32 * (0.4 + 0.6 * p))


def _rings(cv, theta, strength):
    """Two dashed chakra rings; they turn with the vortex and slow down with it."""
    layer = Image.new("RGBA", (cv.W, cv.H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    rad1 = min(0.62, cv.half_h * 0.9)
    rad2 = min(0.74, cv.half_h * 0.97)
    width = max(2, int(0.008 * cv.U))
    for rad, count, alpha, sign in [(rad1, 12, 150, 1.0), (rad2, 20, 90, -0.6)]:
        box = [cv.cx - rad * cv.U, cv.cy - rad * cv.U, cv.cx + rad * cv.U, cv.cy + rad * cv.U]
        step = 360.0 / count
        base = math.degrees(theta * sign)
        for k in range(count):
            start = base + k * step
            draw.arc(box, start=start, end=start + step * 0.55,
                     fill=BLUE_HI + (int(alpha * strength),), width=width)
    return layer


def _band(cv):
    """Blue fabric band behind the plate, fading out at the canvas sides."""
    xs = [-cv.half_w + 2 * cv.half_w * i / 239 for i in range(240)]
    top = [cv.P(x, -0.13 + 0.02 * x * x) for x in xs]
    bottom = [cv.P(x, 0.13 + 0.02 * x * x) for x in reversed(xs)]
    mask = Image.new("L", (cv.W, cv.H), 0)
    ImageDraw.Draw(mask).polygon(top + bottom, fill=255)
    fade_start = cv.half_w * 0.7
    mask = ImageChops.multiply(mask, fade_mask(cv, lambda u: ramp_down(abs(u), fade_start, cv.half_w)))

    tone = vgradient(cv, [(-0.14, _shade(BLUE, 1.10)), (0.0, _shade(BLUE, 0.92)),
                          (0.14, _shade(BLUE, 0.62))])
    weave = Image.new("RGB", (cv.W, cv.H), (255, 255, 255))
    draw = ImageDraw.Draw(weave)
    period = max(4, int(0.02 * cv.U))
    for x in range(0, cv.W, period):
        draw.line([(x, 0), (x, cv.H)], fill=(244, 244, 244))
    return with_alpha(ImageChops.multiply(tone, weave), mask)


def _ribbon(cv, centre, w0, w1):
    left, right = [], []
    n = len(centre)
    for i, (u, v) in enumerate(centre):
        a, b = centre[max(i - 1, 0)], centre[min(i + 1, n - 1)]
        du, dv = b[0] - a[0], b[1] - a[1]
        length = math.hypot(du, dv) or 1.0
        nu, nv = -dv / length, du / length
        w = (w0 + (w1 - w0) * i / (n - 1)) / 2
        left.append((u + nu * w, v + nv * w))
        right.append((u - nu * w, v - nv * w))
    return left + right[::-1]


def _notch(cv, centre):
    """V cut at the free end of a ribbon."""
    (u0, v0), (u1, v1) = centre[-2], centre[-1]
    length = math.hypot(u1 - u0, v1 - v0)
    du, dv = (u1 - u0) / length, (v1 - v0) / length
    nu, nv = -dv, du
    eu, ev = centre[-1]
    apex = (eu - du * 0.10, ev - dv * 0.10)
    corner_a = (eu + nu * 0.22 + du * 0.12, ev + nv * 0.22 + dv * 0.12)
    corner_b = (eu - nu * 0.22 + du * 0.12, ev - nv * 0.22 + dv * 0.12)
    return poly_mask(cv, [apex, corner_a, corner_b])


def _tails(cv):
    """Two ribbon tails hanging under the band on the right, with V-cut ends."""
    end_front = min(0.72, cv.half_h * 0.95)
    end_back = end_front * 0.92
    n = 40
    steps = [i / (n - 1) for i in range(n)]
    back = [(0.36 + 0.10 * s, end_back * s) for s in steps]
    front = [(0.40 + 0.22 * s + 0.03 * math.sin(3 * s), end_front * s) for s in steps]
    back_mask = ImageChops.subtract(poly_mask(cv, _ribbon(cv, back, 0.17, 0.12)), _notch(cv, back))
    front_mask = ImageChops.subtract(poly_mask(cv, _ribbon(cv, front, 0.20, 0.14)), _notch(cv, front))
    layer = Image.alpha_composite(Image.new("RGBA", (cv.W, cv.H), (0, 0, 0, 0)),
                                  paint(back_mask, (34, 56, 112)))
    return Image.alpha_composite(layer, paint(front_mask, BLUE))


def _vortex(cv, theta, strength):
    """Three-arm chakra vortex, cream to orange, with a soft glow."""
    layer = Image.new("RGBA", (cv.W, cv.H), (0, 0, 0, 0))
    mask = Image.new("L", (cv.W, cv.H), 0)
    draw, mdraw = ImageDraw.Draw(layer), ImageDraw.Draw(mask)
    reach = min(0.66, cv.half_h * 0.9)
    segs = 48
    for arm in range(3):
        pts = []
        for j in range(segs + 1):
            s = j / segs
            r = 0.05 + (reach - 0.05) * s
            ang = theta + arm * 2 * math.pi / 3 + 2.4 * s ** 1.1
            pts.append((s, cv.P(r * math.cos(ang), r * math.sin(ang))))
        for (s0, p0), (s1, p1) in zip(pts, pts[1:]):
            s = (s0 + s1) / 2
            w = max(2, int((0.010 + 0.060 * (1 - s)) * cv.U))
            col = C.mix(CREAM, ORANGE, min(1.0, s * 1.4))
            alpha = int(255 * strength * (0.55 + 0.45 * (1 - s)))
            draw.line([p0, p1], fill=col + (alpha,), width=w)
            draw.ellipse([p1[0] - w / 2, p1[1] - w / 2, p1[0] + w / 2, p1[1] + w / 2], fill=col + (alpha,))
            mdraw.line([p0, p1], fill=int(230 * strength), width=w * 3)
    return Image.alpha_composite(blur_glow(cv, mask, ORANGE, 0.03, 0.9), layer)


def draw_logo(t, size=C.LOGO_SIZE):
    """RGBA logo for progress t in [0, 1]. t = 1 is the final image; the background is transparent."""
    t = clamp(t)
    cv = Canvas(size)
    settle = smooth((t - 0.5) / 0.5)           # the plate lands in the second half
    strength = max(0.0, 1.0 - 1.15 * t) ** 1.2  # the vortex fades out
    theta = 6.0 * (1.0 - (1.0 - t) ** 2.5)      # the vortex turns and slows down

    img = _aura(cv, settle)
    img = Image.alpha_composite(img, _rings(cv, theta, 0.35 + 0.65 * settle))
    img = Image.alpha_composite(img, _band(cv))
    img = Image.alpha_composite(img, _tails(cv))
    if strength > 0.001:
        img = Image.alpha_composite(img, _vortex(cv, theta, strength))
    plate = scale_about_centre(_plate(cv), 1.10 - 0.10 * settle)
    img = Image.alpha_composite(img, scale_alpha(plate, settle))
    return cv.finish(img)

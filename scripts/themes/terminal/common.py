"""Shared generator for a theme's terminal bundle (Ghostty, Terminal.app, fastfetch).

Inputs : specs/<id>.py (contract in README.md) and src/themes/<id>/theme.json.
Outputs: src/themes/<id>/terminal/ (written by gen.py).
Needs  : Python 3 and Pillow. No numpy, no network, no personal paths.
"""
import colorsys
import json
import random
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

REPO = Path(__file__).resolve().parents[3]
THEMES = REPO / "src" / "themes"
SUPERSAMPLE = 2
LOGO_SIZE = (960, 384)            # default size of draw_logo(): 2.5:1 drawing canvas
OUT_SIZE = (480, 384)             # logo output: 5:4, the shape of TEXT_COLS x TEXT_ROWS cells at 1:2
TEXT_COLS, TEXT_ROWS = 30, 12     # Terminal.app text logo, in terminal cells
CONTRAST_TEXT = 4.5               # WCAG AA for normal text, applied to ANSI 1-15
CONTRAST_FG = 7.0                 # WCAG AAA for the foreground on the background
NEUTRAL_KEYS = {"bg", "line", "fg", "muted", "dim"}
ANSI_HUES = {1: 0, 2: 120, 3: 55, 4: 220, 5: 290, 6: 185}  # hue targets (degrees)
FETCH_DEFAULTS = {"user": "user", "host": "host", "os": "os", "cpu": "cpu",
                  "memory": "memory", "uptime": "uptime"}
FETCH_ORDER = ["user", "host", "os", "cpu", "memory", "uptime"]
FETCH_FORMATS = {"user": ("title", "{user-name}"), "host": ("title", "{host-name}"),
                 "os": ("os", "{name} {version}"), "cpu": ("cpu", "{name} · {cores-physical} cœurs"),
                 "memory": ("memory", None), "uptime": ("uptime", None)}


# --------------------------------------------------------------------------- colors

_HEX = re.compile(r"^#?([0-9a-fA-F]{6})$")


def parse_color(value):
    """'#rrggbb', 'rgb(...)', 'rgba(...)' (alpha dropped) or (r, g, b) -> (r, g, b)."""
    if isinstance(value, (tuple, list)):
        return tuple(int(x) for x in value[:3])
    text = str(value).strip()
    match = _HEX.match(text)
    if match:
        v = int(match.group(1), 16)
        return ((v >> 16) & 255, (v >> 8) & 255, v & 255)
    match = re.match(r"^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)", text)
    if match:
        return tuple(int(round(float(x))) for x in match.groups())
    raise ValueError(f"unrecognised colour: {value!r}")


def to_hex(rgb):
    return "#%02x%02x%02x" % tuple(int(c) for c in rgb)


def luminance(rgb):
    def channel(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def hue_distance(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def ensure_contrast(rgb, bg, target, notes, name):
    """Moves rgb toward white (dark bg) or black (light bg) until it reaches the target ratio."""
    if contrast(rgb, bg) >= target:
        return rgb
    toward = (255, 255, 255) if luminance(bg) < 0.18 else (0, 0, 0)
    for step in range(1, 101):
        cand = mix(rgb, toward, step / 100)
        if contrast(cand, bg) >= target:
            notes.append(f"{name}: {to_hex(rgb)} -> {to_hex(cand)} (contrast {contrast(cand, bg):.2f})")
            return cand
    raise ValueError(f"{name}: cannot reach contrast {target} against {to_hex(bg)}")


# --------------------------------------------------------------------------- theme and palette

def load_theme(theme_id):
    path = THEMES / theme_id / "theme.json"
    if not path.is_file():
        raise FileNotFoundError(f"missing {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _default_ansi(chroma, neutral, bg, fg):
    """Fallback ANSI colours when the spec gives no override: nearest palette hue, else a generated hue."""
    hls = [colorsys.rgb_to_hls(*(c / 255 for c in rgb)) for rgb in chroma]
    if hls:
        avg_l = sum(x[1] for x in hls) / len(hls)
        avg_s = sum(x[2] for x in hls) / len(hls)
    else:
        avg_l, avg_s = 0.6, 0.6
    colours = {0: mix(bg, neutral["dim"], 0.35), 7: neutral["muted"], 8: neutral["dim"], 15: fg}
    for index, target in ANSI_HUES.items():
        best, best_d = None, 999.0
        for rgb, (h, _, _) in zip(chroma, hls):
            d = hue_distance(h * 360, target)
            if d < best_d:
                best, best_d = rgb, d
        if best is None or best_d > 30:
            best = tuple(round(c * 255) for c in colorsys.hls_to_rgb(target / 360, avg_l, avg_s))
        colours[index] = best
        colours[index + 8] = mix(best, fg, 0.25)
    return colours


def build_palette(theme, spec):
    """Returns the terminal palette: ANSI 0-15, background, foreground, cursor and selection."""
    source = theme["palette"]
    notes = []
    neutral = {k: parse_color(source[k]) for k in ("bg", "fg", "muted", "dim") if k in source}
    bg = neutral["bg"]
    fg = ensure_contrast(neutral["fg"], bg, CONTRAST_FG, notes, "foreground")
    chroma = [parse_color(v) for k, v in source.items() if k not in NEUTRAL_KEYS]
    ansi = _default_ansi(chroma, neutral, bg, fg)
    for index, value in (getattr(spec, "ANSI", None) or {}).items():
        index = int(index)
        if not 0 <= index <= 15:
            raise ValueError(f"ANSI override index out of range: {index}")
        ansi[index] = parse_color(value)
    for index in range(1, 16):
        ansi[index] = ensure_contrast(ansi[index], bg, CONTRAST_TEXT, notes, f"ANSI {index}")
    accent = tuple(spec.ACCENT)
    sel_bg = mix(bg, accent, 0.25)
    sel_fg = ensure_contrast(fg, sel_bg, CONTRAST_TEXT, notes, "selection-foreground")
    return {
        "bg": bg, "fg": fg, "cursor": accent, "cursor_text": bg,
        "sel_bg": sel_bg, "sel_fg": sel_fg,
        "ansi": [ansi[i] for i in range(16)], "notes": notes,
    }


# --------------------------------------------------------------------------- text outputs

def ghostty_text(spec, theme, pal):
    lines = [
        f"# {theme.get('name', spec.ID)} : Ghostty palette derived from src/themes/{spec.ID}/theme.json.",
        "# Generated by scripts/themes/terminal/gen.py. Do not edit by hand.",
        "",
    ]
    lines += [f"palette = {i}={to_hex(c)}" for i, c in enumerate(pal["ansi"])]
    lines += [
        "",
        f"background = {to_hex(pal['bg'])}",
        f"foreground = {to_hex(pal['fg'])}",
        f"cursor-color = {to_hex(pal['cursor'])}",
        f"cursor-text = {to_hex(pal['cursor_text'])}",
        f"selection-background = {to_hex(pal['sel_bg'])}",
        f"selection-foreground = {to_hex(pal['sel_fg'])}",
        "",
    ]
    return "\n".join(lines)


def _escape(rgb):
    return "\u001b[38;2;%d;%d;%dm" % tuple(rgb)


def _fetch_labels(spec):
    labels = dict(FETCH_DEFAULTS)
    labels.update(getattr(spec, "FETCH", None) or {})
    return labels


def fastfetch_jsonc(spec, pal, text_logo):
    """Returns a JSONC fastfetch config with one '// @DYNAMIC@' line for the launcher."""
    labels = _fetch_labels(spec)
    keys = [f"✦ {labels[k]}" for k in FETCH_ORDER]
    width = max(len(k) for k in keys) + 1
    accent, value = _escape(spec.ACCENT), _escape(spec.VALUE)
    reset = "\u001b[0m"
    title_line = f"{accent}◢◤ {spec.TITLE.upper()} ◥◣{reset}"
    subtitle_line = f"{_escape(pal['ansi'][12])}── {spec.SUBTITLE} ──{reset}"
    modules = ["break", {"type": "custom", "format": title_line},
               {"type": "custom", "format": subtitle_line}, "break"]
    for key_name, key_text in zip(FETCH_ORDER, keys):
        module_type, fmt = FETCH_FORMATS[key_name]
        module = {"type": module_type, "key": key_text.ljust(width)}
        if fmt:
            module["format"] = fmt
        modules.append(module)
    modules.append("__DYNAMIC__")
    modules.append("break")
    footer = getattr(spec, "FOOTER", None)
    if footer:
        modules.append({"type": "custom", "format": f"{_escape(pal['ansi'][10])}{footer}{reset}"})
    if text_logo:
        # No source: the launcher passes --logo <theme>/logo.txt --logo-type file (or --logo none).
        logo = {"type": "none", "padding": {"top": 0, "left": 2, "right": 4}}
    else:
        logo = {"width": TEXT_COLS, "height": TEXT_ROWS,
                "padding": {"top": 0, "left": 2, "right": 4}}
    config = {
        "$schema": "https://github.com/fastfetch-cli/fastfetch/raw/dev/doc/json_schema.json",
        "logo": logo,
        "display": {"separator": "  ", "color": {"keys": "38;2;%d;%d;%d" % spec.ACCENT,
                                              "output": "38;2;%d;%d;%d" % spec.VALUE}},
        "modules": modules,
    }
    text = json.dumps(config, indent=2, ensure_ascii=False)
    text = re.sub(r'^(\s*)"__DYNAMIC__",?$', r"\1// @DYNAMIC@", text, flags=re.M)
    if text.count("// @DYNAMIC@") != 1:
        raise ValueError("fastfetch template must contain exactly one // @DYNAMIC@ line")
    return text + "\n"


def lists_text(spec):
    rows = [f"key1|{spec.KEY1}", f"key2|{spec.KEY2}",
            "accent|%d;%d;%d" % spec.ACCENT, "value|%d;%d;%d" % spec.VALUE,
            f"cols|{TEXT_COLS}", f"rows|{TEXT_ROWS}"]
    for item in spec.LIST1:
        rows.append(f"l1|{item}")
    for item in spec.LIST2:
        rows.append(f"l2|{item}")
    return "\n".join(rows) + "\n"


ALPHA_CUT = 0.2  # sub-pixels below this opacity show the terminal background


def text_logo(logo_rgba, pal):
    """Half-block logo (▀ ▄, truecolor). Each cell covers two sub-pixels stacked vertically.

    Transparent sub-pixels use the default background (\\e[49m), so the logo blends into the
    translucent Terminal.app window. Colours are blended onto the theme background.
    """
    cols, rows = TEXT_COLS, TEXT_ROWS
    base = Image.new("RGBA", logo_rgba.size, pal["bg"] + (255,))
    flat = Image.alpha_composite(base, logo_rgba).convert("RGB").resize((cols, rows * 2), Image.LANCZOS)
    alpha = logo_rgba.getchannel("A").resize((cols, rows * 2), Image.LANCZOS)

    def on(c, r):
        return alpha.getpixel((c, r)) / 255 >= ALPHA_CUT

    out = []
    for r in range(rows):
        cells = []
        for c in range(cols):
            top_on, bottom_on = on(c, 2 * r), on(c, 2 * r + 1)
            top, bottom = flat.getpixel((c, 2 * r)), flat.getpixel((c, 2 * r + 1))
            if top_on and bottom_on:
                cells.append("\u001b[38;2;%d;%d;%dm\u001b[48;2;%d;%d;%dm▀" % (*top, *bottom))
            elif top_on:
                cells.append("\u001b[49m\u001b[38;2;%d;%d;%dm▀" % top)
            elif bottom_on:
                cells.append("\u001b[49m\u001b[38;2;%d;%d;%dm▄" % bottom)
            else:
                cells.append("\u001b[49m ")
        out.append("".join(cells) + "\u001b[0m")
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- drawing helpers

def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def smooth(x):
    x = clamp(x)
    return x * x * (3 - 2 * x)


def ramp_down(a, a0, a1):
    """1 below a0, 0 above a1, smooth in between."""
    return 1.0 - smooth((a - a0) / (a1 - a0))


class Canvas:
    """Supersampled canvas. Coordinates are in units U, with (0, 0) at the centre and 1 unit = U pixels."""

    def __init__(self, size, scale=0.63):
        self.w, self.h = size
        self.W, self.H = self.w * SUPERSAMPLE, self.h * SUPERSAMPLE
        self.cx, self.cy = self.W / 2, self.H / 2
        # Aspect-aware scale: wide banners keep the emblem small, near-square canvases fill more.
        aspect = self.w / self.h
        k = scale + (0.95 - scale) * (1 - clamp((aspect - 1) / 1.5))
        self.U = min(self.w, self.h) * SUPERSAMPLE * k
        self.half_w = self.W / 2 / self.U
        self.half_h = self.H / 2 / self.U

    def P(self, u, v):
        return (self.cx + u * self.U, self.cy + v * self.U)

    def finish(self, img):
        return img.resize((self.w, self.h), Image.LANCZOS)


def paint(mask, rgb, alpha=1.0):
    """Solid colour through an L mask (no dark fringe)."""
    out = Image.new("RGBA", mask.size, tuple(rgb) + (255,))
    out.putalpha(mask if alpha >= 1.0 else mask.point(lambda v: int(v * alpha)))
    return out


def with_alpha(rgb_img, mask):
    out = rgb_img.convert("RGBA")
    out.putalpha(mask)
    return out


def scale_alpha(img, factor):
    if factor >= 1.0:
        return img
    out = img.copy()
    out.putalpha(out.getchannel("A").point(lambda v: int(v * max(factor, 0.0))))
    return out


def scale_about_centre(img, s):
    """Zooms an RGBA image around its centre (s >= 1 crops, keeping the canvas size)."""
    if abs(s - 1.0) < 1e-6:
        return img
    w, h = img.size
    big = img.resize((round(w * s), round(h * s)), Image.LANCZOS)
    left, top = (big.width - w) // 2, (big.height - h) // 2
    return big.crop((left, top, left + w, top + h))


def interp_stops(v, stops):
    if v <= stops[0][0]:
        return stops[0][1]
    for (v0, c0), (v1, c1) in zip(stops, stops[1:]):
        if v <= v1:
            k = (v - v0) / (v1 - v0)
            return tuple(int(round(c0[i] + (c1[i] - c0[i]) * k)) for i in range(3))
    return stops[-1][1]


def vgradient(cv, stops, seed=None, amp=0.0):
    """Vertical gradient over the canvas (stops in units, ascending). Optional brushed-metal noise per row."""
    img = Image.new("RGB", (cv.W, cv.H))
    draw = ImageDraw.Draw(img)
    rng = random.Random(seed) if seed is not None else None
    for y in range(cv.H):
        v = (y - cv.cy) / cv.U
        col = interp_stops(v, stops)
        if rng is not None:
            f = 1.0 + amp * rng.gauss(0, 1)
            col = tuple(int(clamp(c * f, 0, 255)) for c in col)
        draw.line([(0, y), (cv.W, y)], fill=col)
    return img


def fade_mask(cv, fn):
    """L mask whose value at each column is fn(u), u in units."""
    img = Image.new("L", (cv.W, cv.H), 0)
    draw = ImageDraw.Draw(img)
    for x in range(cv.W):
        u = (x - cv.cx) / cv.U
        draw.line([(x, 0), (x, cv.H)], fill=int(255 * clamp(fn(u))))
    return img


def poly_mask(cv, pts_units):
    img = Image.new("L", (cv.W, cv.H), 0)
    ImageDraw.Draw(img).polygon([cv.P(u, v) for u, v in pts_units], fill=255)
    return img


def rrect_mask(cv, hw, hh, radius, dx=0.0, dy=0.0):
    img = Image.new("L", (cv.W, cv.H), 0)
    x0, y0 = cv.P(-hw + dx, -hh + dy)
    x1, y1 = cv.P(hw + dx, hh + dy)
    ImageDraw.Draw(img).rounded_rectangle([x0, y0, x1, y1], radius=radius * cv.U, fill=255)
    return img


def blur_glow(cv, mask, rgb, radius_units, alpha):
    """Soft glow: blur an L mask, then paint it in one colour."""
    blurred = mask.filter(ImageFilter.GaussianBlur(radius_units * cv.U))
    return paint(blurred, rgb, alpha)


def fit_logo(img):
    """Central 5:4 window of a drawing canvas. The height is kept, so nothing is stretched.

    A cell is about 1:2, so TEXT_COLS x TEXT_ROWS cells form a 5:4 box. The emblems are drawn in
    units of the height: cropping the 2.5:1 canvas keeps them round, a resize would not.
    """
    w, h = img.size
    width = h * 5 // 4
    if width > w:
        raise ValueError(f"drawing canvas {w}x{h} is narrower than 5:4")
    left = (w - width) // 2
    return img.crop((left, 0, left + width, h))


def write_text_file(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def validate_spec(spec, theme_id):
    required = ["ID", "TITLE", "SUBTITLE", "KEY1", "KEY2", "ACCENT", "VALUE", "LIST1", "LIST2", "draw_logo"]
    missing = [name for name in required if not hasattr(spec, name)]
    if missing:
        raise ValueError(f"spec {theme_id} misses: {', '.join(missing)}")
    if spec.ID != theme_id:
        raise ValueError(f"spec file {theme_id} declares ID={spec.ID!r}")
    for name in ("ACCENT", "VALUE"):
        rgb = getattr(spec, name)
        if len(rgb) != 3 or not all(isinstance(c, int) and 0 <= c <= 255 for c in rgb):
            raise ValueError(f"{name} must be (r, g, b) integers")
    for name in ("LIST1", "LIST2"):
        items = getattr(spec, name)
        if not items:
            raise ValueError(f"{name} is empty")
        prefix = "l1|" if name == "LIST1" else "l2|"
        for item in items:
            if "|" in item or "\n" in item or not item.strip():
                raise ValueError(f"{name} item not allowed: {item!r}")
            line = prefix + item
            if len(line) >= 76 or any(ord(ch) < 32 or ord(ch) == 127 for ch in line):
                raise ValueError(f"{name} line must be under 76 printable characters: {item!r}")
        if len(set(items)) != len(items):
            raise ValueError(f"{name} has duplicate items")
    if "|" in spec.KEY1 or "|" in spec.KEY2:
        raise ValueError("KEY1 and KEY2 must not contain '|'")
    for name in ("TITLE", "SUBTITLE", "FOOTER"):
        text = getattr(spec, name, "") or ""
        if "{" in text or "}" in text:
            raise ValueError(f"{name} must not contain braces (fastfetch placeholders)")
    unknown = sorted(set(getattr(spec, "FETCH", None) or {}) - set(FETCH_ORDER))
    if unknown:
        raise ValueError(f"FETCH has unknown keys: {', '.join(unknown)}")

#!/usr/bin/env python3
"""Generates the terminal bundle of a theme into src/themes/<id>/terminal/.

Usage:
    python3 scripts/themes/terminal/gen.py <id>|all [--no-profile]

<id> is the file name of a spec in specs/ (for example naruto). `all` runs every spec.
--no-profile skips Terminal.terminal, which needs macOS and swift (profile.swift).
"""
import argparse
import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import common as C  # noqa: E402

FRAME_COUNT = 16


def spec_ids():
    """Theme ids of the specs. File names use '_' where the theme id uses '-' (jujutsu_kaisen.py)."""
    return sorted(p.stem.replace("_", "-") for p in (HERE / "specs").glob("*.py") if not p.stem.startswith("_"))


def load_spec(theme_id):
    path = HERE / "specs" / f"{theme_id.replace('-', '_')}.py"
    if not path.is_file():
        raise FileNotFoundError(f"no spec for {theme_id!r}: {path}")
    module_spec = importlib.util.spec_from_file_location(f"terminal_spec_{theme_id}", path)
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    C.validate_spec(module, theme_id)
    return module


def write_frames(spec, out_dir):
    """frame_01..frame_NN for t in [0, 1]; the last frame is the final logo (t = 1).

    Frames are cropped to the 5:4 output size (C.OUT_SIZE) from the 2.5:1 drawing canvas.
    """
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for old in frames_dir.glob("frame_*.png"):
        old.unlink()
    last = None
    for i in range(FRAME_COUNT):
        t = i / (FRAME_COUNT - 1)
        img = C.fit_logo(spec.draw_logo(t, size=C.LOGO_SIZE))
        if img.size != C.OUT_SIZE:
            raise ValueError(f"{spec.ID}: logo is {img.size}, expected {C.OUT_SIZE}")
        img.save(frames_dir / f"frame_{i + 1:02d}.png", optimize=True)
        last = img
    last.save(out_dir / "logo.png", optimize=True)
    return last


def run_profile(theme_id, out_file):
    swift = shutil.which("swift")
    if not swift:
        raise RuntimeError("swift not found: rerun with --no-profile or install the Xcode command line tools")
    script = HERE / "profile.swift"
    result = subprocess.run([swift, str(script), theme_id, str(out_file)],
                            capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"profile.swift failed:\n{result.stderr.strip()}")
    if result.stdout.strip():
        print(result.stdout.strip())


def generate(theme_id, profile=True):
    spec = load_spec(theme_id)
    theme = C.load_theme(theme_id)
    pal = C.build_palette(theme, spec)
    out_dir = C.THEMES / theme_id / "terminal"
    out_dir.mkdir(parents=True, exist_ok=True)

    C.write_text_file(out_dir / "ghostty.theme", C.ghostty_text(spec, theme, pal))
    logo = write_frames(spec, out_dir)
    text_source = C.fit_logo(spec.draw_logo(1.0, size=C.LOGO_SIZE))   # same composition as logo.png
    C.write_text_file(out_dir / "logo.txt", C.text_logo(text_source, pal))
    C.write_text_file(out_dir / "fastfetch.jsonc", C.fastfetch_jsonc(spec, pal, text_logo=False))
    C.write_text_file(out_dir / "fastfetch-text.jsonc", C.fastfetch_jsonc(spec, pal, text_logo=True))
    C.write_text_file(out_dir / "lists.txt", C.lists_text(spec))
    if profile:
        run_profile(theme_id, out_dir / "Terminal.terminal")

    print(f"{theme_id}: written to {out_dir}")
    print(f"  logo {logo.size[0]}x{logo.size[1]}, {FRAME_COUNT} frames, text logo {C.TEXT_COLS}x{C.TEXT_ROWS}")
    for note in pal["notes"]:
        print(f"  contrast adjusted: {note}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("theme", help="theme id, or 'all'")
    parser.add_argument("--no-profile", action="store_true", help="skip Terminal.terminal (no swift needed)")
    args = parser.parse_args(argv)
    targets = spec_ids() if args.theme == "all" else [args.theme]
    if not targets:
        print("no spec found in specs/", file=sys.stderr)
        return 1
    status = 0
    for theme_id in targets:
        try:
            generate(theme_id, profile=not args.no_profile)
        except (OSError, ValueError, RuntimeError) as err:
            print(f"{theme_id}: error: {err}", file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())

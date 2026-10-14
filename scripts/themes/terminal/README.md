# Terminal bundle generator

Builds the terminal part of a theme into `src/themes/<id>/terminal/`: Ghostty theme, Terminal.app
profile, two fastfetch configs, logo (PNG, animation frames and half-block text) and the launcher lists.

## Regenerate

```sh
python3 scripts/themes/terminal/gen.py naruto               # one theme
python3 scripts/themes/terminal/gen.py all                  # every spec in specs/
python3 scripts/themes/terminal/gen.py naruto --no-profile  # skip Terminal.terminal (no macOS/swift)
```

Needs Python 3 and Pillow (10 or later). The profile step runs `profile.swift` (macOS, swift) on
`ghostty.theme`. Colours come from `src/themes/<id>/theme.json` (`palette`) and from the spec: edit
those, then rerun. Two runs on the same machine give byte-identical files, `Terminal.terminal` included.
The `Font` entry of `Terminal.terminal` depends on the fonts installed on the machine: `DOJO_FONT`
if set, else JetBrainsMono-Regular, else Menlo-Regular.

## Outputs

| File | Content |
| --- | --- |
| `ghostty.theme` | 16-colour palette, background, foreground, cursor and selection colours. No `background-image`. |
| `Terminal.terminal` | Terminal.app profile, written by `profile.swift` from `ghostty.theme`. No background image. |
| `fastfetch.jsonc` | Config for Ghostty (kitty graphics). The launcher passes the logo with `--logo-type data`. |
| `fastfetch-text.jsonc` | Config for Terminal.app. No logo source (`"logo": {"type": "none"}`): the launcher passes `--logo <theme>/logo.txt --logo-type file`, or `--logo none` when `logo.txt` is missing. Run without these flags, it prints no logo. |
| `logo.png` | Final logo (frame 16), RGBA, 480 x 384 (5:4), transparent background. |
| `frames/frame_NN.png` | 16 animation frames, 480 x 384 (5:4), `frame_16` is `logo.png`. |
| `logo.txt` | Text logo for Terminal.app, 30 x 12 cells. It is the same 5:4 crop as `logo.png`, reduced to 30 x 24 sub-pixels (square, since a cell is about 1:2). Each cell holds two stacked sub-pixels, drawn with `▀` (top half) or `▄` (bottom half) in truecolor escapes. A sub-pixel below 20 % opacity uses the default terminal background (`ESC[49m`), so the logo blends into the translucent window. The other colours are blended onto the theme background. |
| `lists.txt` | Launcher data: `key1`, `key2`, `accent`, `value`, `cols`, `rows`, then `l1|` and `l2|` items. |

Both fastfetch files contain exactly one `// @DYNAMIC@` line. The launcher replaces it with two
custom modules (`{"type":"custom","format":...},`).

## Spec contract (`specs/<file>.py`)

The file name is the theme id with `_` instead of `-`: `jujutsu_kaisen.py` for `jujutsu-kaisen`.
`ID` must be the theme id, with `-`.

Required:

- `ID`: str, the theme id.
- `TITLE`: str. Header line of the fastfetch config, shown upper-cased in `ACCENT`.
- `SUBTITLE`: str. Second header line, shown as `── SUBTITLE ──` in ANSI 12.
- `KEY1`, `KEY2`: str. Labels of the two launcher lines (no `|`).
- `ACCENT`: `(r, g, b)` integers. Fastfetch keys, header and cursor colour.
- `VALUE`: `(r, g, b)` integers. Fastfetch values and launcher values.
- `LIST1`, `LIST2`: non-empty lists of str, one item per launcher line (`l1|` and `l2|`). An item
  has no `|`, no newline, no control character and is not blank. A line (prefix included) is under
  76 characters. An item appears only once in its list.
- `draw_logo(t, size=(960, 384)) -> PIL.Image` (RGBA). `t` in [0, 1], `t = 1` is the final logo.
  Draw proportionally to `size` (the default `LOGO_SIZE` is 2.5:1), use a transparent background,
  and keep the artwork inside the central 5:4 window of the canvas (the middle half of its width).

## Logo size

The logo box in kitty is `TEXT_COLS` x `TEXT_ROWS` = 30 x 12 cells. A cell is about 1:2, so the box is
5:4. `draw_logo()` draws on a 2.5:1 canvas (960 x 384), and `common.fit_logo()` crops its central
5:4 window: the output is 480 x 384 (`OUT_SIZE`). The crop keeps the height, so nothing is stretched
and the emblems stay round. `logo.png`, the frames and `logo.txt` all come from this same crop.
`gen.py` fails if a frame is not `OUT_SIZE`.

Optional:

- `ANSI`: dict `{index: "#rrggbb" | (r, g, b)}`, indexes 0 to 15. Overrides the derived colours. Each
  override replaces only its own index: the bright variant (index + 8) is not recomputed, so override
  both when needed. Without overrides: 0 is `bg` mixed 35 % toward `dim`, 7 is `muted`, 8 is `dim`,
  15 is `fg`; 1 to 6 take the nearest hue of `theme.json` (a generated hue when none is within 30
  degrees); 9 to 14 are the same colours mixed 25 % toward `fg`. Every colour 1 to 15 is then raised
  to a 4.5:1 contrast on the background. The foreground is raised toward white or black until it
  reaches 7:1.
- `FETCH`: dict of labels for the six fastfetch rows. Each key is optional. Unknown keys are an error.
  Defaults are the key names themselves: `user`, `host`, `os`, `cpu`, `memory`, `uptime`. Each row reads
  `✦ <label>`, padded to the longest label. The values are fastfetch's: user name, host name, OS name and
  version, CPU name with physical cores, memory, uptime.
- `FOOTER`: str. Last status line, shown in ANSI 10 (bright green). No line when absent. `TITLE`,
  `SUBTITLE` and `FOOTER` must not contain `{` or `}` (fastfetch placeholders).

`gen.py` prints every adjustment made for contrast.

## Layout

- `common.py`: palette derivation, outputs, spec validation, drawing helpers (`Canvas`, gradients,
  masks, glows).
- `gen.py`: CLI, loads specs with importlib, writes the outputs.
- `profile.swift`: builds the Terminal.app profile from `ghostty.theme`.
- `specs/naruto.py`: reference spec. Its artwork is original, drawn with Pillow.

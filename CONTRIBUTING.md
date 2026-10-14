# Contributing to claude-dojo

Thanks for considering a contribution. claude-dojo is a small project, so focused pull requests and clear bug reports are the most helpful things you can send.

By taking part in this project, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Security issues must be reported privately, as described in [SECURITY.md](SECURITY.md), never in public issues.

## Project scope

claude-dojo is **macOS only**. It is made of:

- bash scripts (`install.sh`, `uninstall.sh`),
- a Node.js runtime (Node.js 18 or newer),
- a SwiftUI app (`mac/*.swift`) that hosts the wallpaper and runs the setup assistant.

Please do not add Linux or Windows support as a side effect of another change. Open an issue first if you want to discuss a platform change.

## Repository layout

| Path | What it is |
| --- | --- |
| `src/` | The Node.js runtime. `install.sh` copies it to `~/.config/claude-dojo`. It contains the Claude Code hook, the status line, the collector, the local agent and the heavy-gate hook. |
| `src/wallpaper/` | The HTML page displayed as the wallpaper, with its images. |
| `mac/*.swift` | The native macOS app: wallpaper host, setup assistant and settings. |
| `install.sh` | Installs the runtime and connects it to Claude Code. |
| `uninstall.sh` | Removes what `install.sh` added. |
| `.github/` | The CI workflow, the issue forms and the pull request template. |

## Development setup

You need:

- macOS, with the Xcode Command Line Tools (for `swiftc`),
- Node.js 18 or newer (CI uses Node.js 20),
- [shellcheck](https://www.shellcheck.net/), for example with `brew install shellcheck`.

## Testing without touching your own setup

The installer writes into `$HOME`: `~/.claude/settings.json`, `~/.claude/dojo/` and `~/.config/claude-dojo/`. Never test it against your real home directory. Use a throwaway `HOME` instead:

```bash
TEST_HOME="$(mktemp -d)"
HOME="$TEST_HOME" ./install.sh --yes --no-launchd
# Inspect "$TEST_HOME", then clean up with the same HOME:
HOME="$TEST_HOME" ./uninstall.sh --yes --no-launchd --purge
```

`--no-launchd` skips registering the background job with launchd, so the test does not install a launchd job on your machine.

## Local checks

Run these before opening a pull request. CI runs the same checks on macOS.

```bash
bash -n install.sh uninstall.sh
shellcheck -S warning install.sh uninstall.sh
for f in src/*.js; do node --check "$f"; done
node --test test/
scripts/build-app.sh --no-dmg
```

Also run the install and uninstall test described above, in a temporary `HOME`.

## Adding the terminal part of a theme

The terminal part of a theme lives in `src/themes/<id>/terminal/`. A generator builds most of it from a spec, and the shaders are written by hand. The [terminal README](scripts/themes/terminal/README.md) has the full contract of a spec.

1. **Write the spec.** Create `scripts/themes/terminal/specs/<spec>.py`, where `<spec>` is the theme id with `_` instead of `-`, for example `stargate_sg1.py` for `stargate-sg1`. Start from `specs/naruto.py`. The spec sets `ID`, the header titles and labels, the accent and value colours, the two lists of universe lines and `draw_logo(t, size)`, which returns the logo as an RGBA image for `t` from 0 to 1, where `t = 1` is the final logo. The palette comes from `src/themes/<id>/theme.json`, so the theme must exist first.
2. **Generate the files.** Run `python3 scripts/themes/terminal/gen.py <id>` (Python 3 and Pillow 10 or later). It writes `ghostty.theme`, `Terminal.terminal`, the two fastfetch configs, `logo.png`, the frames, `logo.txt` and `lists.txt` into `src/themes/<id>/terminal/`. `Terminal.terminal` needs macOS and Swift; `--no-profile` skips it. Do not edit the generated files by hand. Change the spec or `theme.json`, then run the generator again.
3. **Write the shaders.** Put them in `src/themes/<id>/terminal/shaders/` as `.glsl` files, each defining `mainImage(out vec4 fragColor, in vec2 fragCoord)`. Dojo adds one `custom-shader` line per file, sorted by name. The Ghostty uniforms used by the shipped shaders are `iResolution`, `iTime`, `iChannel0` (the terminal content), `iCurrentCursor` and `iPreviousCursor` (`xy` is the top-left corner of the cursor, `zw` its width and height), `iTimeCursorChange`, `iFocus` and `iTimeFocus`. Look at `src/themes/stargate-sg1/terminal/shaders/` for examples. Keep each effect short (under one second) and faint, so the text stays readable.
4. **Check the shaders and the configuration.** Ghostty may add uniforms of its own, so run both checks. `glslangValidator` comes from `brew install glslang`.

   ```sh
   TMP="$(mktemp -d)"
   cat > "$TMP/prelude.glsl" <<'EOF'
   #version 330 core
   uniform sampler2D iChannel0;
   uniform vec3 iResolution;
   uniform float iTime;
   uniform float iTimeCursorChange;
   uniform float iTimeFocus;
   uniform int iFocus;
   uniform vec4 iCurrentCursor;
   uniform vec4 iPreviousCursor;
   out vec4 fragColor_out;
   EOF
   for f in src/themes/<id>/terminal/shaders/*.glsl; do
     { cat "$TMP/prelude.glsl" "$f"; echo 'void main() { mainImage(fragColor_out, gl_FragCoord.xy); }'; } > "$TMP/check.frag"
     glslangValidator -S frag "$TMP/check.frag"
   done
   {
     echo "theme = $PWD/src/themes/<id>/terminal/ghostty.theme"
     for f in "$PWD"/src/themes/<id>/terminal/shaders/*.glsl; do echo "custom-shader = $f"; done
   } > "$TMP/ghostty.conf"
   HOME="$TMP" ghostty +validate-config --config-file="$TMP/ghostty.conf"
   ```

   `glslangValidator` must print no error, and `ghostty +validate-config` must exit with 0. The temporary `HOME` keeps Ghostty from reading your own configuration. `ghostty` is `/Applications/Ghostty.app/Contents/MacOS/ghostty` if it is not on your `PATH`.
5. **Run the tests.** `node --test test/` checks that each theme's terminal folder is complete, with at least 8 frames and 3 shaders, that each shader defines `mainImage`, that `ghostty.theme` has 16 palette lines and no `background-image`, that the foreground contrast is at least 7:1, that the folder is under 6 MB, and that it contains no personal term or absolute path.

Before you open a pull request, check the following:

- The contrast adjustments printed by `gen.py` are acceptable. Open a new window with the header in Ghostty and in Terminal.app, and look at it.
- The logo is original artwork drawn with Pillow or by code. Do not use official artwork, screenshots or trademarks, as for the other themes.
- No personal term, user name or absolute path appears in the files. The CI scan checks this.
- The checks in step 4 pass.

## Rules

- **No personal data or secrets.** Never commit, paste or attach API keys, OAuth tokens, the contents of `~/.claude/.credentials.json`, Keychain output, calendar entries, Sentry or GitHub data, private project names, or screenshots showing any of them. Redact logs and screenshots before you share them in an issue or a pull request.
- **Optional panels degrade cleanly.** A panel that depends on an optional source (calendar, weather, Sentry, GitHub and so on) must render without errors or broken layout when that source is not configured or its data is unavailable.
- **Never touch the model and account settings.** Installer and runtime code must never change the `model`, `effort`, `plugins` or `permissions` keys of `settings.json`. Only the entries that claude-dojo owns may be added, updated or removed.
- **Installs are idempotent.** Running `install.sh` twice must not duplicate hook entries. `uninstall.sh --purge` must remove what the installer created.
- **Conventional Commits.** Write commit messages as `type(scope): summary`, for example `fix(installer): keep existing hook order`. Common types are `feat`, `fix`, `docs`, `refactor`, `test`, `ci` and `chore`.

## Pull request process

1. For anything bigger than a small fix, open an issue first so the approach can be agreed on.
2. Branch from `main` and keep each pull request focused on one change.
3. Run the local checks and test the installer with a temporary `HOME`.
4. For user-visible changes, add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
5. Fill in the checklist of the pull request template.
6. Make sure CI is green. A maintainer will review the change and may ask for modifications.

By contributing, you agree that your contributions are licensed under the same license as the project (see [LICENSE](LICENSE)).

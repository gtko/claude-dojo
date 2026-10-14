# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Themes: eight themes (Naruto, the default, Stargate SG-1, Demon Slayer, Frieren, One Piece, My Hero Academia, Jujutsu Kaisen and Mushoku Tensei), each with its palette, labels, training object and characters.
- Skin engine: a configurable engine that reads each theme from `src/themes/<id>/` (`theme.json`, `background.jpg`, `thumbnail.jpg`). A new theme needs no change to the page code.
- Backgrounds: original illustrations drawn by code, rendered from one `scripts/themes/<id>/scene.html` per theme by `scripts/themes/render.cjs`. The Naruto background is unchanged.
- Configuration: `theme` and `background` keys in `config.json`. A custom background (JPG, JPEG, PNG, HEIC or WebP) is copied to `~/.config/claude-dojo/backgrounds/`.
- Setup commands: `themes`, `set-theme <id>` and `set-background <path|default>` in `src/setup.js`.
- Menu bar: a Theme menu to choose a theme or a custom background.
- Setup assistant: a Theme step.
- Terminal themes: each theme can style Ghostty and Terminal.app (a palette, four cursor shaders, a Terminal profile) and show a welcome header with the theme's logo and two lines from its universe. Each part is optional and reversible, from the Theme step or with `terminal status|apply|remove` in `src/setup.js`. `DOJO_WELCOME=off` and `DOJO_ANIM=0` turn the header off or keep the still logo.
- Terminal generator: `scripts/themes/terminal/gen.py` builds a theme's terminal files from a spec in `scripts/themes/terminal/specs/`.

## [0.1.0] - 2026-10-14

Initial public release.

### Added

- Wallpaper host: a native macOS app (`mac/*.swift`) that shows the dojo page as the desktop wallpaper.
- Agent: a local server bound to `127.0.0.1:7777` that serves the page and its live stats.
- Collector: gathers the data behind the optional panels (AI usage, GitHub, local projects, Sentry, weather, calendar) into a cache file read by the agent.
- Hooks: a Claude Code hook that records the state of each session for the wallpaper.
- Status line: a Claude Code status line that exposes model, effort, context and quota information to the wallpaper.
- Heavy-gate: a `PreToolUse` hook that limits how many heavy suites (test runners, `tsc`, `eslint`, `next build`) run in parallel.
- Installer and uninstaller: `install.sh` and `uninstall.sh`, with `--yes`, `--no-launchd` and `--purge` options.
- Setup app: `DojoWallpaper.app` is now the installer and settings screen. A 9-step setup assistant (dependencies with a verified Node.js download, weather, GitHub, projects, calendars, Claude Code with a preview of the `settings.json` changes, autostart), a Settings… menu and an Uninstall… action.
- Single setup logic in `src/setup.js`, shared by the app and `install.sh`, covered by `node --test`.
- Universal DMG (Apple Silicon and Intel, macOS 12+) published with a `.sha256` file by the release workflow on `v*` tags.
- CI: a GitHub Actions workflow running shell and Node.js syntax checks, shellcheck, the Swift build, and an install and uninstall smoke test in a temporary `HOME`.

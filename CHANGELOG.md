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
- Wallpaper gallery: real Wallhaven wallpapers curated for each theme (the `wallpapers` field of `theme.json`, which stores only the Wallhaven ids). SFW only: searches request safe-for-work content and an image that is not SFW is refused. The window **Fonds d'écran…** has three tabs: Sélection, Plus (more Wallhaven results, page by page) and Téléchargés. Each image links to its Wallhaven page with **Ouvrir la source**.
- Automatic download: the pack of the active theme is downloaded in the background at launch and when the theme changes, the default wallpaper first, with one request per second. Only missing images are downloaded. Offline, the download stops and what is already downloaded is kept.
- Menu bar: a **Fonds** submenu lists the wallpapers of the active theme and shows the download progress, with **Fond suivant** (⌘→) and **Fonds d'écran…**.
- Rotation: **Changer de fond automatiquement** in the Theme step of the assistant (never, every 30 minutes, every hour or every day). The setting is stored in the app's preferences.
- Sources: each downloaded wallpaper is recorded with its Wallhaven page and resolution in `backgrounds/index.json`.
- Setup commands: `wallpapers list`, `search`, `download`, `sync`, `progress`, `use`, `next` and `local` in `src/setup.js`.
- Setup assistant: the Theme step shows the wallpaper strip of the active theme, with the download progress.

### Changed

- Backgrounds are remembered per theme in `backgroundByTheme` (`config.json`). Switching theme brings back the background chosen for that theme.
- Each theme has a default wallpaper (`wallpapers.default` in `theme.json`). It is applied once downloaded, when that theme is active, no background has been chosen for it, and the current background is not a picture the user added.
- `/custom-bg` also serves a background stored in one subfolder per theme (`backgrounds/<theme>/`). Symbolic links are refused.

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

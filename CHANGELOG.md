# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-10-19

### Added

- Windows: a desktop wallpaper, `DojoWallpaper.exe` (WinForms and WebView2), that shows the same page as on macOS, fed by the same local agent. It is installed from the command line with `install.ps1` and removed with `uninstall.ps1`, without administrator rights. Autostart uses the `HKCU` Run key.
- Windows agent (`src/agent-win.js`): processes, network, disks, local servers, CPU and memory, battery, and temperatures from the optional LibreHardwareMonitor web server on port 8085.
- Windows: the current track comes from the Windows media session (`src/win-media.js` and `src/windows/media.ps1`).
- Windows: the wallpaper pauses when a window covers the screen (full screen or maximized), on battery and in battery saver mode. The tray menu has a manual pause.
- Windows: the window zone is macOS only.
- Windows: the interface (theme and background, wallpaper gallery and setup assistant windows, in `windows\ui`) is installed with the runtime, without its `tests` folder, and removed by `uninstall.ps1`.
- Windows: the setup assistant opens at the end of a first installation. `install.ps1 -NoWizard` or `DOJO_NO_WIZARD=1` turn it off, and it never opens in CI or in a non-interactive session.
- Windows: terminal themes, a Windows Terminal profile and a PowerShell welcome header (`setup.js terminal apply` with `windowsTerminal` and `welcome`). `uninstall.ps1` removes them.
- heavy-gate: on Windows, the hook also checks `PowerShell` commands (matcher `Bash|PowerShell`).
- Release: each `v*` tag publishes `DojoWallpaper-windows-x64.zip` with its `.sha256` file, next to the DMG.
- CI: a Windows job runs the Node.js tests, builds and tests `DojoWallpaper.exe`, and installs and uninstalls in a temporary profile. It also checks that `windows\ui` is installed without `tests`, and runs `windows/ui/tests/` when that folder exists.
- Usage card: per-model share of tokens read (input + cache) and written (output) over 7 days, next to the cost share, so cheap models show their real workload.
- Usage card: Claude cost per 1,000 lines of code over 7 days, with the trend against the previous 7 days. Lines are counted from Write, Edit, MultiEdit and NotebookEdit tool calls in the transcripts.

### Changed

- The portable core of the agent is in `src/agent-core.js`. The macOS and Windows samplers are in `src/agent-mac.js` and `src/agent-win.js`.
- `setup.js` installs and uninstalls the Windows parts (autostart values, launcher, Claude Code settings and `DojoWallpaper.exe`), and skips the macOS-only terminal parts on Windows.
- The unit tests run on Windows as well as macOS.

### Fixed

- Wallpaper: Claude quotas now come from the freshest source. A failing usage API (expired token, timeout) no longer pins stale values for days over the up-to-date statusline quotas.

## [0.2.1] - 2026-10-15

### Fixed

- Updating the app now updates the installed runtime: on launch, the app copies its newer runtime to `~/.config/claude-dojo` and restarts the agent.

## [0.2.0] - 2026-10-15

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
- Window zone: an optional setting, off by default, that keeps the windows of other apps out of the wallpaper panels (left and right columns, and optionally the top band), with a margin. It uses the Accessibility API, so it needs the Accessibility permission and does nothing without it. Full screen apps, non-resizable windows, panels, dialogs, sheets, minimized windows, the Finder desktop, Dojo itself and an exclusion list are left alone. Stage Manager's left strip is reserved when it is on.
- Window zone: a `windowZone` block in `config.json` (`enabled`, `margin`, `reserveTop`, `exclude`), validated by `write-config`, and a `window-zone` command in `src/setup.js`.
- Window zone: a **Zone de travail** menu (checkbox, permission status, **Agrandir dans la zone**, **Moitié gauche**, **Moitié droite**), the global shortcuts ⌃⌥↩, ⌃⌥← and ⌃⌥→, and a step in the setup assistant.
- Wallpaper page: `window.dojoReservedRects()` returns the rectangles of the panels, for the window zone.
- Tests: the window zone geometry (zone computation, coordinate conversion, multiple and Retina screens, fitting a window) is plain Swift, tested by `scripts/test-swift.sh`, which CI runs.
- Terminal themes: each theme can style Ghostty and Terminal.app (a palette, four cursor shaders, a Terminal profile) and show a welcome header with the theme's logo and two lines from its universe. Each part is optional and reversible, from the Theme step or with `terminal status|apply|remove` in `src/setup.js`. `DOJO_WELCOME=off` and `DOJO_ANIM=0` turn the header off or keep the still logo.
- Terminal generator: `scripts/themes/terminal/gen.py` builds a theme's terminal files from a spec in `scripts/themes/terminal/specs/`.

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

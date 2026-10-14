# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

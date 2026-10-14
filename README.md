# claude-dojo

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![Claude Code](https://img.shields.io/badge/Claude%20Code-supported-D97757)
![Node >= 18](https://img.shields.io/badge/node-%3E%3D%2018-brightgreen)
![Swift](https://img.shields.io/badge/Swift-native-F05138?logo=swift&logoColor=white)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
![GitHub stars](https://img.shields.io/github/stars/gtko/claude-dojo?style=flat)

![claude-dojo overview](docs/screenshots/overview.webp)

An animated macOS desktop wallpaper that shows every active Claude Code session as a ninja, surrounded by live panels for your system, GitHub, local projects, AI usage and quotas.

## Features

- **One ninja per Claude Code session**, with its state (working, waiting for your approval, idle). A click brings the matching terminal window forward.
- **System panels**: CPU, GPU, temperatures and power (with `macmon`), memory with the top processes, disks, network, battery, and local servers listening on your machine.
- **AI usage**: estimated cost in euros for today and the last 7 days, a 14-day chart, a breakdown by model and effort level, and your Claude and Codex quotas. Claude Code and Codex sessions are both read.
- **Dev panel**: open GitHub pull requests and their CI status, your contribution streak, and local Git repositories with uncommitted changes or unpushed commits.
- **Optional panels**: unresolved Sentry issues from the last 24 hours, a 3-day weather forecast, upcoming calendar events from ICS feeds, and the track currently playing.
- **Menu bar icon** to toggle interactive mode, reload the page, mirror the layout, change the size, or quit.
- **Private by default**: the local agent listens on `127.0.0.1` only and rejects requests from other origins (protection against CSRF and DNS rebinding), so a web page open in your browser cannot read your data or trigger actions. Every panel that needs the network is optional.

**Language and artwork**: the wallpaper labels are in French for now. Pull requests that add translations (i18n) are welcome. The background image is third-party fan art, included as a demo. To use your own, replace `~/.config/claude-dojo/wallpaper/background.jpg`, then choose Reload in the menu bar icon. Re-running `install.sh` copies the bundled image again, so keep a copy of your own image.

## Gallery

<p align="center">
  <img src="docs/screenshots/dojo.webp" alt="The ninja view: one ninja per Claude Code session, with its state and project" width="720">
</p>

*The ninja view: one ninja per active session, showing its state (working, waiting, idle) and its project.*

<p align="center">
  <img src="docs/screenshots/system.webp" alt="The system panels: processor, battery and memory" width="360">
</p>

*The system panels: processor and GPU, battery, memory and top memory consumers.*

<p align="center">
  <img src="docs/screenshots/insights.webp" alt="The AI usage panel: cost today and over 7 days, quotas, daily chart, and breakdown by model and effort" width="560">
</p>

*The AI usage panel: estimated cost, Claude and Codex quotas, a 14-day chart, and a breakdown by model and effort level.*

## Requirements

- macOS 12+ (Monterey or later). The app is compiled on your Mac. The installer tries the targets 11.0, 12.0, 13.0 and 14.0 in that order and keeps the first one that compiles. In practice this is 12.0, because the app uses `safeAreaInsets`, which macOS 11 does not provide.
- Node.js 18 or later.
- Xcode Command Line Tools: `xcode-select --install`. They provide `swiftc`, which builds the wallpaper app.

Optional tools:

| Tool | Purpose |
|---|---|
| Homebrew | Installs the optional tools below |
| `macmon` | Hardware sensors (temperatures, power) without sudo |
| `media-control` | Currently playing track |
| `gh` (GitHub CLI, logged in with `gh auth login`) | GitHub panel: pull requests, CI, contributions |
| Claude Code | Sessions and subscription quotas |

A missing optional tool simply hides its panel. No error is shown.

## Quick start

```sh
git clone https://github.com/gtko/claude-dojo.git && cd claude-dojo
./install.sh
```

The installer asks a few questions (see below). Once it has finished, the Dojo runs from `~/.config/claude-dojo`, so the clone is not needed to run it. Keep the clone if you want to uninstall later, since `./uninstall.sh` is run from the repository.

## What the installer does and asks

The installer:

1. copies the files from `src/` to `~/.config/claude-dojo` and runs `npm install` there (it installs `node-ical` for the calendar);
2. compiles `~/Applications/DojoWallpaper.app` from `mac/DojoWallpaper.swift` and signs it ad hoc;
3. writes two LaunchAgents, `io.github.claude-dojo.agent` (local agent and collector) and `io.github.claude-dojo.wallpaper` (wallpaper app), and loads them so they start at login;
4. merges the hooks, the `statusLine` and, if heavy-gate is enabled, the `VITEST_MAX_WORKERS` variable into `~/.claude/settings.json`, keeping everything else. Before any change, the file is copied to `settings.json.bak-<timestamp>`. Keys such as `model`, `effort`, `plugins` and `permissions` are never touched.

The hooks are registered for six events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Notification`, `Stop` and `SessionEnd`.

Without `--yes`, the installer asks:

- the city for the weather (Open-Meteo finds the coordinates and time zone);
- the GitHub owners whose personal repositories you want to follow;
- the project folders to scan for Git repositories;
- the ICS calendar URLs (optional);
- whether to enable heavy-gate (`y` / `N`);
- what to do if a `statusLine` already exists in `~/.claude/settings.json`;
- whether to install `macmon` and `media-control` with Homebrew, if they are missing;
- whether to start the Xcode Command Line Tools installation, if `swiftc` is missing.

If `~/.config/claude-dojo/config.json` already exists, it is kept as is and the configuration questions are skipped.

### Options

- `--yes`, `-y`: non-interactive mode. Answers come from the environment variables below, or from neutral defaults.
- `--no-launchd`: writes the LaunchAgents without loading them and without unloading anything in launchd. The Dojo then does not start automatically.
- `--help`: shows the help.

### Environment variables

| Variable | Purpose | Example |
|---|---|---|
| `DOJO_CITY` | City for the weather. Empty means no weather panel | `Paris` |
| `DOJO_LAT`, `DOJO_LON` | Coordinates, used when geocoding fails or to force them | `48.8566`, `2.3522` |
| `DOJO_TZ` | Weather time zone (IANA). Default: the system time zone | `Europe/Paris` |
| `DOJO_GITHUB_OWNERS` | Comma-separated GitHub owners. Empty disables the GitHub panel | `octocat` |
| `DOJO_PROJECT_ROOTS` | Comma-separated project folders. Default: `~/Projects` if it exists | `~/Projects,~/work` |
| `DOJO_CALENDARS` | Comma-separated ICS or webcal URLs | `https://calendar.example.com/feed.ics` |
| `DOJO_HEAVY_GATE` | `y` or `n` to enable or disable heavy-gate. Unset with `--yes` means no change | `y` |
| `DOJO_STATUSLINE` | `y` replaces an existing status line, `n` keeps it, `ask` asks (keeps it in non-interactive mode) | `n` |
| `DOJO_BREW` | `y` or `n` to install `macmon` and `media-control` with Homebrew | `y` |

## macOS permissions

- **Automation**: the first time you click a ninja, macOS asks for permission to control the terminal app through AppleScript (`osascript`), so the Dojo can bring the right window forward. The request may name `node` instead of DojoWallpaper, because the agent is a Node.js process that runs `osascript`. If you declined, enable it in System Settings > Privacy & Security > Automation, where the entry may also appear under `node`.
- **Keychain**: if `~/.claude/.credentials.json` does not exist, the collector reads your Claude Code login from the macOS Keychain item `Claude Code-credentials`, read-only. The first read can show a macOS prompt. Click **Always Allow** (« Toujours autoriser » in the French interface) to stop it from coming back, or decline it. If you decline, the Claude quota figures fall back to the status line data, and the quota section stays hidden when there is none.
- **Gatekeeper**: the app is not notarized and has no developer certificate. It is compiled on your machine and ad hoc signed. Because it is not downloaded, Gatekeeper normally does not block it.
- **Local network**: the agent listens on `127.0.0.1` only. Other machines on your network cannot reach it.
- **Disk access**: no Full Disk Access is required. If your project folders are in protected locations such as Documents or Desktop, macOS may ask once for access to that folder.

## Configuration

The file is `~/.config/claude-dojo/config.json`. Every block is optional. Without a block, its panel stays hidden.

| Key | Purpose |
|---|---|
| `weather.name` | City label shown in the weather panel |
| `weather.lat`, `weather.lon` | City coordinates |
| `weather.timezone` | IANA time zone, for example `Europe/Paris` |
| `calendars` | List of ICS URLs (`https://` or `webcal://`) |
| `github.owners` | GitHub owners whose repositories you follow (pull requests, CI, contributions) |
| `projects.roots` | Folders to scan for Git repositories (`~` is accepted). Default: the common folders `Projects`, `Projets`, `Developer`, `Code`, `dev`, `src` and `repos` in your home folder, when they exist |
| `projects.onlyOwners` | `true` shows only repositories owned by `github.owners` |
| `sentry.token`, `sentry.org` | Sentry token and organization slug. Shows unresolved issues from the last 24 hours |

Example (placeholder values, replace them and delete the blocks you do not use):

```json
{
  "weather": { "name": "Paris", "lat": 48.8566, "lon": 2.3522, "timezone": "Europe/Paris" },
  "calendars": ["https://calendar.example.com/feed.ics"],
  "github": { "owners": ["octocat"] },
  "projects": { "roots": ["~/Projects"], "onlyOwners": true },
  "sentry": { "token": "REPLACE_ME", "org": "my-organization" }
}
```

- The file is reloaded automatically. When it changes, the weather, calendar, Sentry and projects panels refresh without restarting the agent.
- The installer never overwrites this file. It creates it with mode `0600` on first install.

**Privacy**: never publish this file, in a Git repository or anywhere else. It can contain private calendar URLs, which give access to your agenda, and tokens (Sentry).

## Data and network

### Local data

- **Claude Code sessions**: the hooks write the state of each session to `~/.claude/dojo/`. The status line writes the model, effort and quota data to `~/.claude/dojo/status/`.
- **Transcripts**: the collector reads `~/.claude/projects` and `~/.codex/sessions` to compute usage and costs. The results are cached in `~/.config/claude-dojo/cache/`.
- **Claude quota**: read-only, from `~/.claude/.credentials.json` or, if that file does not exist, from the macOS Keychain item `Claude Code-credentials`. Nothing is copied or written elsewhere.
- **Costs**: estimated locally from the public API prices in the collector. They are converted to euros with the exchange rate below.

### Outgoing network requests

These are the only network destinations used by the collector:

| Destination | Frequency | What is sent |
|---|---|---|
| `api.open-meteo.com` (and `geocoding-api.open-meteo.com` during installation) | Weather every 15 min | City coordinates. The city name during installation |
| Configured ICS URLs | Calendar every 10 min | One request per URL. The URL often contains a secret |
| GitHub, through `gh` | Pull requests, CI and contributions every 5 min | Authenticated requests with your `gh` account |
| `api.anthropic.com` | Quota every 5 min | Your Claude Code OAuth token, to read subscription quotas. This endpoint is undocumented: if it fails, the panel falls back to the quota data from the status line |
| `api.frankfurter.app` | Every 6 hours | A USD to EUR exchange rate request. No personal data |
| `sentry.io` (only if configured) | Every 5 min | Your Sentry token |

Links clicked in the wallpaper open in your default browser.

## heavy-gate

heavy-gate is an optional `PreToolUse` hook (matcher `Bash`). It refuses to start a heavy command when the machine is already busy. The commands it checks are `test`, `check`, `lint`, `typecheck` and `build` scripts run through `npm`, `pnpm` or `yarn`; `vitest`, `playwright`, `tsc` and `eslint`, called directly or through `npx`, `bunx` or `pnpm exec`; `turbo run`; and `next build`. The gate counts the running `vitest`, `turbo run`, `tsc`, `eslint` and `next build` processes, and the total number of `node` processes. The refusal explains the reason, and Claude can retry later or run only the test files that changed.

Default limits:

- heavy processes running at once: `max(2, floor(cores / 3))`;
- `node` processes: 2 × RAM in GB, with a minimum of 2.

Settings:

- override the limits with `HEAVY_GATE_MAX` (heavy processes) and `HEAVY_GATE_MAX_NODE` (`node` processes);
- bypass the gate for one command with `HEAVY_GATE=off` in the command, or set `HEAVY_GATE=off` in the environment;
- fail-open: if the hook errors, the command goes through. The hook never stops Claude Code itself;
- the gate never kills a process. It only reads the process list with `ps`.

When heavy-gate is enabled, the installer also sets `VITEST_MAX_WORKERS=2` in the `env` block of `~/.claude/settings.json`, unless the variable is already set. This limits the number of vitest workers.

## Uninstall

From the clone:

```sh
./uninstall.sh
```

Options:

- `--yes`, `-y`: no questions. Keeps `config.json`, the cache and `~/.claude/dojo`;
- `--no-launchd`: does not touch launchd (the plists stay in place);
- `--purge`: also deletes `~/.config/claude-dojo` (configuration and cache) without asking;
- `--help`: shows the help.

The uninstaller stops and removes the LaunchAgents, deletes `~/Applications/DojoWallpaper.app`, and removes the Dojo entries from `~/.claude/settings.json` (hooks, status line, heavy-gate, and `VITEST_MAX_WORKERS` when it was set by the installer). Before changing `settings.json`, it saves a backup as `settings.json.bak-<timestamp>`. It asks separately before deleting the session state in `~/.claude/dojo`. Nothing else is changed.

## Troubleshooting

**Logs** (all in `~/.config/claude-dojo/cache/`):

- `agent.log`: local agent;
- `wallpaper.log`: wallpaper app;
- `collector.log`: collector (weather, GitHub, quota, and so on).

**LaunchAgent status**:

```sh
launchctl print gui/$(id -u)/io.github.claude-dojo.agent
```

**Restart the agent or the wallpaper**:

```sh
launchctl kickstart -k gui/$(id -u)/io.github.claude-dojo.agent
launchctl kickstart -k gui/$(id -u)/io.github.claude-dojo.wallpaper
```

**Check the local server**: `http://localhost:7777/` shows the page, and `http://localhost:7777/stats` returns the data as JSON. If neither responds, read `agent.log`.

**Common symptoms**:

- **A panel is missing**: its dependency or configuration key is missing (`gh` not logged in, `macmon` or `media-control` not installed, or no matching block in `config.json`).
- **The quota section is missing**: the Keychain item could not be read and no status line data is available yet (see macOS permissions).
- **Clicking a ninja does not bring the window forward**: the Automation permission was not granted (see macOS permissions). Window-precise focus works with Terminal, iTerm2 and Ghostty (the Ghostty AppleScript path needs Ghostty 1.3 or later). For other apps, the Dojo only brings the app forward. Codex Desktop sessions open directly in Codex.
- **The page does not update**: use Reload in the menu bar icon, or restart the agent with the command above.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and follow the [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). To report a vulnerability, see [SECURITY.md](SECURITY.md). Do not use public issues for security reports.

## License

claude-dojo is released under the MIT License. See [LICENSE](LICENSE).

## Français

claude-dojo est un fond d'écran animé pour macOS : chaque session Claude Code active apparaît sous forme de ninja, entouré de panneaux système, GitHub, quotas et coûts d'usage IA.

Installation : `git clone https://github.com/gtko/claude-dojo.git && cd claude-dojo && ./install.sh` (Node 18 ou plus et Xcode Command Line Tools requis).

Les sections en anglais détaillent tout : [Requirements](#requirements), [What the installer does and asks](#what-the-installer-does-and-asks), [Configuration](#configuration), [Uninstall](#uninstall) et [Troubleshooting](#troubleshooting).

Ne publiez jamais `~/.config/claude-dojo/config.json` : il peut contenir des URL de calendrier privées et des tokens.

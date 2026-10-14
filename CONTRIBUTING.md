# Contributing to claude-dojo

Thanks for considering a contribution. claude-dojo is a small project, so focused pull requests and clear bug reports are the most helpful things you can send.

By taking part in this project, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Security issues must be reported privately, as described in [SECURITY.md](SECURITY.md), never in public issues.

## Project scope

claude-dojo is **macOS only**. It is made of:

- bash scripts (`install.sh`, `uninstall.sh`),
- a Node.js runtime (Node.js 18 or newer),
- a small Swift program (`mac/DojoWallpaper.swift`) that hosts the wallpaper.

Please do not add Linux or Windows support as a side effect of another change. Open an issue first if you want to discuss a platform change.

## Repository layout

| Path | What it is |
| --- | --- |
| `src/` | The Node.js runtime. `install.sh` copies it to `~/.config/claude-dojo`. It contains the Claude Code hook, the status line, the collector, the local agent and the heavy-gate hook. |
| `src/wallpaper/` | The HTML page displayed as the wallpaper, with its images. |
| `mac/DojoWallpaper.swift` | The native macOS host that shows the page as the desktop wallpaper. |
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
shellcheck install.sh uninstall.sh
for f in src/*.js; do node --check "$f"; done
swiftc -O mac/DojoWallpaper.swift -o "$(mktemp -d)/DojoWallpaper" -framework Cocoa -framework WebKit
```

Also run the install and uninstall test described above, in a temporary `HOME`.

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

## What does this change do?

<!-- A short description of the change and why it is needed. -->

## Checklist

- [ ] `bash -n install.sh uninstall.sh`, `shellcheck install.sh uninstall.sh` and `node --check` on `src/*.js` pass locally
- [ ] Install and uninstall were tested with a temporary `HOME` (see CONTRIBUTING.md), not my real setup
- [ ] No personal data, secrets, tokens, or unredacted logs and screenshots in the diff, the commits, or the attachments
- [ ] Optional panels still degrade cleanly when their source is missing
- [ ] `model`, `effort`, `plugins` and `permissions` in `settings.json` are not touched
- [ ] `CHANGELOG.md` is updated under `[Unreleased]` if the change is user-visible
- [ ] Commit messages follow Conventional Commits

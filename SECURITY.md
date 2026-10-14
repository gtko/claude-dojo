# Security Policy

## Supported versions

Security fixes are made on the latest release and on the `main` branch.

## Reporting a vulnerability

Please do not report security issues in public issues or pull requests.

Report them privately with [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability): open the repository's **Security** tab and choose **Report a vulnerability**. Please include:

- a description of the issue and its impact,
- steps to reproduce it, or a proof of concept,
- your macOS and Node.js versions, and the commit or release you tested.

We will acknowledge your report as soon as we can and keep you updated while we work on a fix.

## Data handled locally

claude-dojo runs on your Mac. Its data handling is limited to the following:

- It reads local Claude Code state (for example under `~/.claude`) in read-only mode.
- It reads the macOS Keychain item `Claude Code-credentials` in read-only mode, locally, to get the OAuth access token that Claude Code stores there. That token is only sent to Anthropic's API (`api.anthropic.com`), to fetch your subscription usage.
- The local agent listens on `127.0.0.1` only, on port 7777.
- API tokens you configure for optional panels stay in your local configuration. Never commit them.

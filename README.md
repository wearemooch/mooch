# mooch

**The coding agent that runs on other people's free tiers.**

mooch is a code editor with a built-in coding agent, **Penny**, that runs on free AI models. Open a folder and tell Penny what to change: she reads your code, edits files and runs commands, and asks first when she should. Changes can be undone from restore points.

Brand assets: the logo, icon and brand book are kept outside this repository (`mooch/assets`). The product name, the agent's name and the tagline live in `app/src/shared/brand.ts`.

## Install

- **Windows 10/11 (x64):** run `mooch-Setup-<version>.exe`.
- **macOS (Apple Silicon or Intel):** open `mooch-<version>-mac-<arch>.dmg` and drag mooch to Applications. Builds are not signed yet, so the first time, right-click the app and choose **Open**.
- **Linux (x64):** install `mooch-<version>-linux-amd64.deb`, or `chmod +x mooch-<version>-linux-x86_64.AppImage` and run it.

Then:

1. Start mooch.
2. On first start the app sets up its model gateway: it downloads a private Python runtime and the gateway's packages (about 200 MB, under a minute on a fast connection).
3. Open **Settings > Models & providers** and add a key for at least one provider. Most have a free tier; **Get a key** opens the provider's page. Keys are checked with the provider before they're saved.
4. Open a folder and start a chat.

Optional: install Git ([Windows](https://git-scm.com/download/win); on macOS and Linux it's usually there already) for restore points (undo). Without Git, everything else works.

## What you can do

- **Chat with Penny** about the open folder: she reads, edits, runs commands and tests, and asks first when the permission mode says so (*Ask first*, *Auto-edit*, *Full auto*).
- **Slash commands**: type `/` in the message box. `/compact`, `/model`, `/mode`, `/undo`, `/rewind`, `/review`, `/resume`, `/init`, `/usage` and more. Your own commands are Markdown files in `~/.mooch/commands` (a project can add its own in `.mooch/commands`).
- **Past chats** (the chat-bubbles button, or `/resume`): every chat is saved; open one from any project and continue it. mooch switches to its folder.
- **Compaction**: long chats are summarized automatically (at 64k tokens by default, **Settings > Chat**), or any time with `/compact`. The status bar shows how full the context is.
- **Skills** (**Settings > Skills**): install from a folder, a .zip, a GitHub link, or import the ones you have in Claude or Codex. Same `SKILL.md` format. Run one as `/skill-name`, or let Penny pick it up when it fits.
- **Integrations** (**Settings > Integrations**): MCP servers that let Penny use other apps and tools. Paste a config from a README, import from Claude Desktop, Claude Code, Cursor or Windsurf, or add one by hand. Tools that only read run on their own; tools that change something ask first.
- **Themes** (**Settings > Appearance**): Night, Day, Broth and Receipt. The default follows your system: Night when it is dark, Day when it is light.

## How it works

```
Editor window (React, Monaco)
   │  narrow, validated IPC
Main process ── agent engine (OpenAI Codex, app-server mode) ── local model proxy ──┐
             └─ model gateway (Free Claude Code, separate process, 127.0.0.1) ◄────┘── model providers
```

- The **agent engine** plans and runs the work. Its own analytics, feedback uploads and update checks are turned off.
- The **model gateway** translates the engine's requests for the providers you add keys for, and checks keys and falls back between models. It listens on 127.0.0.1 only and requires a random per-install token.
- **Team features** (optional): a second model reviews changes, several models plan before hard tasks ("Deep thinking"), slow requests are hedged with a backup model (a backup always steps in when a free model is overloaded or goes quiet), and "Race" runs several agents in copies of the project and keeps the version whose tests pass.

## Privacy and security

- Your code and chats go only to the model providers you add keys for. There is no telemetry.
- Network use besides that: the first start downloads Python (python-build-standalone) and the gateway's packages (PyPI).
- **Permissions** (chosen per chat):
  - *Ask first* (default): reading files and running read-only commands inside the project happen automatically; every edit and every other command waits for your approval.
  - *Auto-edit*: edits inside the project apply automatically; other commands still ask.
  - *Full auto*: nothing asks. Use it only in projects you trust and can restore.
- Commands that touch anything outside the project folder (other drives, your home folder, network shares, environment variables, the registry) are never run automatically, not even read-only ones.
- Integrations (MCP servers) are programs that run with your permissions: add only ones you trust. mooch only reads your own `~/.mooch/mcp.json`, never a project's. Skills are instructions and scripts; installing one never runs anything.
- Open only projects you trust. Like any coding tool, the agent runs the project's own scripts (tests, builds) when you approve them or start a Race.
- Data locations:
  - Your folder, `~/.mooch` (`C:\Users\<you>\.mooch`): settings, provider keys, chats, restore points, skills, integrations, logs
  - Gateway runtime (Python and packages): `%LOCALAPPDATA%\Programs\mooch-runtime`

## Uninstall

- **Windows:** *Add or remove programs*. The uninstaller removes the app and the gateway runtime.
- **macOS / Linux:** first click **Remove gateway runtime** in **Settings > About** (it frees about 300 MB), then delete the app.

Your folder `~/.mooch` (settings, provider keys, chats, restore points, skills, integrations) is kept; delete it to remove them too.

## Build from source

Prerequisites: Node.js 22.12 or newer, [uv](https://docs.astral.sh/uv/), Git, and the pinned gateway checkout:

```bash
git clone https://github.com/alishahryar1/free-claude-code _reference/free-claude-code
git -C _reference/free-claude-code checkout v6.16.9
```

```bash
cd app
npm ci
npm run dist
```

`npm run dist` (Windows), `npm run dist:mac` or `npm run dist:linux` typecheck, run the tests, build, stage the bundled components and license notices (`scripts/stage.mjs`), and write the installer to `app/release/`. Each OS is built on that OS. `npm run pack` builds an unpacked app for testing. Development with hot reload: `npm run dev` (see `app/README.md`).

**CI**: `.github/workflows/build.yml` builds Windows and Linux on every push, and macOS (Apple Silicon and Intel) for version tags (`v*`) or when started by hand (**Actions > Build > Run workflow**). The installers are kept as artifacts. To release: set the version in `app/package.json`, then push a matching tag (`git tag v0.1.0 && git push origin v0.1.0`); the workflow builds all four and makes a draft GitHub Release with the installers attached, ready to check and publish. With a repository secret `NVIDIA_NIM_API_KEY` it also runs a real model turn on each OS (`scripts/smoke-backend.mjs`).

## License

Copyright © 2026 mooch contributors. The app's own code is licensed under the GNU Affero General Public License v3.0 or later (`LICENSE`): you may use, change and share it, and anything based on it that you distribute, or offer to people over a network, must also be released under the AGPL with its full source. It bundles third-party software under its own licenses, including the model gateway (Free Claude Code, AGPL-3.0-only, included unmodified with its complete source) and the agent engine (OpenAI Codex, Apache-2.0). See **Settings > Acknowledgements** in the app, or `resources/notices/THIRD_PARTY_NOTICES.md` in the installation folder.

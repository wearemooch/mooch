# mooch (app)

Developer notes. For users and release builds, see `../README.md`.

```
Electron renderer (React + Monaco)  ⇄  main process (validated IPC, trusted-sender check)
                                        ├─ FccSidecar     uv run fcc-server (127.0.0.1, random port, proxy token, isolated home)
                                        ├─ HedgeProxy     local proxy for the engine's model calls (token, loopback Host, /v1 only)
                                        └─ CodexAppServer codex.exe app-server (stdio JSONL)
```

## Run in development

Prerequisites: Node.js 22.12+, `uv` and Git on PATH, and the pinned gateway checkout at `../_reference/free-claude-code` (tag `v6.16.9`) with `uv sync --frozen` run there (or set `FREE_CODE_FCC_PROJECT`).

```bash
npm install
npm run dev          # hot reload
npm run build && npx electron . path/to/a/project
```

`FREE_CODE_DEV_URL`, `FREE_CODE_CODEX_BIN` and `FREE_CODE_FCC_PROJECT` are honored only in unpacked development runs, never in an installed app.

## Release build

```bash
npm run pack   # unpacked app in release/win-unpacked (for testing)
npm run dist   # NSIS installer in release/
```

Both run typecheck, tests and `npm run stage` first. `scripts/stage.mjs` assembles `build/stage/`, which is copied into the app's `resources/` folder:

- `codex/`: the agent engine from `node_modules/@openai/codex-win32-x64`, without its unused voice libraries (LGPL).
- `gateway/`: the gateway's complete source. Staging refuses a checkout with local changes; it ships unmodified.
- `bin/uv.exe`: from PATH, or `UV_BINARY`.
- `versions.json` and `notices/THIRD_PARTY_NOTICES.md`: full license texts for everything that ships. Texts that aren't in `node_modules` are downloaded from the projects' repositories at the bundled versions.

On this machine the system Node is 20.12, so run the builder under Node 22: `npx -y node@22 node_modules/electron-builder/cli.js --win`.

Installed builds keep the gateway's Python environment in `%LOCALAPPDATA%\Programs\mooch-runtime`, not under AppData\Local or \Roaming directly. On some machines new folders there inherit an AppContainer ACE that breaks uv's Python install ("Missing expected target directory for Python minor version link"). uv's PATH shims and registry entries are disabled (`UV_PYTHON_INSTALL_BIN=0`, `UV_PYTHON_INSTALL_REGISTRY=0`).

## Isolation and safety

- Paths: `src/main/paths.ts`. Everything of the user's is in `~/.mooch` (`MOOCH_HOME` overrides it); Electron's own cache stays in the OS app-data folder. The first start copies settings and keys from `%APPDATA%\mooch` (`src/main/migrate.ts`).
- The gateway runs with its own HOME (`~/.mooch/gateway`) and never touches `~/.fcc`.
- The engine runs with `CODEX_HOME=~/.mooch/engine`, `OPENAI_*` env vars stripped, analytics, feedback and update checks off, and every engine feature that calls OpenAI's servers disabled (`DISABLED_FEATURES` in `src/main/codex/launch.ts`). To check: the engine's `logs_2.sqlite` has no chatgpt.com or openai.com entries.
- Auto-approval: `src/shared/commands.ts` (read-only commands) and `src/main/codex/policy.ts` (what counts as outside the project). Both have adversarial tests.
- Programs the app starts by name (git, uv) are resolved from PATH only, never from the project folder (`src/main/exec.ts`).
- Busy free models (`src/main/llm/hedge.ts`, `modelHealth.ts`): the gateway retries an overloaded or silent model for up to ~10 minutes, so the proxy in front of it doesn't wait. With Backup on (the default), a backup model is asked when the model is slow (after the delay set in Settings > Chat), fails, is overloaded, or produces nothing for 40s, and at once if it failed in the last 3 minutes. When the model hit its limit or failed, the chat moves to the backup (a divider says so, with Switch back); when it was only slow, that reply says "answered by". Backups use the same edit tools as the model. With Backup off, only the chosen model answers, and a limit shows Use another model / Try again. After 150s with no answer from any model, the turn ends with a plain error. Busy models are marked in the picker. Replies that freeze mid-stream are retried after 90s (`stream_idle_timeout_ms`).
- Crash safety: gateway processes left by a crashed session are ended on the next start; race copies left behind are deleted without following their junctions.
- Electron fuses: no RunAsNode, no NODE_OPTIONS, no --inspect, app loads only from its integrity-checked asar.

## Pinned versions

- `@openai/codex` 0.162.1. After upgrading, regenerate the protocol types with `npm run codex:types`.
- Gateway: Free Claude Code v6.16.9.

## Features and where they live

- Sessions: `src/main/sessions.ts` (one event log per chat in `~/.mooch/sessions`, replayed by the renderer's transcript reducer), `components/SessionsView.tsx`. Continuing a chat calls the engine's `thread/resume` and rebuilds restore points from the log.
- Slash commands: `src/renderer/slashCommands.ts` (built-ins, parsing), `src/main/slashCommands.ts` (custom commands), `components/CommandMenu.tsx`. `/model` and `/mode` change the open chat through per-turn overrides (`turnOverrides` in `appServer.ts`).
- Compaction: the engine's `thread/compact/start` and `model_auto_compact_token_limit`; mooch's summary prompt is `prompts/compact.md` (`compact_prompt`).
- Skills: `src/main/skills.ts` (install from folder, .zip, GitHub, other apps; zip-slip and symlink safe). Registered with the engine via `skills/extraRoots/set`; the engine's built-ins that assume an OpenAI account are turned off.
- Integrations: `src/main/mcp.ts` (`~/.mooch/mcp.json` → the engine's `mcp_servers` via `config/batchWrite`). Tool approvals arrive as elicitations tagged `mcp_tool_call` and become approval cards (`onElicitation` in `appServer.ts`); servers use `default_tools_approval_mode = "writes"`, so read-only tools run without asking.
- Platforms: `src/main/platform.ts` (engine build per OS/CPU, runtime folder), `pidsUnder`/`endProcessesUnder` in `src/main/exec.ts` (POSIX process cleanup), POSIX rules in `src/shared/commands.ts` and `src/main/codex/policy.ts`.

## Tests

- `npm test`: unit tests (JSONL client, launch config, auto-approval, policy, proxy hardening, settings validation, edit tools, restore points, race copies, transcript reducer…).
- `npm run smoke:backend`: gateway → engine → thread → one turn, without Electron.
- `npm run smoke:app -- <folder>`: launches the real app and saves `.smoke-data/screenshot.png`. Set `SMOKE_SCRIPT` to drive the UI first.
- `node scripts/smoke-team.mjs <identity|permissions|shell|fix|review|deep|race|hedge|restore|resume|compact|skill|mcp|mcp-full> [model]`: features against real models (`scripts/fixtures/mcp-fixture.mjs` is a tiny MCP server for the `mcp` scenarios).

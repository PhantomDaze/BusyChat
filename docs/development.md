# Development Guide

## Prerequisites

- Node.js 20 or newer
- npm

## Install

```bash
npm install
```

## Run in development

```bash
npm run dev
```

The dev command uses `tsx` so the source can be executed directly.

## Build for production-style execution

```bash
npm run build
npm start
```

## Repository layout

- `src/index.ts`: process entrypoint
- `src/app.ts`: application bootstrap and orchestration
- `src/types.ts`: shared contracts
- `src/config.ts`: default config values and normalization helpers
- `src/config-store.ts`: root `config.json` loader, saver, and runtime store
- `src/storage.ts`: file-backed persistence for logs and plugin namespaces
- `src/models.ts`: model families, tasks, and providers
- `src/onebot.ts`: OneBot client and event normalization
- `src/onebot-ws.ts`: OneBot v11 forward and reverse WebSocket transport
- `src/policies.ts`: admin and report filtering
- `src/commands.ts`: built-in commands and command parsing
- `src/plugins.ts`: plugin discovery and guarded runtime
- `src/summary.ts`: summary worker and admin advice flow
- `src/webui.ts`: Hapi server and WebUI endpoints
- `src/plugins/sample-assistant/index.ts`: example plugin
- `config.example.json`: template for the root `config.json`

## JSON config file

The application loads a root-level `config.json` before bootstrap.
Use [`config.example.json`](../config.example.json) as the template.

Format:

- `settings` controls bootstrap values such as host, port, data directory, and route paths.
- `runtime` controls admins, report recipients, OneBot HTTP and WebSocket settings, summary settings, models, plugins, and UI state.
- If `config.json` is missing, the application creates it with defaults.
- The WebUI exposes the same file through a JSON editor and writes changes back directly.
- Existing installations can migrate a legacy `data/runtime.json` into `config.json` on first startup.
- Changes to `settings.host`, `settings.port`, `settings.dataDir`, `settings.pluginSearchDirs`, `settings.uiPath`, and `settings.eventPath` require an application restart.
- All source files, docs, and JSON config files should stay UTF-8. Preserve the original meaning of existing Chinese text when editing.

## Runtime state and persistence

Runtime state now lives inside `config.json`, and the file-backed data directory continues to store logs and plugin data.

- Root config path: `config.json`
- Template path: `config.example.json`
- Format: JSON object with `settings` and `runtime`
- Created automatically on first run if absent
- `src/config-store.ts` is the canonical loader/saver and runtime store wrapper

Important top-level fields:

- `admins`
- `onebot`
- `summary`
- `activeModels`
- `models`
- `plugins`
- `ui`

OneBot WebSocket fields live under `runtime.onebot.webSocket`:

- `mode`: `off`, `forward`, `reverse`, or `both`
- `forwardUrl`: forward WebSocket URL exposed by the OneBot implementation
- `reversePath`: reverse WebSocket path exposed by F261Agent
- `reconnectIntervalMs`: reconnect delay for forward WebSocket
- `actionTimeoutMs`: timeout for WebSocket API actions

The HTTP event receiver uses `settings.eventPath`. The reverse WebSocket endpoint uses `runtime.onebot.webSocket.reversePath`; saving config from WebUI restarts the WebSocket transport so mode and endpoint changes apply immediately to new connections.

Related storage files:

- `data/events.ndjson`: normalized incoming message log
- `data/summaries.ndjson`: generated summary records
- `data/advice.ndjson`: admin advice records
- `data/commands.ndjson`: admin command history
- `data/plugins/<plugin>.json`: plugin-local namespaced storage

## How to add a plugin

1. Create `src/plugins/<name>/index.ts`.
2. Export a plugin object with a manifest and setup function.
3. Declare permissions explicitly.
4. Use `ctx.storage.namespace()` for plugin-local data.
5. Register commands through `ctx.commands.register()`.
6. Use [`src/plugins/sample-assistant/index.ts`](../src/plugins/sample-assistant/index.ts) as a reference template.

Recommended plugin permissions:

- `message:observe`
- `admin:observe`
- `summary:observe`
- `bot:send`
- `model:use`
- `storage:read`
- `storage:write`
- `command:register`

The sample plugin demonstrates:

- local state storage
- command registration
- public message observation
- admin message observation
- summary/advice hooks
- unified model access

## How to add a new model family or provider

1. Extend the shared model contracts.
2. Implement a provider adapter in `src/models.ts` or a dedicated provider file.
3. Register the provider in the bootstrap process.
4. Add configuration UI support if the provider has special parameters.

The current registry is designed to support:

- language models
- speech-to-text models
- embedding models
- rerank models

## WebUI workflow

The WebUI is intentionally simple and is meant for day-to-day operations:

- view recent events and command history
- manage admins and report recipients
- edit the root-level `config.json` directly
- inspect OneBot HTTP and WebSocket connection settings
- enable or disable plugins
- switch active models by task
- change summary worker parameters without editing files manually
- reload plugins during development
- keep the config editor and bootstrap file in sync

Model tasks are unified under the same registry:

- summary
- advice
- chat
- classifier
- moderation
- transcription
- embedding
- rerank

The WebUI config editor writes the same `config.json` that bootstrap uses, so runtime changes are not split across legacy config files and the UI.

## Admin reporting rule

The report pipeline must exclude:

- messages from admin accounts
- messages from the bot itself

Admin messages may still be:

- used for commands
- used for advice generation
- stored for audit purposes

They simply must not be forwarded back to the admin report recipients.

# Development Guide

## Prerequisites

- Node.js 22 or newer (see `.nvmrc`)
- npm

## Install

```bash
# 两个 lockfile 均已提交，用 npm ci 保证可复现安装
npm ci

# WebUI（Vue 3 + Vuetify 3）依赖单独安装
npm --prefix webui ci
# 等价的便捷脚本：npm run install:webui（内部使用 npm install）
```

## Run in development

```bash
npm run dev        # backend, tsx watch
npm run dev:webui  # optional: Vite dev server for the dashboard (proxies /api to :3000)
```

The dev command uses `tsx` so the source can be executed directly. The Vite dev
server proxies `/api`, `/onebot` and `/health` to `http://127.0.0.1:3000`, so the
backend must be running for the dashboard to load data.

## Build for production-style execution

```bash
npm run build        # builds webui-dist/ (Vite) then dist/ (tsc)
npm run build:webui  # frontend only
npm run clean:server # removes dist/ (no external dependency)
npm run build:server # clean:server + tsc
npm start
```

A production smoke check (`npm run test:prod`, when the test suite provides it)
starts the built `dist/index.js` against a temporary config and data directory,
waits for `/health`, then asserts a clean `SIGTERM` exit. It is a good local
pre-deploy check even though CI runs its own equivalent step.

The backend serves the built dashboard from `webui-dist/` at `settings.uiPath`
(default `/ui`). `webui-dist/` is git-ignored: if it is missing, `/ui` renders a
"frontend not built" page and the HTTP API keeps working.

## Repository layout

- `src/index.ts`: process entrypoint
- `src/app.ts`: application bootstrap and orchestration
- `src/types.ts`: shared contracts
- `src/config.ts`: default config values and normalization helpers
- `src/config-store.ts`: root `config.json` loader, saver, and runtime store
- `src/plugin-config.ts`: per-plugin config accessor (`PluginConfigStore`) backed by plugin storage namespaces
- `src/storage.ts`: file-backed persistence for logs and plugin namespaces
- `src/models.ts`: model families, tasks, and providers
- `src/model-schema.ts`: provider × family parameter schema that drives the WebUI model-edit form
- `src/onebot.ts`: OneBot client and event normalization
- `src/onebot-ws.ts`: OneBot v11 forward and reverse WebSocket transport
- `src/policies.ts`: admin and report filtering
- `src/commands.ts`: built-in commands and command parsing
- `src/plugins.ts`: plugin discovery and guarded runtime
- `src/summary.ts`: summary worker and admin advice flow
- `src/webui.ts`: Hapi server — auth/session, `/api/*` routes, static SPA hosting
- `webui/`: Vue 3 + Vuetify dashboard (Pinia, vue-router, vue-i18n, ApexCharts, Monaco)
- `webui-dist/`: Vite build output served by `src/webui.ts` (git-ignored)
- `src/plugins/sample-assistant/index.ts`: example plugin
- `config.example.json`: template for the root `config.json`

## JSON config file

The application loads a root-level `config.json` before bootstrap.
Use [`config.example.json`](../config.example.json) as the template.

Format:

- `settings` controls bootstrap values such as host, port, data directory, and route paths.
- `runtime` controls kernel data only: admins, OneBot HTTP and WebSocket settings, models, `activeModels`, plugin enabled states, and UI state.
- **Plugin business configuration does not live in `config.json`.** Each plugin reads and writes its own config through `PluginContext.config` (a `PluginConfigStore` backed by the plugin's storage namespace `config` key). Summary, knowledge-base, and notify settings are therefore edited via their WebUI panels or commands, not by hand-editing `config.json`.
- If `config.json` is missing, the application creates it from the built-in
  defaults (`createDefaultAppConfig()`), not literally from `config.example.json`;
  the example file is a documented template for operators.
- The WebUI exposes the same file through a JSON editor and writes changes back directly.
- Existing installations can migrate a legacy `data/runtime.json` into `config.json` on first startup, and legacy `runtime.summary` / `runtime.knowledgeBase` / `runtime.notifyKeywords` / `runtime.quietHours` are migrated into the matching plugin namespaces (see `migrateLegacyPluginConfigs` in `src/app.ts`).
- Changes to `settings.host`, `settings.port`, `settings.dataDir`, `settings.pluginSearchDirs`, `settings.uiPath`, and `settings.eventPath` require an application restart.
- All source files, docs, and JSON config files should stay UTF-8. Preserve the original meaning of existing Chinese text when editing.

## Runtime state and persistence

Kernel runtime state lives inside `config.json`. All durable application data lives
in a single SQLite database, `data/f261agent.db`, managed by `src/storage.ts`.

- Root config path: `config.json`
- Template path: `config.example.json`
- Format: JSON object with `settings` and `runtime`
- Created automatically on first run if absent (from `createDefaultAppConfig()`)
- `src/config-store.ts` is the canonical loader/saver and runtime store wrapper

Important top-level fields (kernel only):

- `admins`
- `onebot`
- `activeModels`
- `models`
- `plugins` (enabled state only — plugin business config is in each plugin's storage namespace)
- `ui`

OneBot WebSocket fields live under `runtime.onebot.webSocket`:

- `mode`: `off`, `forward`, `reverse`, or `both`
- `forwardUrl`: forward WebSocket URL exposed by the OneBot implementation
- `reversePath`: reverse WebSocket path exposed by F261Agent
- `reconnectIntervalMs`: reconnect delay for forward WebSocket
- `actionTimeoutMs`: timeout for WebSocket API actions

The HTTP event receiver uses `settings.eventPath`. The reverse WebSocket endpoint uses `runtime.onebot.webSocket.reversePath`; saving config from WebUI restarts the WebSocket transport so mode and endpoint changes apply immediately to new connections.

Storage layout (all inside `data/`):

- `data/f261agent.db`: the authoritative SQLite database — normalized events,
  summaries, advice, command history, knowledge base, plugin key/value storage,
  and each plugin's business config (under the plugin's `config` key)
- `data/f261agent.db.bak`: last-known-good backup written by the storage layer
- `data/plugins/<plugin>.json`: human-readable mirror of plugin-local namespaced
  storage; the database remains authoritative

The old NDJSON files (`events.ndjson`, `summaries.ndjson`, `advice.ndjson`,
`commands.ndjson`) are no longer written. Back up the database and `config.json`
together — see [`deployment.md`](./deployment.md#backup-and-restore).

## How to add a plugin

1. Create `src/plugins/<name>/index.ts`.
2. Export a plugin object with a manifest and setup function.
3. Declare permissions explicitly.
4. Use `ctx.config` (a `PluginConfigStore`) for the plugin's own configuration; use `ctx.storage.namespace()` for any other plugin-local data.
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
4. Declare the provider's parameter schema in `src/model-schema.ts` (per `provider` × `family`). The WebUI renders the model-edit form dynamically from this schema, so no hard-coded form markup is needed for new parameters. Optionally implement `listRemoteModels` / `testConnection` on the provider to power the "fetch available models" and "test connection" buttons.
5. Optionally add a `_comment`-style hint or hint text per field for the operator.

The current registry is designed to support:

- language models
- speech-to-text models
- embedding models
- rerank models

## WebUI workflow

The dashboard is a separately built Vue 3 SPA in `webui/` (Vuetify 3, Pinia, vue-router,
vue-i18n, ApexCharts, lazy-loaded Monaco). Vite emits it into `webui-dist/`, and
`src/webui.ts` serves those files at `settings.uiPath` while keeping all data access on the
JSON API under `/api/*`.

Pages (sidebar order, mirroring AstrBot's dashboard information architecture):

- **仪表盘 / Dashboard** — health banners (no password / no admins / fallback-only model),
  onboarding steps, stat cards, hourly message-activity chart, recent events and summaries
- **模型服务 / Providers** — provider workbench: model list + schema-driven parameter form
  (from `src/model-schema.ts`), test connection, fetch upstream `/v1/models`, per-model
  enable toggle, task bindings, and per-task activation
- **插件 / Plugins** — enable/disable, hot reload, permissions and manifest metadata
- **知识库 / Knowledge base** — semantic search, add/delete entries, summarize, vector settings
- **连接与协议 / Connection** — OneBot HTTP API + WebSocket mode/URLs, live transport status,
  event reporting path
- **消息日志 / Message log** — filterable event table with auto refresh
- **摘要与告警 / Summary & alerts** — summary worker settings + manual flush, keyword alerts,
  quiet hours
- **待回复 / Pending replies** — queue inspection, AI-generated reply or dismiss
- **系统设置 / Settings** — appearance (theme/language), admins, password, and a Monaco-based
  `config.json` editor with dirty tracking

Frontend conventions:

- `webui/src/api/client.ts` is the single fetch wrapper: session token from `sessionStorage`
  via `x-admin-token`, uniform `ApiError`, and a global `401` handler that clears the token and
  routes to `#/login`.
- `webui/src/stores/app.ts` caches `/api/state`; pages call `app.load()` after mutations.
- Theme tokens live in `webui/src/theme/*` and follow AstrBot's PurpleTheme palette. The theme
  mode (light/dark/system) is persisted in `localStorage`; `webui/public/theme-boot.js` applies
  it before Vue mounts to avoid a flash.
- `vue-i18n` ships `zh-CN` and `en-US` locale files in `webui/src/i18n/locales/`.
- Hash routing (`#/welcome`) keeps relative asset URLs valid no matter what `settings.uiPath` is.
- Monaco is imported dynamically by `components/shared/JsonEditor.vue`, so the editor and its
  workers are only downloaded when the config tab is opened.

Model tasks are unified under the same registry:

- summary
- advice
- chat
- classifier
- moderation
- transcription
- embedding
- rerank

The WebUI config editor writes the same `config.json` that bootstrap uses, so kernel runtime changes are not split across legacy config files and the UI. Plugin business settings are persisted through each plugin's own WebUI routes into its storage namespace, so they survive plugin reloads independently of `config.json`.

## Admin reporting rule

The report pipeline must exclude:

- messages from admin accounts
- messages from the bot itself

Admin messages may still be:

- used for commands
- used for advice generation
- stored for audit purposes

They simply must not be forwarded back to the admin report recipients.

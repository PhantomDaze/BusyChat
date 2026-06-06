# F261Agent

OneBot v11 AI assistant framework for QQ. Filters noise from group chats, summarizes what matters, and keeps admins informed — so you spend less time scrolling and more time on what actually needs your attention.

> 中文文档：[README_CN.md](./README_CN.md)

## Features

- **Auto-summary** — collects messages across groups & private chats, calls an AI model to produce a digest with actionable suggestions, then pushes it to admins on a configurable interval.
- **Smart reply assistant** — detects messages that need admin attention (private messages, @mentions of the bot), queues them, and surfaces them in the next summary. Admins provide a one-line instruction; the AI generates and sends the actual reply.
- **Importance scoring** — classifies every message 1–5 so summaries focus on noteworthy content and collapse casual chat into a single count line.
- **Daily memory** (plugin) — auto-summarizes the day's activity at 21:30 Beijing time and writes it into the knowledge base. Also extracts facts, decisions, and action items.
- **Knowledge base** — semantic search over stored memories using embeddings + cosine similarity + reranking.
- **Keyword alerts & quiet hours** — instant admin notification for keyword matches; configurable do-not-disturb window.
- **Plugin system** — permissioned, hot-reloadable plugins with access to bot APIs, model calls, storage, and knowledge base.
- **WebUI** — dashboard, model management, plugin toggle, WebSocket control, message log viewer, config editor, and password-protected login page.
- **Long-message chunking** — auto-splits messages that exceed QQ's character limit, splitting at paragraph / sentence boundaries.

## Quick Start

```bash
npm install
npm run dev        # hot-reload dev mode
npm run build      # production build
npm start
```

First run creates `config.json` from [`config.example.json`](./config.example.json).

## Tests

```bash
npm run typecheck          # TypeScript type check
npm run test:ws            # WebSocket forward & reverse (18 tests)
npm run test:kb            # Knowledge base (14 tests)
npm run test:all           # All of the above
```

## Configuration

### WebSocket

Edit `config.json` → `runtime.onebot.webSocket`:

| Field | Description |
|---|---|
| `mode` | `off` \| `forward` (app connects to client) \| `reverse` (client connects to app) \| `both` |
| `forwardUrl` | Forward-mode WS address, e.g. `ws://127.0.0.1:6700` |
| `reversePath` | Reverse-mode receive path, default `/onebot/ws` |

**Forward (recommended):** F261Agent connects to the OneBot client.

```json
"webSocket": {
  "mode": "forward",
  "forwardUrl": "ws://127.0.0.1:6700",
  "reversePath": "/onebot/ws",
  "reconnectIntervalMs": 5000,
  "actionTimeoutMs": 10000
}
```

**Reverse:** The OneBot client connects to F261Agent at `/onebot/ws`.

```json
"webSocket": {
  "mode": "reverse",
  "reversePath": "/onebot/ws",
  "reconnectIntervalMs": 5000,
  "actionTimeoutMs": 10000
}
```

### AI Model (OpenAI-compatible)

Any endpoint compatible with `/v1/chat/completions` works. Example with DeepSeek:

```json
{
  "id": "deepseek-chat",
  "label": "DeepSeek V3",
  "family": "language",
  "provider": "openai-compatible",
  "enabled": true,
  "taskBindings": ["summary", "advice", "chat", "classifier", "moderation", "memory-summary"],
  "parameters": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-your-deepseek-api-key",
    "model": "deepseek-chat",
    "temperature": 0.7,
    "maxTokens": 4096,
    "timeoutMs": 30000,
    "systemPrompt": "You are a QQ group management assistant. Reply concisely in Chinese."
  }
}
```

### Model selection priority

1. `activeModels[task]` explicit binding
2. First `enabled: true` model in the family whose `taskBindings` includes the task
3. `rule-based` fallback (always available, produces placeholder output)

## Built-in Commands

Send `/help` in QQ to see the full list. All commands accept Chinese instructions.

| Command | Description | Access |
|---|---|---|
| `/help` | List all available commands | anyone |
| `/summary now` | Generate & send summary immediately | admin |
| `/summary status` | Show summary config | admin |
| `/report list` | View recent summaries | admin |
| `/send private <QQ> <text>` | Send a private message via the bot | admin |
| `/send group <group> <text>` | Send a group message via the bot | admin |
| `/remember <text>` | Add text to knowledge base | admin |
| `/recall <query> [count]` | Semantic search the knowledge base | admin |
| `/forget <ID>` | Delete a knowledge base entry | admin |
| `/kb-summarize [count]` | AI-summarize knowledge entries | admin |
| `/reply list` | List pending reply requests | admin |
| `/reply <ID> <instruction>` | AI-generate reply and send | admin |
| `/reply dismiss <ID>` | Ignore a reply request | admin |
| `/notify keywords [add\|remove\|list]` | Manage alert keywords | admin |
| `/notify quiet <start> <end>` | Set quiet hours | admin |
| `/model list\|activate` | Manage AI models | admin |
| `/plugin list\|enable\|disable` | Manage plugins | admin |
| `/admin list\|add\|remove` | Manage admins | admin |
| `/auto-memory status\|trigger` | Auto-memory plugin control | admin |

## Documentation

- [Architecture](./docs/architecture.md) — boundaries, data flow, invariants, future split points.
- [Development](./docs/development.md) — build workflow, project layout, plugin authoring, model extension.
- [Engineering principles](./docs/engineering-principles.md) — transport, admin separation, plugin permissions, storage, config.

## License

[GPL-3.0](./LICENSE)

Copyright (C) 2025 PhantomDaze

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

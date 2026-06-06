# Architecture Notes

## High-level shape

The system is intentionally designed as a modular monolith.

That choice keeps the first version simple while preserving future options:

- split transport adapters later without changing application logic
- replace file storage with SQLite or PostgreSQL later
- replace model providers independently of plugins
- move the WebUI to a separate process later if needed

## Core boundaries

### Transport

Transport only handles OneBot-compatible input and output.

It must not contain business logic such as:

- admin routing
- summary construction
- plugin behavior
- model selection

### Domain

Domain objects are protocol-agnostic where possible.

They include:

- normalized messages
- summary records
- command definitions
- model families, model tasks, and model configs
- plugin manifests and permissions

### Application

Application services orchestrate the business flow:

- message ingestion
- admin command execution
- advice generation
- summary generation
- plugin dispatch

### Infrastructure

Infrastructure provides concrete implementations:

- file-backed state
- root `config.json` bootstrap and persistence
- OneBot HTTP client
- OneBot v11 forward and reverse WebSocket transport
- Hapi WebUI server
- model provider adapters

### Configuration

The root-level `config.json` is the source of truth for both bootstrap settings and runtime state.

- `settings` contains process-level inputs such as host, port, data directory, UI path, event path, and plugin search paths.
- `runtime` contains mutable operational data such as admins, report recipients, OneBot HTTP/WebSocket credentials, summary settings, model registry entries, plugin runtime state, and UI settings.
- `config.example.json` is the template used to create or reset the root config file.
- The WebUI edits the same `config.json` file directly, but any `settings.*` change that affects the running server still requires restart.

OneBot transport supports three inbound paths:

- HTTP event POST on `settings.eventPath`
- reverse WebSocket on `runtime.onebot.webSocket.reversePath`
- forward WebSocket from `runtime.onebot.webSocket.forwardUrl`

Outbound OneBot API actions prefer an active WebSocket connection and fall back to HTTP when no WebSocket connection is available.

## Important invariants

### Admin messages are not reported back

Messages from admin accounts must never be included in the summary sent to the admin report recipients.

They can still be:

- handled as commands
- used to produce advice
- stored for audit purposes

### Bot messages are not re-ingested

Messages sent by the bot itself must not re-enter summary or advice loops.

### Plugins are permissioned

Plugins only receive the data they are allowed to see.

The permission boundary is enforced in code, not by convention.

### Models are unified by registry

Plugins and application services ask the registry for a task or model family, not a vendor.

Model families:

- language
- speech-to-text
- embedding
- rerank

Typical tasks:

- summary
- advice
- chat
- classifier
- moderation
- transcription
- embedding
- rerank

Human-friendly labels:

- embedding: 向量模型
- rerank: 重排序模型

## Future split points

The following units are safe to extract later if scale demands it:

- event receiver
- summary worker
- model worker
- WebUI
- plugin runtime

## Known limitations for the first version

- file-backed storage is simple, not horizontally scalable
- in-memory plugin loading is sufficient for a single process
- rule-based fallback models are basic
- the WebUI is intentionally lightweight rather than framework-heavy

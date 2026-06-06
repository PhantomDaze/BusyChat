# Engineering Principles

## 1. Keep the transport thin

OneBot adapters are wrappers, not business logic containers.

This applies to HTTP event intake, forward WebSocket, reverse WebSocket, and outbound OneBot API calls.

## 2. Separate admin and public flows

Admin messages have their own lane.

They must not be fed back into the admin summary report.

## 3. Prefer explicit permissions

Plugins should declare permissions up front.

If a plugin needs:

- message observation
- admin observation
- model invocation
- outbound messaging
- storage access

it must ask for those permissions explicitly.

## 4. Store first, analyze second

Incoming events should be persisted before being transformed or summarized.

This keeps the system resilient to restarts and crashes.

## 5. Classify AI by family and task

Models are managed by family and task, not by vendor or endpoint name.

This keeps language models, speech-to-text models, embedding models, and rerank models under one registry.

## 6. Keep plugin APIs small

Plugins should work through a small set of facades:

- `bot`
- `models`
- `storage`
- `commands`
- `logger`
- `runtime`

Avoid exposing raw internal services.

## 7. Make report generation deterministic at the boundary

The event filter that excludes admin and bot messages must be implemented in code.

Do not rely on prompt wording alone.

## 8. Prefer simple defaults

The default runtime should work out of the box with:

- file storage
- rule-based fallback models
- a basic WebUI
- at least one sample plugin

## 9. Keep configuration in JSON

The root-level `config.json` is the source of truth for bootstrap settings and runtime state.

- Use `config.example.json` as the template.
- Let the WebUI edit the same file directly.
- Keep `.env` out of the normal workflow.

## 10. Keep repository text in UTF-8

Source files, docs, and JSON examples should remain UTF-8 encoded.

- Preserve the original meaning and wording of existing Chinese text.
- Avoid introducing mojibake or mixed encodings when editing files.

# agynt — Project Memory

## What This Project Is

A TypeScript toolkit that connects to Antigravity IDE's `language_server_macos_x64` to access Claude Opus 4.6. Three layers:
1. **Building blocks** (`src/`) — raw gRPC client, protobuf, discovery
2. **CLI/TUI** (`cli/`) — interactive terminal and one-shot prompts
3. **API server** (`cli/server/`) — OpenAI-compatible HTTP proxy for OpenCode

## Critical Knowledge

### Model Enum Values (NOT from proto definition)

- Claude Opus 4.6 (Thinking) = **1026** (not 291)
- Claude Sonnet 4.6 (Thinking) = **1035** (not 282)
- Gemini 3 Flash = **1018**
- Gemini 2.5 Pro/Flash **DO NOT WORK** — cascade sends multi-tool agentic system prompt they can't handle

### Authentication

- CSRF header: `x-codeium-csrf-token`
- Language server holds OAuth token internally
- No API key needed in Metadata

### Protobuf Field Numbers

```
SendUserCascadeMessageRequest:
  cascade_id=1, items=2, metadata=3, cascade_config=5
CascadePlannerConfig:
  plan_model=1, conversational=2, requested_model=15
Metadata: ide_name=1, extension_version=2, api_key=3
```

### Response Parsing

- Answer: `trajectory(f1).steps(f2).step_result(f20).text(f1)`
- Model: `trajectory(f1).cascade_info(f3).planner_config(f3).model_name(f28)`

### Error Detection

Error regex must be STRICT — the trajectory contains embedded terminal output and system prompts. Only match JSON error objects with `"code": 503` or specific phrases like `No capacity available for model`.

## Tech Stack

- **Bun** — CLI, TUI, API server (fast startup)
- **tsx/Node** — building block scripts
- `@grpc/grpc-js`, `ink`, `commander`, `chalk`
- Manual protobuf encoding (no .proto files)

## NPM Scripts

- `npm run agynt` — CLI/TUI
- `npm run serve` — OpenAI-compatible API server (port 4141)
- `npm run prompt` — building-block one-shot
- `npm run heartbeat` — connectivity test
- `npm run probe` — service enumeration

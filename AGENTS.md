# agynt — Project Memory

## What This Project Is

A TypeScript gRPC client that connects to the Antigravity IDE's `language_server_macos_x64` process to send AI prompts (primarily Claude Opus 4.6) via the cascade pipeline. No API key needed — piggybacks on the IDE's existing authentication.

## Critical Knowledge

### Model Enum Values (DO NOT use proto definition values)

The `.proto` file defines `MODEL_CLAUDE_4_OPUS_THINKING = 291`, but the server uses **placeholder model slots**. Always get real values from `GetUserStatus`:

- Claude Opus 4.6 (Thinking) = **1026** (not 291)
- Claude Sonnet 4.6 (Thinking) = **1035** (not 282)
- Gemini 3 Flash = **1018**

### Authentication

- **CSRF token** from process args authenticates to the language server gRPC endpoint
- CSRF header key: `x-codeium-csrf-token`
- The language server holds the user's OAuth token internally (set via `sendActionToChatPanel(setApiKey)` from the IDE extension)
- No additional API key needed in Metadata — server already has credentials

### Protobuf Field Numbers

```
SendUserCascadeMessageRequest:
  cascade_id = 1 (string)
  items = 2 (repeated TextOrScopeItem)
  metadata = 3 (Metadata)
  cascade_config = 5 (CascadeConfig)

TextOrScopeItem: text = 1 (string)
Metadata: ide_name = 1, extension_version = 2, api_key = 3
CascadeConfig: planner_config = 1
CascadePlannerConfig: plan_model = 1 (enum), conversational = 2, requested_model = 15
ModelOrAlias: model = 1 (enum), alias = 2 (enum)
```

### Response Parsing

Answer text location in GetCascadeTrajectory response:
- `trajectory(f1).steps(f2).step_result(f20).text(f1)` — the AI answer
- `trajectory(f1).cascade_info(f3).planner_config(f3).model_name(f28)` — model used

### Server Discovery

`language_server_macos_x64` processes found via `ps aux`. Key args:
- `--csrf_token <uuid>` — gRPC auth
- `--extension_server_port <port>` — extension server
- `--random_port` — gRPC port (need to find actual port from lsof)
- `--workspace_id <id>` — workspace identifier
- `--cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com`

## Tech Stack

- Node.js + TypeScript + ES modules
- `@grpc/grpc-js` for gRPC communication
- `@bufbuild/protobuf` for proto schema extraction
- Manual protobuf encoding (no .proto files)
- `tsx` for running TypeScript directly

## NPM Scripts

- `npm run prompt` — one-shot Claude Opus 4.6 prompt
- `npm run heartbeat` — connectivity test
- `npm run probe` — service enumeration

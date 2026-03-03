# Antigravity Language Server Client — Build Context

## Goal

Build a TypeScript script (Node.js, ES modules) that **successfully connects** to the
Antigravity IDE's `language_server_macos_x64` process and gets a response — heartbeat,
health check, model list, or any verifiable "hello world" interaction.

This is the **"third way"** to access Claude Opus 4.6: not via the Gemini CLI (which
only serves Gemini models), not via the `antigravity-claude-proxy` open-source project
(which bypasses the language server and goes direct to Cloud Code API with TOS risk), but
by driving the already-running, already-authenticated `language_server_macos_x64` binary
that the Antigravity IDE app itself uses.

---

## Project Setup

**Stack**: Node.js, TypeScript, ES modules (NOT CommonJS)

```json
// package.json
{
  "name": "ls-client",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts"
  }
}
```

**Packages** (latest stable as of 2026-03-03):

| Package | Version | Purpose |
|---------|---------|---------|
| `@grpc/grpc-js` | 1.14.3 | gRPC client for Node.js |
| `@grpc/proto-loader` | 0.8.0 | Dynamic proto loading (if needed) |
| `typescript` | 5.9.3 | TypeScript compiler |
| `tsx` | 4.21.0 | Run .ts files directly |

```bash
npm init -y
# Then set "type": "module" in package.json
npm install @grpc/grpc-js@1.14.3 @grpc/proto-loader@0.8.0
npm install -D typescript@5.9.3 tsx@4.21.0
```

**tsconfig.json**:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src"]
}
```

---

## Architecture: How the Antigravity IDE Talks to language_server

```
Antigravity IDE (Electron parent, e.g. PID 43105)
    │
    │  gRPC over HTTPS/H2
    │  Port: httpsPort (e.g. 54380)
    │  Auth: csrfToken as gRPC metadata
    │  TLS: Self-signed cert (CN=localhost, O=ENABLES HTTP2)
    │
    ▼
language_server_macos_x64 (child, e.g. PID 43139)
    │
    │  HTTPS + Google OAuth Bearer token
    │  Endpoint: daily-cloudcode-pa.googleapis.com
    │
    ▼
Cloud Code API → Claude Opus 4.6 / Gemini models
```

**Key evidence** from `extension.js` (minified source in Antigravity.app):

```javascript
// The IDE creates a gRPC client with the csrfToken and address:
const address = `127.0.0.1:${n.httpsPort}`;
const client = G(n.csrfToken, address);
await client.heartbeat({metadata: V.MetadataProvider.getInstance().getMetadata()});
```

**The CSRF token is passed to the gRPC client constructor**, which almost certainly sends
it as a gRPC metadata header on every call. This is the key missing piece — our Python
attempts did NOT send the CSRF token as gRPC metadata.

---

## How to Discover Running Servers

Every `language_server_macos_x64` process has its parameters visible in `ps aux`:

```bash
ps aux | grep language_server_macos
```

This reveals the following parameters per process:

| Parameter | Example Value | Purpose |
|-----------|---------------|---------|
| `--csrf_token` | `4cb51daf-0c99-4871-ae8b-dbef9fc4d1ff` | Auth token for gRPC calls |
| `--extension_server_port` | `54379` | Parent's HTTP extension server |
| `--extension_server_csrf_token` | `eda68198-b455-47fa-9625-7816dedeba58` | Parent's CSRF |
| `--workspace_id` | `file_Users_bedwards_vibe_openagy` | Which workspace |
| `--cloud_code_endpoint` | `https://daily-cloudcode-pa.googleapis.com` | Backend API |

### Port Layout (per workspace)

Each workspace has a predictable port layout:

| Port | Owner | Protocol | Purpose |
|------|-------|----------|---------|
| ext_port (e.g. 54379) | Parent (Electron) | HTTP | Extension server (CSRF-gated) |
| ext_port + 1 (e.g. 54380) | Child (language_server) | **HTTPS/H2, gRPC** | **THE TARGET — AI endpoint** |
| ext_port + 2 (e.g. 54381) | Child (language_server) | HTTP | Unknown (returns 404) |
| ext_port + 9 (e.g. 54388) | Child (language_server) | Binary | gRPC (connection reset) |
| ext_port + 32 (e.g. 54411) | Parent (Electron) | HTTP JSON-RPC | Chrome DevTools MCP |

**You want port ext_port + 1** — this is where `language_server_macos_x64` listens for
gRPC calls from the IDE.

---

## What We KNOW Works (✅ Verified)

1. **gRPC Heartbeat** — `LanguageServerService/Heartbeat` returns a 14-byte protobuf on port
   ext_port + 1 (HTTPS/H2) using `csrf_token` and metadata key `x-codeium-csrf-token`.

2. **HandleAsyncPostMessage** — `ExtensionServerService/HandleAsyncPostMessage` works on the
   same port using `ext_csrf_token`. This is the IDE↔language_server message bus.

3. **Two CSRF tokens gate two services** on the same HTTPS port:
   - `csrf_token` → `LanguageServerService` (Heartbeat, GetAllCustomAgentConfigs)
   - `ext_csrf_token` → `ExtensionServerService` (HandleAsyncPostMessage, WriteCascadeEdit, etc.)

4. **The CSRF metadata key** is `x-codeium-csrf-token` (discovered from `extension.js` and
   confirmed in the binary's `CsrfInterceptor.WrapUnary`).

5. **Chrome DevTools MCP** on the parent's secondary port (ext_port + 32) speaks JSON-RPC
   2.0 over HTTP with SSE. We successfully called `initialize` and `tools/list`.

6. **The TLS certificate** on the gRPC port is self-signed:
   - Subject: `CN=localhost; O=ENABLES HTTP2; OU=bundled on purpose`
   - Extractable via Node.js `tls.connect()` or `openssl s_client`

7. **HTTP/2 is supported** on the gRPC port (verified via curl ALPN negotiation).

8. **Port ext_port + 2** also serves gRPC over plain HTTP (no TLS needed).

---

## gRPC Services and Methods (Extracted from Binary)

### Primary target: LanguageServerService

```
/exa.language_server_pb.LanguageServerService/Heartbeat
/exa.language_server_pb.LanguageServerService/GetAllCustomAgentConfigs
/exa.language_server_pb.LanguageServerService/ReconnectExtensionServer
```

### AI/Prediction (the ultimate goal):

```
/google.internal.cloud.code.v1internal.PredictionService/GenerateContent
/google.internal.cloud.code.v1internal.PredictionService/FetchAvailableModels
/google.internal.cloud.code.v1internal.PredictionService/CountTokens
/google.internal.cloud.code.v1internal.PredictionService/RetrieveUserQuota
```

### Cloud Code service:

```
/google.internal.cloud.code.v1internal.CloudCode/LoadCodeAssist
/google.internal.cloud.code.v1internal.CloudCode/ListExperiments
/google.internal.cloud.code.v1internal.CloudCode/SearchSnippets
/google.internal.cloud.code.v1internal.CloudCode/GenerateCode
/google.internal.cloud.code.v1internal.CloudCode/ListModelConfigs
/google.internal.cloud.code.v1internal.CloudCode/ListAgents
/google.internal.cloud.code.v1internal.CloudCode/OnboardUser
/google.internal.cloud.code.v1internal.CloudCode/InternalAtomicAgenticChat
```

### Extension server (runs on port 54379 but also accessible via gRPC?):

```
/exa.extension_server_pb.ExtensionServerService/HandleAsyncPostMessage
/exa.extension_server_pb.ExtensionServerService/TerminateCommand
/exa.extension_server_pb.ExtensionServerService/WriteCascadeEdit
/exa.extension_server_pb.ExtensionServerService/RunExtensionCode
/exa.extension_server_pb.ExtensionServerService/StoreSecretValue
/exa.extension_server_pb.ExtensionServerService/ShowConversationPicker
/exa.extension_server_pb.ExtensionServerService/SmartFocusConversation
/exa.extension_server_pb.ExtensionServerService/TerminalResearchResult
```

### Jetski (Gemini CLI internals):

```
/google.internal.cloud.code.v1internal.JetskiService/GetHealth
/google.internal.cloud.code.v1internal.JetskiService/FetchUserInfo
/google.internal.cloud.code.v1internal.JetskiService/GetAgentPlugin
/google.internal.cloud.code.v1internal.JetskiService/ListAgentPlugins
/google.internal.cloud.code.v1internal.JetskiService/RewriteUri
/google.internal.cloud.code.v1internal.JetskiService/SetUserSettings
```

### Model management:

```
/exa.model_management_pb.ModelManagementService/UpdateInferenceServer
```

### REST-style endpoints (also found in binary):

```
/v1internal/{name=health}
/v1internal/agentPlugins
/v1internal/cascadeNuxes
/v1internal/webDocsOptions
```

---

## What We Have NOT Yet Figured Out (❓ Unknown)

1. **Protobuf message schemas** for `HandleAsyncPostMessage` — We know it takes JSON in a
   `requestContent` field and returns JSON in `responseContent`, but we need to construct the
   protobuf wrapper. The extension.js shows command types like `"listTerminals"`,
   `"handleReload"`, `"fetchUserAnalyticsSummary"`, etc.

2. **How AI/cascade requests flow** — The `PredictionService`, `CloudCode`, and `JetskiService`
   methods all return 404 on the local port (NOT served locally). The language server proxies
   AI requests to Cloud Code internally. The cascade flow likely goes through
   `HandleAsyncPostMessage` or a separate streaming mechanism.

3. **The cascade command type** that triggers AI generation — likely related to
   `InternalAtomicAgenticChat` or `streamGenerateContent`, but the exact JSON payload format
   and command name for the message bus is unknown.

---

## Suggested Implementation Plan

### Step 1: Discover servers

Parse `ps aux` output to find `language_server_macos_x64` processes and extract their
`--csrf_token`, `--extension_server_port`, and `--workspace_id`.

### Step 2: Extract TLS cert

Use Node.js `tls.connect()` to grab the peer certificate from port `ext_port + 1`.
Or read from the `openssl` extracted PEM.

### Step 3: Create gRPC channel

```typescript
import * as grpc from '@grpc/grpc-js';
import { readFileSync } from 'fs';

const certPem = readFileSync('/tmp/ls_cert.pem');
const creds = grpc.credentials.createSsl(certPem);

const channel = new grpc.Channel('127.0.0.1:54380', creds, {
  'grpc.ssl_target_name_override': 'localhost',
});
```

### Step 4: Call Heartbeat with CSRF metadata

```typescript
const client = new grpc.Client('127.0.0.1:54380', creds, {
  'grpc.ssl_target_name_override': 'localhost',
});

const metadata = new grpc.Metadata();
metadata.set('x-csrf-token', csrfToken); // try different key names

// Raw unary call (no proto file needed)
client.makeUnaryRequest(
  '/exa.language_server_pb.LanguageServerService/Heartbeat',
  (arg: Buffer) => arg,       // serialize: pass through
  (arg: Buffer) => arg,       // deserialize: pass through
  Buffer.alloc(0),            // empty request body
  metadata,
  { deadline: Date.now() + 5000 },
  (err, response) => {
    if (err) {
      console.error('gRPC error:', err.code, err.details);
    } else {
      console.log('Heartbeat response:', response);
    }
  }
);
```

### Step 5: If Heartbeat works, try FetchAvailableModels

Same pattern but with path:
```
/google.internal.cloud.code.v1internal.PredictionService/FetchAvailableModels
```

---

## Current openagy Workspace Server Info

For immediate testing against the openagy workspace:

```
PID (language_server): 43139
PID (parent):          43105
csrf_token:            4cb51daf-0c99-4871-ae8b-dbef9fc4d1ff
ext_csrf_token:        eda68198-b455-47fa-9625-7816dedeba58
extension_server_port: 54379
gRPC HTTPS port:       54380  (ext_port + 1)
workspace_id:          file_Users_bedwards_vibe_openagy
cloud_code_endpoint:   https://daily-cloudcode-pa.googleapis.com
```

> **NOTE**: These values come from `ps aux` and are stable for the lifetime of the
> Antigravity window/session. If you restart Antigravity, re-discover them.

---

## File Locations

| File | Path |
|------|------|
| language_server binary | `/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_x64` |
| Antigravity extension.js | `/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/dist/extension.js` |
| OAuth token database | `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb` |
| TLS cert (extracted) | `/tmp/ls_cert.pem` |
| Existing Python probe | `/Users/bedwards/vibe/openagy/probe_lang_server.py` |
| Existing verify_model script | `/Users/bedwards/vibe/openagy/verify_model.py` |

---

## Key Constraints

1. **Do NOT make direct calls to Cloud Code API** — that's the `antigravity-claude-proxy`
   approach and carries TOS ban risk. We drive `language_server_macos_x64` only.
2. **No protobuf `.proto` files exist** — the binary is closed-source Go. We use raw
   bytes and the method paths extracted from `strings` on the binary.
3. **The language_server is already authenticated** — it holds OAuth tokens and talks to
   Cloud Code on our behalf. We just need to speak its gRPC protocol.
4. **ES modules only** — use `"type": "module"` in package.json, `import` not `require`.

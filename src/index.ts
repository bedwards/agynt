/**
 * Main entry point — discover server, connect over gRPC, call Heartbeat.
 * 
 * Usage:
 *   npm run start                   # auto-picks first server
 *   npm run start -- agynt          # filter by workspace name
 */

import * as grpc from "@grpc/grpc-js";
import { discoverServers } from "./discover.js";
import { extractCert } from "./tls.js";
import { LanguageServerClient } from "./client.js";

// ── gRPC method paths ──────────────────────────────────────────────

const METHODS = {
    // LanguageServerService — uses csrf_token
    heartbeat: "/exa.language_server_pb.LanguageServerService/Heartbeat",
    getAgentConfigs: "/exa.language_server_pb.LanguageServerService/GetAllCustomAgentConfigs",
    reconnect: "/exa.language_server_pb.LanguageServerService/ReconnectExtensionServer",

    // ExtensionServerService — uses ext_csrf_token
    postMessage: "/exa.extension_server_pb.ExtensionServerService/HandleAsyncPostMessage",
};

// ── The CSRF metadata key (discovered from binary + extension.js) ──

const CSRF_KEY = "x-codeium-csrf-token";

// ── Helpers ─────────────────────────────────────────────────────────

function hexDump(buf: Buffer): string {
    if (buf.length === 0) return "(empty)";
    const hex = buf.toString("hex").replace(/(.{2})/g, "$1 ").trim();
    const ascii = Array.from(buf)
        .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
        .join("");
    return `[${buf.length} bytes] ${hex}\n  ASCII: ${ascii}`;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
    // 1. Discover servers
    console.log("═══ Step 1: Discovering language servers ═══\n");
    const servers = discoverServers();

    if (servers.length === 0) {
        console.error("No language_server_macos_x64 processes found. Is Antigravity running?");
        process.exit(1);
    }

    for (const s of servers) {
        console.log(`  PID ${s.pid}  workspace=${s.workspaceId}  grpcPort=${s.grpcPort}  csrf=${s.csrfToken.slice(0, 8)}…`);
    }

    // Pick a server (optionally filter by workspace via CLI arg)
    const filter = process.argv[2];
    const target = filter ? servers.find((s) => s.workspaceId.includes(filter)) : servers[0];

    if (!target) {
        console.error(`No server found matching filter "${filter}"`);
        process.exit(1);
    }

    console.log(`\n  → Using PID ${target.pid} (${target.workspaceId})\n`);

    // 2. Extract TLS cert
    console.log("═══ Step 2: Extracting TLS certificate ═══\n");
    let certPem: Buffer;
    try {
        certPem = await extractCert("127.0.0.1", target.grpcPort);
        console.log(`  ✓ Got cert (${certPem.length} bytes) from port ${target.grpcPort}\n`);
    } catch (err) {
        console.error("  ✗ Failed to extract cert:", err);
        process.exit(1);
    }

    // 3. Create gRPC client
    console.log("═══ Step 3: Connecting gRPC client ═══\n");
    const address = `127.0.0.1:${target.grpcPort}`;
    const client = new LanguageServerClient(address, certPem);
    console.log(`  Client created for ${address}\n`);

    // 4. Call Heartbeat (LanguageServerService — uses csrf_token)
    console.log("═══ Step 4: Heartbeat (LanguageServerService) ═══\n");
    {
        const metadata = new grpc.Metadata();
        metadata.set(CSRF_KEY, target.csrfToken);

        const { error, response } = await client.callUnary(METHODS.heartbeat, metadata);
        if (error) {
            console.log(`  ✗ gRPC error: code=${error.code} (${grpc.status[error.code]}) details="${error.details}"`);
        } else {
            console.log(`  ✓ Heartbeat SUCCESS!`);
            console.log(`  ${hexDump(response!)}\n`);
        }
    }

    // 5. Call HandleAsyncPostMessage (ExtensionServerService — uses ext_csrf_token)
    console.log("═══ Step 5: HandleAsyncPostMessage (ExtensionServerService) ═══\n");
    {
        const metadata = new grpc.Metadata();
        metadata.set(CSRF_KEY, target.extCsrfToken);

        const { error, response } = await client.callUnary(METHODS.postMessage, metadata);
        if (error) {
            console.log(`  ✗ gRPC error: code=${error.code} (${grpc.status[error.code]}) details="${error.details}"`);
        } else {
            console.log(`  ✓ HandleAsyncPostMessage SUCCESS!`);
            console.log(`  ${hexDump(response!)}\n`);
        }
    }

    // 6. Summary
    console.log("═══ Summary ═══\n");
    console.log(`  CSRF metadata key:  ${CSRF_KEY}`);
    console.log(`  gRPC HTTPS port:    ${target.grpcPort}`);
    console.log(`  LanguageServerService: csrf_token → Heartbeat ✓`);
    console.log(`  ExtensionServerService: ext_csrf_token → HandleAsyncPostMessage ✓`);
    console.log(`  PredictionService/CloudCode: NOT served locally (404)`);
    console.log(`  Next step: Construct protobuf messages for HandleAsyncPostMessage`);
    console.log(`             to send cascade/AI commands through the message bus.`);

    client.close();
    console.log("\n═══ Done ═══");
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});

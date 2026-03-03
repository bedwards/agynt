/**
 * Probe cascade-related LanguageServerService methods.
 */

import * as grpc from "@grpc/grpc-js";
import { discoverServers } from "./discover.js";
import { extractCert } from "./tls.js";
import { LanguageServerClient } from "./client.js";

const CASCADE_METHODS = [
    "/exa.language_server_pb.LanguageServerService/StartCascade",
    "/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage",
    "/exa.language_server_pb.LanguageServerService/GetModelStatuses",
    "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs",
    "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory",
    "/exa.language_server_pb.LanguageServerService/InitializeCascadePanelState",
    "/exa.language_server_pb.LanguageServerService/GetAllCustomAgentConfigs",
    "/exa.language_server_pb.LanguageServerService/GetStatus",
    "/exa.language_server_pb.LanguageServerService/GetUserSettings",
    "/exa.language_server_pb.LanguageServerService/GetUserStatus",
    "/exa.language_server_pb.LanguageServerService/GetWorkspaceInfos",
    "/exa.language_server_pb.LanguageServerService/WellSupportedLanguages",
    "/exa.model_management_pb.ModelManagementService/ListModels",
];

function hexDump(buf: Buffer): string {
    if (buf.length === 0) return "(empty)";
    const hex = buf.toString("hex").replace(/(.{2})/g, "$1 ").trim();
    const ascii = Array.from(buf)
        .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
        .join("");
    return `[${buf.length} bytes]\n  HEX: ${hex}\n  ASCII: ${ascii}`;
}

function tryDecodeReadableStrings(buf: Buffer): string {
    if (buf.length === 0) return "";
    // Try to find UTF-8 strings in the protobuf
    const text = buf.toString("utf-8");
    const readable = text.replace(/[^\x20-\x7e\n]/g, "|").replace(/\|{3,}/g, "...");
    return readable;
}

async function main() {
    const servers = discoverServers("agynt");
    const target = servers[0];
    if (!target) { console.error("No server found"); process.exit(1); }

    console.log(`Using PID ${target.pid} (${target.workspaceId}) on port ${target.grpcPort}\n`);

    const certPem = await extractCert("127.0.0.1", target.grpcPort);
    const client = new LanguageServerClient(`127.0.0.1:${target.grpcPort}`, certPem);

    const metadata = new grpc.Metadata();
    metadata.set("x-codeium-csrf-token", target.csrfToken);

    for (const method of CASCADE_METHODS) {
        const shortName = method.split("/").pop();
        console.log(`── ${shortName} ──`);

        const { error, response } = await client.callUnary(method, metadata, Buffer.alloc(0), 5000);

        if (error) {
            console.log(`  ✗ ${grpc.status[error.code]}: ${error.details}`);
            if (error.metadata) {
                const entries = error.metadata.toJSON();
                if (Object.keys(entries).length > 0) {
                    console.log(`  metadata:`, JSON.stringify(entries));
                }
            }
        } else if (response) {
            console.log(`  ✓ ${hexDump(response)}`);
            const readable = tryDecodeReadableStrings(response);
            if (readable.length > 5) {
                console.log(`  READABLE: ${readable.slice(0, 500)}`);
            }
        } else {
            console.log(`  ✓ (null response)`);
        }
        console.log();
    }

    client.close();
}

main().catch(console.error);

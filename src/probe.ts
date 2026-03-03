/**
 * Probe newly discovered services from the binary strings.
 */

import * as grpc from "@grpc/grpc-js";
import { discoverServers } from "./discover.js";
import { extractCert } from "./tls.js";
import { LanguageServerClient } from "./client.js";

const NEW_METHODS = [
    // ApiServerService — possible AI endpoint!
    "/exa.api_server_pb.ApiServerService/GetStreamingModelAPITextCompletion",

    // CascadePlugins — the cascade service from extension.js
    // Need to find methods - let's try common ones
    "/exa.cascade_plugins_pb.CascadePluginsService/GetCascadePlugins",
    "/exa.cascade_plugins_pb.CascadePluginsService/ListCascadePlugins",

    // Analytics 
    "/exa.product_analytics_pb.ProductAnalyticsService/RecordAnalyticsEvent",
    "/exa.user_analytics_pb.UserAnalyticsService/GetAnalytics",
    "/exa.user_analytics_pb.UserAnalyticsService/GetPreferredTimeZone",

    // Code Index
    "/exa.opensearch_index_pb.CodeIndexService/HybridSearch",
    "/exa.opensearch_index_pb.CodeIndexService/KeywordSearch",

    // SeatManagement (user info)
    "/exa.seat_management_pb.SeatManagementService/GetCurrentUser",
    "/exa.seat_management_pb.SeatManagementService/GetUserStatus",
    "/exa.seat_management_pb.SeatManagementService/GetPlanStatus",
];

async function main() {
    const servers = discoverServers();
    const target = servers[0];
    if (!target) { console.error("No server found"); process.exit(1); }

    console.log(`Using PID ${target.pid} (${target.workspaceId}) on port ${target.grpcPort}\n`);

    const certPem = await extractCert("127.0.0.1", target.grpcPort);
    const client = new LanguageServerClient(`127.0.0.1:${target.grpcPort}`, certPem);

    // Try with csrf_token
    console.log("── With csrf_token ──\n");
    const md1 = new grpc.Metadata();
    md1.set("x-codeium-csrf-token", target.csrfToken);

    for (const method of NEW_METHODS) {
        const short = method.split("/").slice(-2).join("/");
        const { error, response } = await client.callUnary(method, md1, Buffer.alloc(0), 3000);
        if (error) {
            console.log(`  ${short.padEnd(70)} ✗ ${grpc.status[error.code].padEnd(18)} ${error.details?.slice(0, 60)}`);
        } else {
            const len = response?.length ?? 0;
            console.log(`  ${short.padEnd(70)} ✓ OK (${len} bytes)`);
            if (response && response.length > 0) {
                const readable = response.toString("utf-8").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
                if (readable.length > 3) console.log(`    readable: ${readable}`);
            }
        }
    }

    // Try with ext_csrf_token  
    console.log("\n── With ext_csrf_token ──\n");
    const md2 = new grpc.Metadata();
    md2.set("x-codeium-csrf-token", target.extCsrfToken);

    for (const method of NEW_METHODS) {
        const short = method.split("/").slice(-2).join("/");
        const { error, response } = await client.callUnary(method, md2, Buffer.alloc(0), 3000);
        if (error) {
            console.log(`  ${short.padEnd(70)} ✗ ${grpc.status[error.code].padEnd(18)} ${error.details?.slice(0, 60)}`);
        } else {
            const len = response?.length ?? 0;
            console.log(`  ${short.padEnd(70)} ✓ OK (${len} bytes)`);
            if (response && response.length > 0) {
                const readable = response.toString("utf-8").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
                if (readable.length > 3) console.log(`    readable: ${readable}`);
            }
        }
    }

    // Also try the "third port" (54753) with insecure 
    console.log("\n── Port ext+2 (insecure) + csrf_token ──\n");
    const insecureClient = new grpc.Client(
        `127.0.0.1:${target.extPort + 2}`,
        grpc.credentials.createInsecure()
    );
    const md3 = new grpc.Metadata();
    md3.set("x-codeium-csrf-token", target.csrfToken);

    for (const method of NEW_METHODS) {
        const short = method.split("/").slice(-2).join("/");
        const result = await new Promise<{ error: any; response: any }>((resolve) => {
            insecureClient.makeUnaryRequest(
                method,
                (arg: Buffer) => arg,
                (arg: Buffer) => arg,
                Buffer.alloc(0),
                md3,
                { deadline: new Date(Date.now() + 3000) },
                (error: any, response: any) => resolve({ error, response })
            );
        });
        if (result.error) {
            console.log(`  ${short.padEnd(70)} ✗ ${grpc.status[result.error.code]?.padEnd(18) ?? result.error.code} ${result.error.details?.slice(0, 60) ?? ""}`);
        } else {
            const len = result.response?.length ?? 0;
            console.log(`  ${short.padEnd(70)} ✓ OK (${len} bytes)`);
        }
    }

    insecureClient.close();
    client.close();
}

main().catch(console.error);

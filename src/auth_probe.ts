/**
 * Probe: extract API key / user status from the language server
 */
import * as grpc from "@grpc/grpc-js";
import { discoverServers } from "./discover.js";
import { extractCert } from "./tls.js";
import { LanguageServerClient } from "./client.js";
import { encodeMessage, encodeString, decodeMessage, printFields } from "./proto.js";

const CSRF_KEY = "x-codeium-csrf-token";

async function main() {
    const s = discoverServers("agynt");
    const t = s[0] ?? discoverServers()[0];
    if (!t) { console.error("No server"); process.exit(1); }

    const cert = await extractCert("127.0.0.1", t.grpcPort);
    const c = new LanguageServerClient(`127.0.0.1:${t.grpcPort}`, cert);
    const md = new grpc.Metadata();
    md.set(CSRF_KEY, t.csrfToken);

    const metadata = Buffer.concat([
        encodeString(1, "ANTIGRAVITY"),
        encodeString(2, "2.0.0"),
    ]);

    // Try various methods that might return auth info
    const methods = [
        ["/exa.language_server_pb.LanguageServerService/GetUserStatus", encodeMessage(1, metadata)],
        ["/exa.language_server_pb.LanguageServerService/GetProfileData", encodeMessage(1, metadata)],
        ["/exa.language_server_pb.LanguageServerService/Heartbeat", encodeMessage(1, metadata)],
    ] as const;

    for (const [method, req] of methods) {
        const name = method.split("/").pop()!;
        console.log(`\n── ${name} ──`);
        const r = await c.callUnary(method, md, req, 5000);
        if (r.error) {
            console.log(`  Error: ${r.error.code} ${r.error.details?.slice(0, 100)}`);
        } else if (r.response && r.response.length > 0) {
            const fields = decodeMessage(r.response);
            // Print all string fields recursively
            function walk(fields: any[], depth = 0) {
                for (const f of fields) {
                    const indent = "  ".repeat(depth + 1);
                    if (f.wireType === 0) {
                        console.log(`${indent}field ${f.fieldNumber} (varint): ${f.value}`);
                    } else if (f.wireType === 2) {
                        const v = f.value as Buffer;
                        const text = v.toString("utf-8");
                        const printable = /^[\x20-\x7e]+$/.test(text);
                        if (printable && text.length < 300 && text.length > 0) {
                            console.log(`${indent}field ${f.fieldNumber} (string): "${text}"`);
                        } else if (f.children) {
                            console.log(`${indent}field ${f.fieldNumber} (message, ${v.length} bytes)`);
                            walk(f.children, depth + 1);
                        } else {
                            console.log(`${indent}field ${f.fieldNumber} (bytes, ${v.length})`);
                        }
                    } else if (f.wireType === 5) {  // 32-bit
                        console.log(`${indent}field ${f.fieldNumber} (fixed32)`);
                    } else if (f.wireType === 1) {  // 64-bit
                        console.log(`${indent}field ${f.fieldNumber} (fixed64)`);
                    }
                }
            }
            console.log(`  Response [${r.response.length} bytes]:`);
            walk(fields);
        } else {
            console.log(`  (empty response)`);
        }
    }
    c.close();
}
main().catch(console.error);

/**
 * Dump: find the AI answer text in the trajectory protobuf structure
 */
import * as grpc from "@grpc/grpc-js";
import { discoverServers } from "./discover.js";
import { extractCert } from "./tls.js";
import { LanguageServerClient } from "./client.js";
import { encodeMessage, encodeString, encodeEnum, decodeMessage, type ProtoField } from "./proto.js";

const CSRF_KEY = "x-codeium-csrf-token";
const START_CASCADE = "/exa.language_server_pb.LanguageServerService/StartCascade";
const SEND_MESSAGE = "/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage";
const GET_TRAJECTORY = "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory";

function buildMetadata(): Buffer {
    return Buffer.concat([encodeString(1, "ANTIGRAVITY"), encodeString(2, "2.0.0")]);
}

async function main() {
    const s = discoverServers("agynt");
    const t = s[0] ?? discoverServers()[0];
    if (!t) process.exit(1);

    const cert = await extractCert("127.0.0.1", t.grpcPort);
    const c = new LanguageServerClient(`127.0.0.1:${t.grpcPort}`, cert);
    const md = new grpc.Metadata();
    md.set(CSRF_KEY, t.csrfToken);

    // StartCascade
    const startReq = encodeMessage(1, buildMetadata());
    const startResult = await c.callUnary(START_CASCADE, md, startReq, 10000);
    if (startResult.error) { console.error("Start failed:", startResult.error.details); process.exit(1); }
    const fields = decodeMessage(startResult.response!);
    let cascadeId = "";
    for (const f of fields) {
        if (f.fieldNumber === 1 && f.wireType === 2) {
            cascadeId = (f.value as Buffer).toString("utf-8");
            break;
        }
    }
    console.log(`cascadeId: ${cascadeId}`);

    // Send with Claude Opus
    const CLAUDE_OPUS = 1026;
    const prompt = "What is a burrito? In one sentence.";
    const modelOrAlias = encodeEnum(1, CLAUDE_OPUS);
    const plannerConfig = Buffer.concat([
        encodeEnum(1, CLAUDE_OPUS),
        encodeMessage(2, Buffer.alloc(0)),
        encodeMessage(15, modelOrAlias),
    ]);
    const sendReq = Buffer.concat([
        encodeString(1, cascadeId),
        encodeMessage(2, encodeString(1, prompt)),
        encodeMessage(3, buildMetadata()),
        encodeMessage(5, encodeMessage(1, plannerConfig)),
    ]);

    const sendResult = await c.callUnary(SEND_MESSAGE, md, sendReq, 10000);
    if (sendResult.error) {
        console.error("Send failed:", sendResult.error.details);
        process.exit(1);
    }
    console.log("Sent! Polling...\n");

    // Wait for response to complete
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const trajResult = await c.callUnary(GET_TRAJECTORY, md, encodeString(1, cascadeId), 10000);
        if (trajResult.error) continue;
        const buf = trajResult.response!;
        console.log(`[${i}] ${buf.length} bytes`);

        if (buf.length > 50000) {
            // Parse the trajectory and find the answer
            const topFields = decodeMessage(buf);

            // Find all text strings > 20 chars that mention "burrito"
            function findBurrito(fields: ProtoField[], path: string = ""): void {
                for (const f of fields) {
                    if (f.wireType === 2) {
                        const v = f.value as Buffer;
                        const text = v.toString("utf-8");
                        if (/burrito/i.test(text) && text.length > 20 && text.length < 2000) {
                            console.log(`\n  PATH: ${path}f${f.fieldNumber}`);
                            console.log(`  TEXT: "${text}"`);
                        }
                    }
                    if (f.children) {
                        findBurrito(f.children, `${path}f${f.fieldNumber}.`);
                    }
                }
            }
            findBurrito(topFields);

            // Also find "model" references
            function findModel(fields: ProtoField[], path: string = ""): void {
                for (const f of fields) {
                    if (f.wireType === 2) {
                        const v = f.value as Buffer;
                        const text = v.toString("utf-8");
                        if (/claude|gemini/i.test(text) && text.length < 100 && text.length > 3) {
                            console.log(`  MODEL REF: ${path}f${f.fieldNumber} = "${text}"`);
                        }
                    }
                    if (f.children) {
                        findModel(f.children, `${path}f${f.fieldNumber}.`);
                    }
                }
            }
            console.log("\n── Model references ──");
            findModel(topFields);

            break;
        }
    }

    c.close();
}
main().catch(console.error);

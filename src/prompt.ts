/**
 * One-shot prompt via the Antigravity language server.
 * Sends "What is a burrito? In one sentence." and parses the response.
 * 
 * Usage: npm run prompt
 */

import * as grpc from "@grpc/grpc-js";
import { discoverServers } from "./discover.js";
import { extractCert } from "./tls.js";
import { LanguageServerClient } from "./client.js";
import {
    encodeString,
    encodeEnum,
    encodeMessage,
    decodeMessage,
    printFields,
    getStringValue,
    findField,
    findAllFields,
    type ProtoField,
} from "./proto.js";

// ── gRPC method paths ───────────────────────────────────────────────

const START_CASCADE = "/exa.language_server_pb.LanguageServerService/StartCascade";
const SEND_MESSAGE = "/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage";
const GET_TRAJECTORY = "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory";
const CSRF_KEY = "x-codeium-csrf-token";

// ── Model enum values (from decoded proto) ──────────────────────────
//
// MODEL_GOOGLE_GEMINI_2_5_PRO = 246
// MODEL_GOOGLE_GEMINI_2_5_FLASH = 312
// MODEL_CLAUDE_4_OPUS_THINKING = 291
// MODEL_CLAUDE_4_SONNET_THINKING = 282
// MODEL_CLAUDE_4_5_SONNET_THINKING = 334

const MODELS: Record<string, number> = {
    "gemini-2.5-pro": 246,
    "gemini-2.5-flash": 312,
    "claude-opus-4.6": 291,
    "claude-sonnet-4.6": 282,
    "claude-4.5-sonnet": 334,
};

const PROMPT = "What is a burrito? In one sentence.";

// ── Protobuf builders (field numbers from decoded proto schemas) ────
//
// StartCascadeRequest:     metadata=1
// StartCascadeResponse:    cascade_id=1
// SendUserCascadeMessageRequest:
//   cascade_id=1, items=2(repeated TextOrScopeItem), metadata=3,
//   experiment_config=4, cascade_config=5(CascadeConfig)
// TextOrScopeItem (oneof):  text=1(string), item=2(ContextScopeItem)
// CascadeConfig:            planner_config=1(CascadePlannerConfig)
// CascadePlannerConfig:     plan_model=1, conversational=2, requested_model=15
// ModelOrAlias (oneof):     model=1(enum), alias=2(enum)
// Metadata:                 ide_name=1, extension_version=2
// ────────────────────────────────────────────────────────────────────

function buildMetadata(): Buffer {
    return Buffer.concat([
        encodeString(1, "ANTIGRAVITY"),
        encodeString(2, "2.0.0"),
    ]);
}

function buildStartCascadeRequest(): Buffer {
    return encodeMessage(1, buildMetadata());
}

function buildTextOrScopeItem(text: string): Buffer {
    return encodeString(1, text); // text = field 1
}

function buildCascadePlannerConfig(modelEnum: number): Buffer {
    const modelOrAlias = encodeEnum(1, modelEnum); // model = field 1 in ModelOrAlias
    return Buffer.concat([
        encodeEnum(1, modelEnum),                     // plan_model = field 1
        encodeMessage(2, Buffer.alloc(0)),             // conversational = field 2 (empty)
        encodeMessage(15, modelOrAlias),               // requested_model = field 15
    ]);
}

function buildCascadeConfig(modelEnum: number): Buffer {
    return encodeMessage(1, buildCascadePlannerConfig(modelEnum));
}

function buildSendRequest(cascadeId: string, prompt: string, modelEnum: number): Buffer {
    return Buffer.concat([
        encodeString(1, cascadeId),                       // cascade_id
        encodeMessage(2, buildTextOrScopeItem(prompt)),   // items (repeated)
        encodeMessage(3, buildMetadata()),                // metadata
        encodeMessage(5, buildCascadeConfig(modelEnum)),  // cascade_config
    ]);
}

function buildGetTrajectoryRequest(cascadeId: string): Buffer {
    return encodeString(1, cascadeId);
}

// ── Response parsing (walk protobuf tree for readable strings) ──────

function collectStrings(fields: ProtoField[], minLen = 4): string[] {
    const strs: string[] = [];
    function walk(fields: ProtoField[]) {
        for (const f of fields) {
            if (f.wireType === 2) {
                const val = f.value as Buffer;
                const text = val.toString("utf-8");
                if (/^[\x20-\x7e\n\r\t]+$/.test(text) && text.length >= minLen) {
                    strs.push(text);
                }
            }
            if (f.children) walk(f.children);
        }
    }
    walk(fields);
    return strs;
}

function findResponseText(strings: string[]): { model: string; response: string; error: string } {
    let model = "";
    let response = "";
    let error = "";

    for (const s of strings) {
        // Detect model name in response
        if (/gemini|claude|gpt/i.test(s) && s.length < 80) {
            if (!model || s.length > model.length) model = s;
        }
        // Detect error messages
        if (/error|UNAVAILABLE|503|retryable|capacity/i.test(s)) {
            if (s.length > error.length) error = s;
        }
    }

    // Find the actual AI answer — typically the longest coherent text
    const candidates = strings
        .filter(s => s.length > 20 && /[a-z]{3,}/.test(s) && !/^[{[<#]/.test(s))
        .filter(s => !s.includes("conversation_summaries") && !s.includes("USER Objective"))
        .filter(s => s.length < 2000)
        .sort((a, b) => b.length - a.length);

    // Look for the answer that's about burritos
    const burritoAnswer = candidates.find(s => /burrito/i.test(s) && s.includes("."));
    response = burritoAnswer ?? candidates[0] ?? "";

    return { model, response, error };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
    console.log("═══ Antigravity One-Shot Prompt ═══\n");
    console.log(`  Prompt: "${PROMPT}"\n`);

    // Discover
    const servers = discoverServers("agynt");
    const target = servers[0] ?? discoverServers()[0];
    if (!target) { console.error("No language server found"); process.exit(1); }
    console.log(`  Server: PID ${target.pid} port ${target.grpcPort}\n`);

    // Connect
    const certPem = await extractCert("127.0.0.1", target.grpcPort);
    const client = new LanguageServerClient(`127.0.0.1:${target.grpcPort}`, certPem);
    const md = new grpc.Metadata();
    md.set(CSRF_KEY, target.csrfToken);

    // 1. StartCascade
    console.log("── StartCascade ──\n");
    const startResult = await client.callUnary(START_CASCADE, md, buildStartCascadeRequest(), 10000);
    if (startResult.error) {
        console.error(`  ✗ ${grpc.status[startResult.error.code]}: ${startResult.error.details}`);
        client.close(); process.exit(1);
    }
    const cascadeId = getStringValue(decodeMessage(startResult.response!), 1) ?? "";
    if (!cascadeId) {
        console.error("  ✗ No cascadeId"); client.close(); process.exit(1);
    }
    console.log(`  ✓ cascadeId: ${cascadeId}\n`);

    // 2. SendUserCascadeMessage — try each model until one works
    console.log("── SendUserCascadeMessage ──\n");

    const modelOrder = [
        ["claude-opus-4.6", "Claude Opus 4.6 (Thinking)"],
        ["gemini-2.5-pro", "Gemini 2.5 Pro"],
        ["gemini-2.5-flash", "Gemini 2.5 Flash"],
        ["claude-sonnet-4.6", "Claude Sonnet 4.6 (Thinking)"],
        ["claude-4.5-sonnet", "Claude 4.5 Sonnet (Thinking)"],
    ] as const;

    let usedModel = "";
    let sent = false;

    for (const [key, label] of modelOrder) {
        const mEnum = MODELS[key];
        console.log(`  → ${label} (${mEnum})...`);
        const result = await client.callUnary(SEND_MESSAGE, md, buildSendRequest(cascadeId, PROMPT, mEnum), 10000);
        if (!result.error) {
            console.log(`    ✓ Accepted!\n`);
            usedModel = label;
            sent = true;
            break;
        }
        const detail = result.error.details ?? "";
        if (detail.includes("model not found") || detail.includes("model key")) {
            console.log(`    ✗ Not available on this server`);
        } else {
            console.log(`    ⚠ ${detail.slice(0, 80)}`);
        }
    }

    if (!sent) {
        console.error("\n  ✗ All models rejected."); client.close(); process.exit(1);
    }

    // 3. Poll GetCascadeTrajectory
    console.log("── Polling for response ──\n");

    const maxAttempts = 30;
    let lastLen = 0;
    let stable = 0;
    let bestStrings: string[] = [];

    for (let i = 1; i <= maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const result = await client.callUnary(GET_TRAJECTORY, md, buildGetTrajectoryRequest(cascadeId), 10000);
        if (result.error) {
            if (i <= 3) console.log(`  [${i}] ${result.error.details?.slice(0, 50)}`);
            continue;
        }
        const allStr = collectStrings(decodeMessage(result.response!), 3);
        const len = allStr.filter(s => s.length > 10).join("").length;

        if (len > 0) {
            bestStrings = allStr;
            console.log(`  [${i}] ${result.response!.length} bytes, ${allStr.length} strings`);
        }

        if (len === lastLen && len > 0) { stable++; } else { stable = 0; lastLen = len; }
        if (stable >= 2 && len > 20) break;
    }

    // 4. Parse and display
    console.log(`\n═══ Result ═══\n`);

    const { model, response, error } = findResponseText(bestStrings);
    console.log(`  Model used: ${usedModel}`);
    if (model) console.log(`  Model (from response): ${model}`);
    if (error) console.log(`  Error: ${error}`);
    if (response) console.log(`\n  Response: ${response}`);
    else console.log(`\n  (No parsed response — raw strings: ${bestStrings.length})`);

    client.close();
    console.log("\n═══ Done ═══");
}

main().catch(console.error);

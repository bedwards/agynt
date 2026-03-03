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

// ── Model enum values (from GetUserStatus response, NOT proto definition) ──
// The proto defines MODEL_CLAUDE_4_OPUS_THINKING=291, but the server actually
// uses MODEL_PLACEHOLDER_M* enum slots. The correct values come from
// GetUserStatus → CommandModelConfigs → model_id field.
const MODELS: Record<string, number> = {
    "claude-opus-4.6": 1026,  // Claude Opus 4.6 (Thinking) — MODEL_PLACEHOLDER_M26
    "claude-sonnet-4.6": 1035,  // Claude Sonnet 4.6 (Thinking) — MODEL_PLACEHOLDER_M35
    "gemini-3-flash": 1018,  // Gemini 3 Flash — MODEL_PLACEHOLDER_M18
    "gemini-2.5-pro": 246,   // Gemini 2.5 Pro (from proto)
    "gemini-2.5-flash": 312,   // Gemini 2.5 Flash (from proto)
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

    // CascadeConversationalPlannerConfig:
    //   planner_mode=4(enum), eval_mode=5(bool), agentic_mode=14(bool)
    // Set agentic_mode = false to disable tools/agent system prompt
    const conversationalConfig = encodeEnum(14, 0); // agentic_mode = false

    return Buffer.concat([
        encodeEnum(1, modelEnum),                     // plan_model = field 1
        encodeMessage(2, conversationalConfig),        // conversational = field 2
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

// ── Response parsing ────────────────────────────────────────────────
// Trajectory protobuf structure (from field analysis):
//   f1 = Trajectory
//   f1.f2 = repeated Step (field 2)
//   f1.f2.f20 = StepResult with answer text:
//     f1.f2.f20.f1 = answer text (string)
//     f1.f2.f20.f8 = answer text (string, duplicate)
//   f1.f3 = CascadeInfo
//     f1.f3.f3.f28 = model name (string, e.g. "claude-opus-4-6-thinking")
//     f1.f3.f1.f19 = model name (string, secondary)

interface ParsedResponse {
    answer: string;
    model: string;
    error: string;
}

function navigateField(fields: ProtoField[], fieldNum: number): ProtoField | undefined {
    return fields.find(f => f.fieldNumber === fieldNum && f.children);
}

function getFieldString(fields: ProtoField[], fieldNum: number): string {
    for (const f of fields) {
        if (f.fieldNumber === fieldNum && f.wireType === 2) {
            const text = (f.value as Buffer).toString("utf-8");
            if (/^[\x20-\x7e\n\r\t]+$/.test(text)) return text;
        }
    }
    return "";
}

function parseTrajectory(buf: Buffer): ParsedResponse {
    const top = decodeMessage(buf);
    let answer = "";
    let model = "";
    let error = "";

    // Navigate to trajectory (f1)
    const trajectory = navigateField(top, 1);
    if (!trajectory?.children) return { answer, model, error };

    // Find model name at f1.f3.f3.f28 or f1.f3.f1.f19
    const cascadeInfo = navigateField(trajectory.children, 3);
    if (cascadeInfo?.children) {
        const sub3 = navigateField(cascadeInfo.children, 3);
        if (sub3?.children) model = getFieldString(sub3.children, 28);  // f1.f3.f3.f28
        if (!model) {
            const sub1 = navigateField(cascadeInfo.children, 1);
            if (sub1?.children) model = getFieldString(sub1.children, 19);  // f1.f3.f1.f19
        }
    }

    // Find answer in steps (f1.f2 repeated) — look at f2.f20.f1
    const steps = trajectory.children.filter(f => f.fieldNumber === 2 && f.children);
    for (const step of steps) {
        const stepResult = navigateField(step.children!, 20);
        if (stepResult?.children) {
            const txt = getFieldString(stepResult.children, 1);  // f1.f2.f20.f1
            if (txt && txt.length > answer.length) answer = txt;
        }
    }

    // Check for errors in all strings
    function walkForErrors(fields: ProtoField[]) {
        for (const f of fields) {
            if (f.wireType === 2) {
                const text = (f.value as Buffer).toString("utf-8");
                if (/503.*capacity|MODEL_CAPACITY_EXHAUSTED|retryable error/i.test(text) && text.length < 500) {
                    if (text.length > error.length) error = text;
                }
            }
            if (f.children) walkForErrors(f.children);
        }
    }
    walkForErrors(top);

    return { answer, model, error };
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
        ["claude-sonnet-4.6", "Claude Sonnet 4.6 (Thinking)"],
        ["gemini-3-flash", "Gemini 3 Flash"],
        ["gemini-2.5-pro", "Gemini 2.5 Pro"],
        ["gemini-2.5-flash", "Gemini 2.5 Flash"],
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
    let parsed: ParsedResponse = { answer: "", model: "", error: "" };

    for (let i = 1; i <= maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const result = await client.callUnary(GET_TRAJECTORY, md, buildGetTrajectoryRequest(cascadeId), 10000);
        if (result.error) {
            if (i <= 3) console.log(`  [${i}] ${result.error.details?.slice(0, 50)}`);
            continue;
        }
        const buf = result.response!;
        const len = buf.length;
        console.log(`  [${i}] ${len} bytes`);

        parsed = parseTrajectory(buf);

        if (len === lastLen && len > 0) { stable++; } else { stable = 0; lastLen = len; }
        if (stable >= 2 && len > 100) break;
        if (parsed.answer) { stable++; if (stable >= 2) break; }
    }

    // 4. Display result
    console.log(`\n═══ Result ═══\n`);
    console.log(`  Model requested: ${usedModel}`);
    if (parsed.model) console.log(`  Model used:      ${parsed.model}`);
    if (parsed.error) console.log(`\n  Error: ${parsed.error.slice(0, 200)}`);
    if (parsed.answer) {
        console.log(`\n  Answer: ${parsed.answer}`);
    } else {
        console.log(`\n  (No answer parsed — response may still be generating)`);
    }

    client.close();
    console.log("\n═══ Done ═══");
}

main().catch(console.error);

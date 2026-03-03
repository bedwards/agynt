/**
 * High-level cascade session wrapper.
 * Reuses the building block modules from src/ — no duplication.
 */
import * as grpc from "@grpc/grpc-js";
import { discoverServers, type ServerInfo } from "../../src/discover.js";
import { extractCert } from "../../src/tls.js";
import { LanguageServerClient } from "../../src/client.js";
import {
    encodeMessage, encodeString, encodeEnum,
    decodeMessage, type ProtoField
} from "../../src/proto.js";

const CSRF_KEY = "x-codeium-csrf-token";
const START_CASCADE = "/exa.language_server_pb.LanguageServerService/StartCascade";
const SEND_MESSAGE = "/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage";
const GET_TRAJECTORY = "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory";

// ── Known model enum values (from GetUserStatus) ────────────────────
// Only models verified to work with the cascade pipeline.
// Gemini 2.5 Pro/Flash fail: cascade sends multi-tool agentic system prompt
// they can't handle ("Multiple tools not supported").
export const MODELS: Record<string, { enum: number; label: string }> = {
    "claude-opus-4.6": { enum: 1026, label: "Claude Opus 4.6 (Thinking)" },
    "claude-sonnet-4.6": { enum: 1035, label: "Claude Sonnet 4.6 (Thinking)" },
    "gemini-3-flash": { enum: 1018, label: "Gemini 3 Flash" },
};

export const DEFAULT_MODEL = "claude-opus-4.6";

// ── Protobuf helpers ────────────────────────────────────────────────

function buildMetadata(): Buffer {
    return Buffer.concat([
        encodeString(1, "ANTIGRAVITY"),
        encodeString(2, "2.0.0"),
    ]);
}

function buildPlannerConfig(modelEnum: number): Buffer {
    const modelOrAlias = encodeEnum(1, modelEnum);
    const conversationalConfig = encodeEnum(14, 0); // agentic_mode = false
    return Buffer.concat([
        encodeEnum(1, modelEnum),
        encodeMessage(2, conversationalConfig),
        encodeMessage(15, modelOrAlias),
    ]);
}

function buildSendRequest(cascadeId: string, prompt: string, modelEnum: number): Buffer {
    return Buffer.concat([
        encodeString(1, cascadeId),
        encodeMessage(2, encodeString(1, prompt)),
        encodeMessage(3, buildMetadata()),
        encodeMessage(5, encodeMessage(1, buildPlannerConfig(modelEnum))),
    ]);
}

// ── Response parser ─────────────────────────────────────────────────

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

export interface CascadeResult {
    answer: string;
    model: string;
    error: string;
    done: boolean;
    bytes: number;
}

function parseTrajectory(buf: Buffer): CascadeResult {
    const top = decodeMessage(buf);
    let answer = "";
    let model = "";
    let error = "";

    const trajectory = navigateField(top, 1);
    if (!trajectory?.children) return { answer, model, error, done: false, bytes: buf.length };

    // Model name at f1.f3.f3.f28 or f1.f3.f1.f19
    const cascadeInfo = navigateField(trajectory.children, 3);
    if (cascadeInfo?.children) {
        const sub3 = navigateField(cascadeInfo.children, 3);
        if (sub3?.children) model = getFieldString(sub3.children, 28);
        if (!model) {
            const sub1 = navigateField(cascadeInfo.children, 1);
            if (sub1?.children) model = getFieldString(sub1.children, 19);
        }
    }

    // Answer at f1.f2(steps).f20(step_result).f1(text)
    const steps = trajectory.children.filter((f: ProtoField) => f.fieldNumber === 2 && f.children);
    for (const step of steps) {
        const stepResult = navigateField(step.children!, 20);
        if (stepResult?.children) {
            const txt = getFieldString(stepResult.children, 1);
            if (txt && txt.length > answer.length) answer = txt;
        }
    }

    // Error detection — must be strict to avoid false positives from
    // terminal output, system prompts, and other trajectory strings.
    function walkForErrors(fields: ProtoField[]) {
        for (const f of fields) {
            if (f.wireType === 2) {
                const text = (f.value as Buffer).toString("utf-8");
                // Only match structured error messages, not random strings
                if (text.length > 20 && text.length < 300) {
                    // JSON error objects from the backend
                    if (/"code":\s*503/.test(text) && /"message"/.test(text)) {
                        // Extract just the message field for cleaner display
                        const msgMatch = text.match(/"message":\s*"([^"]+)"/);
                        const errorText = msgMatch?.[1] ?? text;
                        if (errorText.length > error.length) error = errorText;
                    }
                    // Specific multi-word error phrases
                    else if (/No capacity available for model/.test(text)) {
                        if (text.length > error.length) error = text;
                    }
                    else if (/MODEL_CAPACITY_EXHAUSTED/.test(text)) {
                        if (text.length > error.length) error = text;
                    }
                }
            }
            if (f.children) walkForErrors(f.children);
        }
    }
    walkForErrors(top);

    const done = answer.length > 0 || error.length > 0;
    return { answer, model, error, done, bytes: buf.length };
}

// ── CascadeSession ──────────────────────────────────────────────────

export class CascadeSession {
    private client: LanguageServerClient | null = null;
    private metadata: grpc.Metadata | null = null;
    private server: ServerInfo | null = null;
    private cascadeId = "";
    private _connected = false;

    get connected() { return this._connected; }
    get currentCascadeId() { return this.cascadeId; }

    /** Connect to the language server */
    async connect(workspaceHint?: string): Promise<ServerInfo> {
        const servers = workspaceHint
            ? discoverServers(workspaceHint)
            : discoverServers();
        const target = servers[0];
        if (!target) throw new Error("No Antigravity language server found. Is the IDE running?");

        const certPem = await extractCert("127.0.0.1", target.grpcPort);
        this.client = new LanguageServerClient(`127.0.0.1:${target.grpcPort}`, certPem);
        this.metadata = new grpc.Metadata();
        this.metadata.set(CSRF_KEY, target.csrfToken);
        this.server = target;
        this._connected = true;
        return target;
    }

    /** Start a new cascade session */
    async startCascade(): Promise<string> {
        if (!this.client || !this.metadata) throw new Error("Not connected");
        const req = encodeMessage(1, buildMetadata());
        const result = await this.client.callUnary(START_CASCADE, this.metadata, req, 10000);
        if (result.error) throw new Error(`StartCascade failed: ${result.error.details}`);

        const fields = decodeMessage(result.response!);
        for (const f of fields) {
            if (f.fieldNumber === 1 && f.wireType === 2) {
                this.cascadeId = (f.value as Buffer).toString("utf-8");
                return this.cascadeId;
            }
        }
        throw new Error("No cascadeId in response");
    }

    /** Send a message with model selection. Returns true if accepted. */
    async sendMessage(prompt: string, modelKey: string): Promise<{ accepted: boolean; error?: string }> {
        if (!this.client || !this.metadata) throw new Error("Not connected");
        const model = MODELS[modelKey];
        if (!model) throw new Error(`Unknown model: ${modelKey}`);

        const req = buildSendRequest(this.cascadeId, prompt, model.enum);
        const result = await this.client.callUnary(SEND_MESSAGE, this.metadata, req, 15000);

        if (result.error) {
            return { accepted: false, error: result.error.details ?? "Unknown error" };
        }
        return { accepted: true };
    }

    /** Send with fallback — tries models in order until one accepts */
    async sendWithFallback(prompt: string, preferredModel: string): Promise<{ model: string; error?: string }> {
        const order = [preferredModel, ...Object.keys(MODELS).filter(k => k !== preferredModel)];
        for (const key of order) {
            const result = await this.sendMessage(prompt, key);
            if (result.accepted) return { model: key };
            if (result.error?.includes("model not found") || result.error?.includes("model key")) continue;
            return { model: key, error: result.error };
        }
        return { model: "", error: "All models rejected" };
    }

    /** Poll for response. Calls onUpdate with each parse result. */
    async pollResponse(onUpdate?: (result: CascadeResult) => void): Promise<CascadeResult> {
        if (!this.client || !this.metadata) throw new Error("Not connected");

        let lastLen = 0;
        let stable = 0;
        let best: CascadeResult = { answer: "", model: "", error: "", done: false, bytes: 0 };

        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 1500));
            const req = encodeString(1, this.cascadeId);
            const result = await this.client.callUnary(GET_TRAJECTORY, this.metadata!, req, 10000);
            if (result.error) continue;

            best = parseTrajectory(result.response!);
            onUpdate?.(best);

            if (best.bytes === lastLen && best.bytes > 0) stable++;
            else { stable = 0; lastLen = best.bytes; }

            if (best.done && stable >= 1) break;
            if (stable >= 3) break;
        }

        return best;
    }

    /** Clean up */
    close() {
        this.client?.close();
        this._connected = false;
    }
}

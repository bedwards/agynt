#!/usr/bin/env bun
/**
 * agynt-serve — OpenAI-compatible API server
 *
 * Proxies to Claude/Gemini via the Antigravity language server.
 * Use with OpenCode or any OpenAI-compatible client.
 *
 *   bun run cli/server/index.ts
 *   PORT=8080 bun run cli/server/index.ts
 */
import { CascadeSession, MODELS } from "../core/cascade.js";

const PORT = parseInt(process.env.PORT ?? "8462", 10);
const DEFAULT_MODEL = "claude-opus-4.6";

function resolveModel(name?: string): string | null {
    const id = name ?? DEFAULT_MODEL;
    if (id === "agynt") return DEFAULT_MODEL;
    if (MODELS[id]) return id;
    return null;
}

// ── OpenAI response format ──────────────────────────────────────────

function completion(id: string, content: string, model: string) {
    return {
        id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}

function chunk(id: string, content: string, model: string, done: boolean) {
    return {
        id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: done ? {} : { role: "assistant", content }, finish_reason: done ? "stop" : null }],
    };
}

function modelsResponse() {
    const ts = Math.floor(Date.now() / 1000);
    const data = Object.keys(MODELS).map(id => ({ id, object: "model" as const, created: ts, owned_by: "agynt" }));
    data.push({ id: "agynt", object: "model", created: ts, owned_by: "agynt" });
    return { object: "list", data };
}

function errJson(status: number, message: string) {
    return Response.json({ error: { message, type: "server_error", code: status } }, { status, headers: cors() });
}

function cors(): Record<string, string> {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
}

// ── Prompt extraction ───────────────────────────────────────────────

interface Msg { role: string; content: string; }

function extractPrompt(messages: Msg[]): string {
    const users = messages.filter(m => m.role === "user");
    if (!users.length) return "";
    if (messages.length > 2) {
        return messages.filter(m => m.role !== "system")
            .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
            .join("\n\n");
    }
    return users[users.length - 1].content;
}

// ── Handler ─────────────────────────────────────────────────────────

async function handleChat(req: Request): Promise<Response> {
    const body = await req.json() as { model?: string; messages: Msg[]; stream?: boolean };

    const prompt = extractPrompt(body.messages);
    if (!prompt) return errJson(400, "No user message");

    const modelKey = resolveModel(body.model);
    if (!modelKey) return errJson(400, `Unknown model: ${body.model}. Available: ${Object.keys(MODELS).join(", ")}, agynt`);

    const id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
    const session = new CascadeSession();

    try {
        await session.connect();
        await session.startCascade();

        const send = await session.sendWithFallback(prompt, modelKey);
        if (send.error) {
            session.close();
            return /capacity|503/i.test(send.error) ? errJson(503, "Model at capacity") : errJson(500, send.error);
        }

        if (body.stream) {
            const enc = new TextEncoder();
            let last = "";
            const stream = new ReadableStream({
                async start(ctrl) {
                    try {
                        const init = chunk(id, "", modelKey, false);
                        init.choices[0].delta = { role: "assistant", content: "" };
                        ctrl.enqueue(enc.encode(`data: ${JSON.stringify(init)}\n\n`));

                        const result = await session.pollResponse((r) => {
                            if (r.answer && r.answer.length > last.length) {
                                const d = r.answer.slice(last.length);
                                last = r.answer;
                                ctrl.enqueue(enc.encode(`data: ${JSON.stringify(chunk(id, d, modelKey, false))}\n\n`));
                            }
                        });
                        if (result.answer && result.answer.length > last.length) {
                            ctrl.enqueue(enc.encode(`data: ${JSON.stringify(chunk(id, result.answer.slice(last.length), modelKey, false))}\n\n`));
                        }
                        ctrl.enqueue(enc.encode(`data: ${JSON.stringify(chunk(id, "", modelKey, true))}\n\n`));
                        ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
                        ctrl.close();
                    } catch (e: any) { ctrl.error(e); }
                    finally { session.close(); }
                },
            });
            return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...cors() } });
        } else {
            const result = await session.pollResponse();
            session.close();
            if (result.error) return /capacity|503/i.test(result.error) ? errJson(503, "Model at capacity") : errJson(500, result.error);
            if (!result.answer) return errJson(500, "No response");
            return Response.json(completion(id, result.answer, modelKey), { headers: cors() });
        }
    } catch (e: any) {
        session.close();
        return errJson(500, e.message);
    }
}

// ── Server ──────────────────────────────────────────────────────────

const models = Object.keys(MODELS).join(", ");
console.log(`
  agynt-serve — http://localhost:${PORT}
  Models: ${models}, agynt
`);

try {
    Bun.serve({
        port: PORT,
        async fetch(req) {
            const url = new URL(req.url);
            if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
            if (url.pathname === "/v1/chat/completions" && req.method === "POST") return handleChat(req);
            if (url.pathname === "/v1/models" && req.method === "GET") return Response.json(modelsResponse(), { headers: cors() });
            if (url.pathname === "/health" || url.pathname === "/") return Response.json({ status: "ok", models, version: "0.1.0" }, { headers: cors() });
            return errJson(404, `Not found: ${url.pathname}`);
        },
    });
} catch (e: any) {
    if (e?.code === "EADDRINUSE") {
        console.error(`  ✗ Port ${PORT} in use. Kill: lsof -ti:${PORT} | xargs kill`);
    } else {
        console.error(`  ✗ ${e.message}`);
    }
    process.exit(1);
}

#!/usr/bin/env bun
/**
 * agynt-serve — OpenAI-compatible API server for Claude Opus 4.6
 *
 * Proxies requests through the Antigravity language server cascade pipeline.
 * Compatible with OpenCode, Continue, and any OpenAI-compatible client.
 *
 * Usage:
 *   bun run cli/server/index.ts              # Start on default port 4141
 *   PORT=8080 bun run cli/server/index.ts    # Custom port
 */
import { CascadeSession, MODELS } from "../core/cascade.js";

const PORT = parseInt(process.env.PORT ?? "4141", 10);
const MODEL_ID = "claude-opus-4.6";
const MODEL_INFO = MODELS[MODEL_ID];

// ── OpenAI response types ───────────────────────────────────────────

function chatCompletionResponse(id: string, content: string, model: string) {
    return {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}

function chatCompletionChunk(id: string, content: string, model: string, done: boolean) {
    return {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            delta: done ? {} : { role: "assistant", content },
            finish_reason: done ? "stop" : null,
        }],
    };
}

function modelsResponse() {
    return {
        object: "list",
        data: [{
            id: MODEL_ID,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "antigravity",
        }],
    };
}

function errorResponse(status: number, message: string) {
    return Response.json(
        { error: { message, type: "server_error", code: status } },
        { status, headers: corsHeaders() },
    );
}

function corsHeaders(): Record<string, string> {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
}

// ── Prompt extraction ───────────────────────────────────────────────

interface ChatMessage {
    role: string;
    content: string;
}

function extractPrompt(messages: ChatMessage[]): string {
    // For the cascade pipeline, we send the full conversation as a single prompt.
    // The cascade handles its own system prompt, so we just concatenate user messages.
    // For simple single-turn, just use the last user message.
    const userMessages = messages.filter(m => m.role === "user");
    if (userMessages.length === 0) return "";

    // If there's a system message, prepend it
    const systemMsg = messages.find(m => m.role === "system");
    const lastUser = userMessages[userMessages.length - 1].content;

    if (systemMsg && messages.length > 2) {
        // Multi-turn: include context
        return messages
            .filter(m => m.role !== "system")
            .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
            .join("\n\n");
    }

    return lastUser;
}

// ── Request handler ─────────────────────────────────────────────────

async function handleChatCompletion(req: Request): Promise<Response> {
    const body = await req.json() as {
        model?: string;
        messages: ChatMessage[];
        stream?: boolean;
    };

    const prompt = extractPrompt(body.messages);
    if (!prompt) return errorResponse(400, "No user message found");

    const requestId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
    const session = new CascadeSession();

    try {
        await session.connect();
        await session.startCascade();

        const sendResult = await session.sendWithFallback(prompt, MODEL_ID);
        if (sendResult.error) {
            session.close();
            if (/capacity|503/i.test(sendResult.error)) {
                return errorResponse(503, "Model at capacity. Try again shortly.");
            }
            return errorResponse(500, sendResult.error);
        }

        const usedModelLabel = MODELS[sendResult.model]?.label ?? sendResult.model;

        if (body.stream) {
            // ── Streaming SSE response ──
            const encoder = new TextEncoder();
            let lastAnswer = "";

            const stream = new ReadableStream({
                async start(controller) {
                    try {
                        // Send initial role chunk
                        const initChunk = chatCompletionChunk(requestId, "", MODEL_ID, false);
                        initChunk.choices[0].delta = { role: "assistant", content: "" };
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(initChunk)}\n\n`));

                        // Poll and stream deltas
                        const result = await session.pollResponse((r) => {
                            if (r.answer && r.answer.length > lastAnswer.length) {
                                const delta = r.answer.slice(lastAnswer.length);
                                lastAnswer = r.answer;
                                const chunk = chatCompletionChunk(requestId, delta, MODEL_ID, false);
                                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                            }
                        });

                        // Final content if any remaining
                        if (result.answer && result.answer.length > lastAnswer.length) {
                            const delta = result.answer.slice(lastAnswer.length);
                            const chunk = chatCompletionChunk(requestId, delta, MODEL_ID, false);
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                        }

                        // Done
                        const doneChunk = chatCompletionChunk(requestId, "", MODEL_ID, true);
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();
                    } catch (e: any) {
                        controller.error(e);
                    } finally {
                        session.close();
                    }
                },
            });

            return new Response(stream, {
                status: 200,
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    ...corsHeaders(),
                },
            });
        } else {
            // ── Non-streaming response ──
            const result = await session.pollResponse();
            session.close();

            if (result.error) {
                if (/capacity|503/i.test(result.error)) {
                    return errorResponse(503, "Model at capacity. Try again shortly.");
                }
                return errorResponse(500, result.error);
            }

            if (!result.answer) {
                return errorResponse(500, "No response from model");
            }

            return Response.json(
                chatCompletionResponse(requestId, result.answer, MODEL_ID),
                { headers: corsHeaders() },
            );
        }
    } catch (e: any) {
        session.close();
        return errorResponse(500, e.message);
    }
}

// ── Bun HTTP server ─────────────────────────────────────────────────

console.log(`
  agynt-serve — OpenAI-compatible API server
  ──────────────────────────────────────────
  Model:    ${MODEL_INFO.label}
  Endpoint: http://localhost:${PORT}/v1/chat/completions
  Models:   http://localhost:${PORT}/v1/models

  Use with OpenCode:
    export OPENAI_API_BASE=http://localhost:${PORT}/v1
    export OPENAI_API_KEY=agynt

  Ctrl+C to stop.
`);

try {
    Bun.serve({
        port: PORT,
        async fetch(req) {
            const url = new URL(req.url);

            // CORS preflight
            if (req.method === "OPTIONS") {
                return new Response(null, { status: 204, headers: corsHeaders() });
            }

            // Routes
            if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
                return handleChatCompletion(req);
            }

            if (url.pathname === "/v1/models" && req.method === "GET") {
                return Response.json(modelsResponse(), { headers: corsHeaders() });
            }

            // Health check
            if (url.pathname === "/health" || url.pathname === "/") {
                return Response.json(
                    { status: "ok", model: MODEL_ID, version: "0.1.0" },
                    { headers: corsHeaders() },
                );
            }

            return errorResponse(404, `Not found: ${url.pathname}`);
        },
    });
} catch (e: any) {
    if (e?.code === "EADDRINUSE") {
        console.error(`\n  ✗ Port ${PORT} is already in use.`);
        console.error(`    Kill it:  lsof -ti:${PORT} | xargs kill`);
        console.error(`    Or use:   PORT=8080 npm run serve\n`);
    } else {
        console.error(`\n  ✗ Failed to start: ${e.message}\n`);
    }
    process.exit(1);
}

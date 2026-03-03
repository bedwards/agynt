/**
 * Interactive TUI — Ink-based multi-turn conversation.
 */
import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { CascadeSession, MODELS, DEFAULT_MODEL, type CascadeResult } from "../core/cascade.js";

// ── Types ───────────────────────────────────────────────────────────

interface Message {
    role: "user" | "assistant" | "system";
    text: string;
}

type AppState = "connecting" | "ready" | "sending" | "thinking" | "error";

// ── Spinner ─────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function Spinner({ label }: { label: string }) {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 80);
        return () => clearInterval(id);
    }, []);
    return (
        <Text color="cyan">
            {SPINNER_FRAMES[frame]} {label}
        </Text>
    );
}

// ── Main App ────────────────────────────────────────────────────────

function App({ modelKey, verbose }: { modelKey: string; verbose: boolean }) {
    const { exit } = useApp();
    const [state, setState] = useState<AppState>("connecting");
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [statusText, setStatusText] = useState("Connecting...");
    const [session] = useState(() => new CascadeSession());
    const [usedModel, setUsedModel] = useState(MODELS[modelKey]?.label ?? modelKey);
    const [errorMsg, setErrorMsg] = useState("");

    // Connect on mount
    useEffect(() => {
        (async () => {
            try {
                const server = await session.connect();
                setStatusText(`Connected — PID ${server.pid}`);
                setState("ready");
            } catch (e: any) {
                setErrorMsg(e.message);
                setState("error");
            }
        })();
        return () => session.close();
    }, []);

    // Handle Ctrl+C
    useInput((input, key) => {
        if (key.ctrl && input === "c") {
            session.close();
            exit();
        }
    });

    // Submit prompt
    const handleSubmit = useCallback(async (value: string) => {
        const prompt = value.trim();
        if (!prompt || state !== "ready") return;

        setInput("");
        setMessages(prev => [...prev, { role: "user", text: prompt }]);
        setState("sending");
        setStatusText("Starting cascade...");

        try {
            await session.startCascade();
            setState("thinking");
            setStatusText(`Sending to ${usedModel}...`);

            const sendResult = await session.sendWithFallback(prompt, modelKey);
            if (sendResult.error) {
                setMessages(prev => [...prev, { role: "system", text: `Error: ${sendResult.error}` }]);
                setState("ready");
                setStatusText("Ready");
                return;
            }

            const label = MODELS[sendResult.model]?.label ?? sendResult.model;
            setUsedModel(label);
            setStatusText(`${label} is thinking...`);

            const result = await session.pollResponse((r) => {
                if (r.bytes > 0) setStatusText(`${label} is thinking...`);
            });

            if (result.answer) {
                setMessages(prev => [...prev, { role: "assistant", text: result.answer }]);
                if (result.model) setUsedModel(result.model);
            } else if (result.error) {
                const msg = /capacity|503/i.test(result.error)
                    ? "Model at capacity. Try again in a moment."
                    : result.error.slice(0, 200);
                setMessages(prev => [...prev, { role: "system", text: msg }]);
            } else {
                setMessages(prev => [...prev, { role: "system", text: "No response received." }]);
            }

            setState("ready");
            setStatusText("Ready");
        } catch (e: any) {
            setMessages(prev => [...prev, { role: "system", text: `Error: ${e.message}` }]);
            setState("ready");
            setStatusText("Ready");
        }
    }, [state, modelKey, session, usedModel]);

    return (
        <Box flexDirection="column" width="100%">
            {/* Header */}
            <Box marginBottom={1}>
                <Text bold color="cyan">agynt</Text>
                <Text color="gray"> • </Text>
                <Text color="white">{usedModel}</Text>
            </Box>

            {/* Messages */}
            {messages.map((msg, i) => (
                <Box key={i} marginBottom={1} flexDirection="column">
                    {msg.role === "user" ? (
                        <Box>
                            <Text bold color="green">❯ </Text>
                            <Text>{msg.text}</Text>
                        </Box>
                    ) : msg.role === "assistant" ? (
                        <Box flexDirection="column">
                            <Text color="white">{msg.text}</Text>
                        </Box>
                    ) : (
                        <Text color="yellow">{msg.text}</Text>
                    )}
                </Box>
            ))}

            {/* Thinking indicator */}
            {(state === "sending" || state === "thinking") && (
                <Box marginBottom={1}>
                    <Spinner label={statusText} />
                </Box>
            )}

            {/* Error state */}
            {state === "error" && (
                <Box marginBottom={1}>
                    <Text color="red">✗ {errorMsg}</Text>
                </Box>
            )}

            {/* Input */}
            {state === "ready" && (
                <Box>
                    <Text bold color="green">❯ </Text>
                    <TextInput
                        value={input}
                        onChange={setInput}
                        onSubmit={handleSubmit}
                        placeholder="Ask anything... (Ctrl+C to exit)"
                    />
                </Box>
            )}

            {/* Status bar */}
            <Box marginTop={1}>
                <Text color="gray" dimColor>
                    {usedModel} • {state === "ready" ? "ready" : statusText}
                </Text>
            </Box>
        </Box>
    );
}

// ── Export render function ───────────────────────────────────────────

export function runTUI(modelKey: string, verbose: boolean) {
    render(
        React.createElement(App, { modelKey, verbose }),
        { exitOnCtrlC: true }
    );
}

#!/usr/bin/env bun
/**
 * agynt — Talk to Claude Opus 4.6 from your terminal.
 *
 * Usage:
 *   agynt                         # Interactive TUI
 *   agynt "your prompt here"      # One-shot mode
 *   agynt --list-models           # Show available models
 */
import { Command } from "commander";
import { MODELS, DEFAULT_MODEL } from "./core/cascade.js";
import { runOneShot } from "./oneshot/run.js";

const VERSION = "0.1.0";

const program = new Command()
    .name("agynt")
    .version(VERSION)
    .description("Talk to Claude Opus 4.6 from your terminal — powered by Antigravity")
    .argument("[prompt...]", "Prompt to send (one-shot mode)")
    .option("-m, --model <model>", "Model to use", DEFAULT_MODEL)
    .option("-v, --verbose", "Show debug info", false)
    .option("-l, --list-models", "List available models")
    .action(async (promptParts: string[], options: { model: string; verbose: boolean; listModels?: boolean }) => {
        // --list-models
        if (options.listModels) {
            console.log("\nAvailable models:\n");
            for (const [key, m] of Object.entries(MODELS)) {
                const marker = key === DEFAULT_MODEL ? " (default)" : "";
                console.log(`  ${key.padEnd(22)} ${m.label}${marker}`);
            }
            console.log("\nUse: agynt --model <model-key> \"your prompt\"\n");
            process.exit(0);
        }

        const prompt = promptParts.join(" ").trim();

        if (prompt) {
            // One-shot mode
            await runOneShot(prompt, options.model, options.verbose);
        } else {
            // Interactive TUI mode
            const { runTUI } = await import("./tui/app.js");
            runTUI(options.model, options.verbose);
        }
    });

program.parse();

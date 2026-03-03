/**
 * One-shot mode: send a prompt, print the answer, exit.
 * Clean output suitable for piping.
 */
import chalk from "chalk";
import { CascadeSession, MODELS, DEFAULT_MODEL } from "../core/cascade.js";

export async function runOneShot(prompt: string, modelKey: string, verbose: boolean) {
    const session = new CascadeSession();

    try {
        // Connect
        if (verbose) process.stderr.write(chalk.dim("Connecting...\n"));
        const server = await session.connect();
        if (verbose) process.stderr.write(chalk.dim(`  Server: PID ${server.pid} port ${server.grpcPort}\n`));

        // Start cascade
        if (verbose) process.stderr.write(chalk.dim("Starting cascade...\n"));
        await session.startCascade();

        // Send prompt
        const modelLabel = MODELS[modelKey]?.label ?? modelKey;
        if (verbose) process.stderr.write(chalk.dim(`  Model: ${modelLabel}\n`));

        const sendResult = await session.sendWithFallback(prompt, modelKey);
        if (sendResult.error) {
            process.stderr.write(chalk.red(`Error: ${sendResult.error}\n`));
            process.exit(1);
        }

        const usedLabel = MODELS[sendResult.model]?.label ?? sendResult.model;
        if (verbose) process.stderr.write(chalk.dim(`  Accepted: ${usedLabel}\n`));

        // Poll for response
        if (verbose) process.stderr.write(chalk.dim("Waiting for response...\n"));
        const result = await session.pollResponse(verbose ? (r) => {
            process.stderr.write(chalk.dim(`  [${r.bytes} bytes]\n`));
        } : undefined);

        // Output
        if (result.error) {
            if (/capacity|503|UNAVAILABLE/i.test(result.error)) {
                process.stderr.write(chalk.yellow(`Model at capacity. Try again in a moment, or use --model gemini-3-flash\n`));
            } else {
                process.stderr.write(chalk.red(`Error: ${result.error.slice(0, 200)}\n`));
            }
            process.exit(1);
        }

        if (result.answer) {
            // Answer goes to stdout (pipeable)
            process.stdout.write(result.answer + "\n");

            if (verbose) {
                process.stderr.write(chalk.dim(`\n  Model: ${result.model}\n`));
            }
        } else {
            process.stderr.write(chalk.yellow("No answer received. Try again.\n"));
            process.exit(1);
        }
    } finally {
        session.close();
    }
}

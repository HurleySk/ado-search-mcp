import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdoSearchConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number;
  killed?: boolean;
}

function isExecError(err: unknown): err is ExecError {
  return err instanceof Error && ("code" in err || "killed" in err);
}

export async function runAdoSearch(
  config: AdoSearchConfig,
  args: string[],
  options?: { timeout?: number },
): Promise<CliResult> {
  const exe = config.adoSearchPath;
  const fullArgs = [...args, "--data-dir", config.dataDir];
  try {
    const { stdout, stderr } = await execFileAsync(exe, fullArgs, {
      timeout: options?.timeout ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    if (isExecError(err)) {
      if (err.killed) {
        return { stdout: "", stderr: "Command timed out", exitCode: -1 };
      }
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        exitCode: typeof err.code === "number" ? err.code : 1,
      };
    }
    throw err;
  }
}

export function parseJsonOutput(result: CliResult): unknown {
  if (result.exitCode !== 0) {
    if (isNoResults(result)) return [];
    throw new Error(result.stderr || result.stdout || `CLI exited with code ${result.exitCode}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Failed to parse JSON output: ${result.stdout.slice(0, 500)}`);
  }
}

function isNoResults(result: CliResult): boolean {
  return result.exitCode === 1 && result.stderr.trim() === "";
}

/** stdout plus any stderr notes (e.g. the CLI's mention report) from a successful run. */
export function cliOutput(result: CliResult): string {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
}

export function toMcpResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function toMcpText(output: string) {
  return {
    content: [{ type: "text" as const, text: output }],
  };
}

export function toMcpError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true as const,
  };
}

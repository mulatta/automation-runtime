import { spawn } from "child_process";

export type CommandResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type RunCommandOptions = {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  maxOutputBytes?: number;
};

export class CommandError extends Error {
  readonly result: CommandResult;

  constructor(result: CommandResult) {
    super(formatCommandError(result));
    this.name = "CommandError";
    this.result = result;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const argv = [...args];

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      const captured = appendLimited(
        stdout,
        stdoutBytes,
        chunk,
        maxOutputBytes,
      );
      stdout = captured.text;
      stdoutBytes = captured.bytes;
    });
    child.stderr.on("data", (chunk: string) => {
      const captured = appendLimited(
        stderr,
        stderrBytes,
        chunk,
        maxOutputBytes,
      );
      stderr = captured.text;
      stderrBytes = captured.bytes;
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result: CommandResult = {
        command,
        args: argv,
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr || error.message,
        timedOut,
      };
      reject(new CommandError(result));
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result: CommandResult = {
        command,
        args: argv,
        exitCode,
        signal,
        stdout,
        stderr: timedOut
          ? appendTimeoutMessage(stderr, timeoutMs, maxOutputBytes)
          : stderr,
        timedOut,
      };
      if (exitCode === 0 && !timedOut) {
        resolve(result);
      } else {
        reject(new CommandError(result));
      }
    });
  });
}

function appendLimited(
  current: string,
  currentBytes: number,
  chunk: string,
  maxBytes: number,
): { text: string; bytes: number } {
  if (currentBytes >= maxBytes) {
    return { text: current, bytes: currentBytes };
  }

  const remaining = maxBytes - currentBytes;
  const chunkBytes = Buffer.byteLength(chunk);
  if (chunkBytes <= remaining) {
    return { text: current + chunk, bytes: currentBytes + chunkBytes };
  }

  return {
    text: current + Buffer.from(chunk).subarray(0, remaining).toString("utf8"),
    bytes: maxBytes,
  };
}

function appendTimeoutMessage(
  stderr: string,
  timeoutMs: number,
  maxBytes: number,
): string {
  const suffix = `\ntimed out after ${timeoutMs}ms`;
  return appendLimited(stderr, Buffer.byteLength(stderr), suffix, maxBytes)
    .text;
}

function formatCommandError(result: CommandResult): string {
  const status = result.timedOut
    ? "timed out"
    : `exited with ${result.exitCode ?? result.signal ?? "unknown status"}`;
  return `${result.command} ${result.args.join(" ")} ${status}`;
}

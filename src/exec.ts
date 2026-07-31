/**
 * Process execution primitives.
 *
 * Every child process flashover starts goes through here, which centralizes two
 * things that are easy to get wrong:
 *
 *  1. **Timeouts kill the whole process tree.** Coding agents spawn their own
 *     children (language servers, test runners, package managers). Killing only
 *     the direct child leaves orphans holding the worktree open, which then
 *     makes `git worktree remove` fail. Children are therefore spawned in their
 *     own process group and the group is signalled as a unit.
 *  2. **Output is captured with a bound.** An agent stuck in a retry loop can
 *     emit gigabytes. Buffers are capped, keeping the most recent output, which
 *     is the part that explains a failure.
 */

import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

/** Default cap on retained stdout/stderr per process. */
const DEFAULT_MAX_BUFFER_CHARS = 256 * 1024;

/** Grace period between SIGTERM and SIGKILL when a timeout fires. */
const KILL_GRACE_MS = 3000;

export interface ExecOptions {
  cwd: string;
  /** Variables layered on top of `process.env`. `undefined` unsets a variable. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Kill the process tree after this many milliseconds. Omit for no limit. */
  timeoutMs?: number;
  /** Written to stdin, which is then closed. When omitted, stdin is /dev/null. */
  input?: string;
  /** Streaming hook, called with each decoded stdout chunk. */
  onStdout?: (chunk: string) => void;
  /** Streaming hook, called with each decoded stderr chunk. */
  onStderr?: (chunk: string) => void;
  /** Cap on retained output per stream. */
  maxBufferChars?: number;
  /** Abort the process early, e.g. on Ctrl-C. */
  signal?: AbortSignal;
}

export interface ExecResult {
  /** The command line, for error messages and logs. */
  command: string;
  /** Exit code, or null when the process was killed by a signal. */
  code: number | null;
  /** Terminating signal, when applicable. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when flashover killed the process for exceeding its timeout. */
  timedOut: boolean;
  durationMs: number;
  /** Set when the binary could not be launched at all, e.g. ENOENT. */
  spawnError?: string;
}

/** True when the process finished normally with exit status 0. */
export function succeeded(result: ExecResult): boolean {
  return result.code === 0 && result.spawnError === undefined;
}

/** A single-line description of why a process failed, suitable for a report. */
export function describeFailure(result: ExecResult): string {
  if (result.spawnError !== undefined) return result.spawnError;
  if (result.timedOut) return 'timed out';
  if (result.signal !== null) return `killed by ${result.signal}`;
  return `exit code ${String(result.code)}`;
}

/**
 * Spawn `command` with `args`, without a shell.
 *
 * Never rejects for process-level failures: a missing binary or a non-zero exit
 * is reported in the resolved {@link ExecResult}. This keeps a misbehaving agent
 * from aborting an entire tournament.
 */
export function execFile(command: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  return run(command, args, false, options);
}

/**
 * Run a shell command line via `sh -c`.
 *
 * Used for user-authored gate and judge commands, where shell features such as
 * pipes and `&&` are expected to work.
 */
export function execShell(commandLine: string, options: ExecOptions): Promise<ExecResult> {
  return run(commandLine, [], true, options);
}

function run(command: string, args: readonly string[], useShell: boolean, options: ExecOptions): Promise<ExecResult> {
  const maxChars = options.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
  const displayCommand = useShell ? command : [command, ...args].join(' ');
  const startedAt = Date.now();

  return new Promise<ExecResult>((resolvePromise) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: buildEnv(options.env),
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // Own process group, so a timeout can take down the entire tree.
      detached: true,
    };

    const child = useShell
      ? spawn('sh', ['-c', command], spawnOptions)
      : spawn(command, [...args], spawnOptions);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const append = (current: string, chunk: string): string => {
      const combined = current + chunk;
      // Retain the tail: the end of the output is what explains a failure.
      return combined.length > maxChars ? combined.slice(combined.length - maxChars) : combined;
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = append(stdout, chunk);
      options.onStdout?.(chunk);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = append(stderr, chunk);
      options.onStderr?.(chunk);
    });

    /** Signal the child's whole process group, falling back to the pid alone. */
    const killTree = (signalName: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, signalName);
      } catch {
        try {
          child.kill(signalName);
        } catch {
          // Process already gone; nothing to clean up.
        }
      }
    };

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const finish = (result: Omit<ExecResult, 'command' | 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        ...result,
        command: displayCommand,
        durationMs: Date.now() - startedAt,
      });
    };

    function onAbort(): void {
      timedOut = false;
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
    }

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree('SIGTERM');
        // Escalate if the tree ignores SIGTERM.
        killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
      }, options.timeoutMs);
    }

    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      const message =
        err.code === 'ENOENT'
          ? `Command not found: ${useShell ? 'sh' : command}`
          : `Failed to start ${useShell ? 'sh' : command}: ${err.message}`;
      finish({ code: null, signal: null, stdout, stderr, timedOut, spawnError: message });
    });

    child.on('close', (code, signalName) => {
      finish({ code, signal: signalName, stdout, stderr, timedOut });
    });

    if (options.input !== undefined && child.stdin !== null) {
      child.stdin.on('error', () => {
        // The child may exit before reading stdin; EPIPE here is not fatal.
      });
      child.stdin.end(options.input, 'utf8');
    }
  });
}

/** Merge overrides into the parent environment, honouring explicit unsets. */
function buildEnv(overrides: ExecOptions['env']): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
  }
  return merged;
}

/** True when `binary` is resolvable on the current PATH. */
export async function commandExists(binary: string): Promise<boolean> {
  const result = await execFile('sh', ['-c', `command -v ${JSON.stringify(binary)} >/dev/null 2>&1`], {
    cwd: process.cwd(),
    timeoutMs: 5000,
  });
  return succeeded(result);
}

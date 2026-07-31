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
 *     is the part that explains a failure. Output that must survive verbatim
 *     instead of being summarized — a patch, for instance — bypasses the buffer
 *     entirely via `stdoutPath`, because a capped or re-encoded patch is not a
 *     smaller patch, it is a broken one.
 */

import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

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
  /**
   * Written to stdin, which is then closed. When omitted, stdin is /dev/null.
   *
   * Accepts a Buffer so callers that must deliver bytes untouched — a patch fed
   * to a judge, for instance — are not forced through a UTF-8 round trip.
   */
  input?: string | Buffer;
  /** Streaming hook, called with each decoded stdout chunk. */
  onStdout?: (chunk: string) => void;
  /** Streaming hook, called with each decoded stderr chunk. */
  onStderr?: (chunk: string) => void;
  /**
   * Cap on retained output per stream. Pass `Infinity` to retain everything,
   * which is only safe for commands whose output size you control.
   */
  maxBufferChars?: number;
  /**
   * Write raw stdout bytes to this path instead of decoding and buffering them.
   *
   * Required for output that must survive verbatim and may be arbitrarily large,
   * such as a patch: the buffered path is both capped and UTF-8 decoded, either
   * of which corrupts the bytes. `stdout` in the result stays empty, and
   * `onStdout` is not called. The parent directory must already exist.
   */
  stdoutPath?: string;
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

    // Raw passthrough to disk when the caller needs the bytes intact. Decoding
    // and buffering would both cap the output and mangle any non-UTF-8 content.
    let stdoutFileDone: Promise<void> | undefined;
    if (options.stdoutPath !== undefined && child.stdout !== null) {
      const target = options.stdoutPath;
      const file = createWriteStream(target);
      stdoutFileDone = new Promise<void>((resolveFile, rejectFile) => {
        file.on('finish', resolveFile);
        file.on('error', rejectFile);
        child.stdout?.on('error', rejectFile);
      });
      child.stdout.pipe(file);
    } else {
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout = append(stdout, chunk);
        options.onStdout?.(chunk);
      });
    }

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

      const deliver = (spawnErrorOverride?: string): void => {
        resolvePromise({
          ...result,
          ...(spawnErrorOverride === undefined ? {} : { spawnError: spawnErrorOverride }),
          command: displayCommand,
          durationMs: Date.now() - startedAt,
        });
      };

      // The child can close before its stdout has finished draining into the
      // file, so a caller that reads the file immediately would see a partial
      // write. Wait for the flush.
      if (stdoutFileDone === undefined) {
        deliver();
        return;
      }
      void stdoutFileDone.then(
        () => deliver(),
        (err: unknown) =>
          deliver(`Failed to write ${String(options.stdoutPath)}: ${err instanceof Error ? err.message : String(err)}`),
      );
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
      if (typeof options.input === 'string') child.stdin.end(options.input, 'utf8');
      else child.stdin.end(options.input);
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

/**
 * True when `binary` is resolvable as an executable on the current PATH.
 *
 * Resolved in-process rather than by shelling out. The previous implementation
 * asked `sh -c "command -v ..."`, which reports *every* binary as missing
 * wherever `sh` itself is absent — so `flashover doctor` would claim git was not
 * installed on the same line it printed the repository git had just resolved.
 * Diagnostics have to be trustworthy to be worth printing.
 */
export async function commandExists(binary: string): Promise<boolean> {
  const trimmed = binary.trim();
  if (trimmed === '') return false;

  // An explicit path is checked as given; PATH lookup does not apply to it.
  if (trimmed.includes('/') || trimmed.includes('\\') || isAbsolute(trimmed)) {
    return isExecutableFile(resolve(trimmed));
  }

  const searchPath = process.env['PATH'] ?? '';
  for (const dir of searchPath.split(delimiter)) {
    if (dir === '') continue;
    for (const extension of executableExtensions()) {
      if (await isExecutableFile(join(dir, trimmed + extension))) return true;
    }
  }
  return false;
}

/**
 * True when a POSIX shell is available.
 *
 * Gate and judge commands are user-authored shell command lines run through
 * `sh -c`, so without one no candidate can be scored. Tested by actually
 * spawning the shell, so this reflects the exact mechanism gates depend on.
 */
export async function posixShellAvailable(): Promise<boolean> {
  const result = await execShell('exit 0', { cwd: process.cwd(), timeoutMs: 5000 });
  return succeeded(result);
}

/**
 * Suffixes to try when resolving a bare command name.
 *
 * On Windows executability comes from the extension rather than a permission
 * bit, and `PATHEXT` is what decides which extensions count.
 */
function executableExtensions(): string[] {
  if (process.platform !== 'win32') return [''];
  const pathext = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  return ['', ...pathext.split(';').filter((entry) => entry !== '')];
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) return false;
  } catch {
    return false;
  }
  // Windows has no execute bit; reaching here means the extension matched.
  if (process.platform === 'win32') return true;
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Behavioural verification of agent presets.
 *
 * Presets are the part of flashover most likely to be wrong, because they encode
 * another project's command-line flags and those change without notice. A stale
 * preset makes flashover look broken for everyone using that agent, so it is the
 * failure mode most worth detecting early.
 *
 * Checking `--help` text would be cheap and nearly worthless: a flag can survive
 * while its behaviour changes, and help output is not a contract. So this asks
 * the only question that matters — pointed at a throwaway repository with a
 * trivial task, does the agent edit the file and exit 0? — and accepts that the
 * answer costs tokens.
 *
 * Never part of plain `flashover doctor` for exactly that reason. It runs real
 * agents and spends real money, so it is opt-in.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commandExists, execFile, succeeded } from './exec.js';
import { runAgent } from './agent.js';
import { PRESETS, presetNames, resolveAgent } from './presets.js';
import { log, style } from './log.js';

/**
 * The task handed to every agent.
 *
 * Deliberately trivial and unambiguous: any agent that works at all can do it,
 * so a failure points at the preset or the CLI, not at the difficulty of the
 * request.
 */
const PROBE_TASK = 'Add a single line reading "verified" to the end of PROBE.md. Change nothing else.';

/** Per-preset time limit. Generous enough for a cold start, short enough to fail fast. */
const PROBE_TIMEOUT_MS = 3 * 60 * 1000;

export interface PresetVerification {
  preset: string;
  /** False when the binary is not on PATH; everything else is then skipped. */
  installed: boolean;
  /** True when the agent exited 0 and left a change behind. */
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** True when the agent exited cleanly but the tree was untouched. */
  noChanges: boolean;
  durationMs: number;
  /** Populated when something went wrong, for the summary line. */
  detail?: string;
  /** Transcript path, kept only for failures. */
  logPath?: string;
}

export interface VerifyPresetsOptions {
  /** Limit the run to these presets. Defaults to every known preset. */
  only?: readonly string[];
  signal?: AbortSignal;
}

/**
 * Run every installed preset against a throwaway repository.
 *
 * Each preset gets its own fresh repository, so one agent's mess cannot be
 * attributed to the next.
 */
export async function verifyPresets(options: VerifyPresetsOptions = {}): Promise<PresetVerification[]> {
  const targets = options.only !== undefined && options.only.length > 0 ? options.only : presetNames();
  const results: PresetVerification[] = [];

  for (const name of targets) {
    if (options.signal?.aborted === true) break;

    const preset = PRESETS[name];
    if (preset === undefined) {
      results.push({
        preset: name,
        installed: false,
        ok: false,
        exitCode: null,
        timedOut: false,
        noChanges: false,
        durationMs: 0,
        detail: 'no such preset',
      });
      continue;
    }

    if (!(await commandExists(preset.command))) {
      results.push({
        preset: name,
        installed: false,
        ok: false,
        exitCode: null,
        timedOut: false,
        noChanges: false,
        durationMs: 0,
      });
      continue;
    }

    results.push(await verifyOne(name, options.signal));
  }

  return results;
}

async function verifyOne(name: string, signal?: AbortSignal): Promise<PresetVerification> {
  const workspace = await mkdtemp(join(tmpdir(), `flashover-verify-${name}-`));
  const repo = join(workspace, 'repo');
  const scratch = join(workspace, 'scratch');
  const logPath = join(workspace, `${name}.log`);

  const base: PresetVerification = {
    preset: name,
    installed: true,
    ok: false,
    exitCode: null,
    timedOut: false,
    noChanges: false,
    durationMs: 0,
    logPath,
  };

  try {
    const git = async (...args: string[]): Promise<boolean> =>
      succeeded(await execFile('git', args, { cwd: repo, timeoutMs: 30_000 }));

    await writeFile(join(workspace, '.keep'), '', 'utf8');
    await execFile('git', ['init', '-b', 'main', repo], { cwd: workspace, timeoutMs: 30_000 });
    await writeFile(join(repo, 'PROBE.md'), '# Probe\n', 'utf8');
    await git('config', 'user.name', 'flashover-verify');
    await git('config', 'user.email', 'verify@localhost');
    await git('add', '-A');
    await git('commit', '-m', 'probe baseline');

    const { agent } = resolveAgent(name);
    const outcome = await runAgent({
      agent,
      prompt: PROBE_TASK,
      worktreePath: repo,
      candidateId: name,
      index: 0,
      runId: 'verify',
      logPath,
      scratchDir: scratch,
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
    });

    const status = await execFile('git', ['status', '--porcelain'], { cwd: repo, timeoutMs: 30_000 });
    const changed = status.stdout.trim() !== '';

    const result: PresetVerification = {
      ...base,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
      noChanges: !changed,
      ok: outcome.exitCode === 0 && !outcome.timedOut && changed,
    };

    if (outcome.spawnError !== undefined) result.detail = outcome.spawnError;
    else if (outcome.timedOut) result.detail = `no result within ${PROBE_TIMEOUT_MS / 1000}s`;
    else if (outcome.exitCode !== 0) result.detail = `exit code ${String(outcome.exitCode)}`;
    else if (!changed) result.detail = 'exited cleanly but edited nothing';

    // Only failures are worth a transcript; a passing preset leaves nothing behind.
    if (result.ok) {
      delete result.logPath;
      await rm(workspace, { recursive: true, force: true });
    } else {
      log.debug(`${name}: transcript kept at ${logPath}`);
    }

    return result;
  } catch (err) {
    return { ...base, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Human-readable summary. Returns the number of installed presets that failed. */
export function reportPresetVerification(results: readonly PresetVerification[]): number {
  const installed = results.filter((result) => result.installed);
  let failures = 0;

  log.info(style.bold('preset verification'));
  if (installed.length === 0) {
    log.warn('  No supported agent CLI is installed, so nothing could be verified.');
    return 0;
  }

  for (const result of results) {
    if (!result.installed) {
      log.info(`  ${result.preset.padEnd(14)} ${style.gray('skipped, not installed')}`);
      continue;
    }
    if (result.ok) {
      log.info(`  ${result.preset.padEnd(14)} ${style.green('ok')} ${style.gray(`${Math.round(result.durationMs / 1000)}s`)}`);
      continue;
    }

    failures += 1;
    log.info(`  ${result.preset.padEnd(14)} ${style.red('FAILED')} ${style.gray(result.detail ?? '')}`);
    if (result.logPath !== undefined) {
      log.info(`  ${' '.repeat(14)} ${style.gray(`transcript: ${result.logPath}`)}`);
    }
  }

  log.blank();
  if (failures === 0) {
    log.success(`All ${installed.length} installed preset${installed.length === 1 ? '' : 's'} still work.`);
    return 0;
  }

  log.error(`${failures} of ${installed.length} installed presets failed.`);
  log.info(
    style.gray(
      '  A preset that fails here is almost certainly using flags the agent CLI has changed. ' +
        'Please open an issue with the working invocation: https://github.com/idugeni/flashover/issues',
    ),
  );
  return failures;
}

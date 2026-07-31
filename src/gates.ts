/**
 * Verification gates and the optional external judge.
 *
 * This is the part that distinguishes flashover from a plain parallel runner: a
 * candidate is not judged by whether the agent claimed success, but by whether
 * its worktree survives an objective battery of commands.
 *
 * Ordering matters. Gates run sequentially per candidate, cheap before
 * expensive, and a failed *required* gate stops that candidate immediately.
 * There is no value in running a 4 minute test suite against a tree that does
 * not compile.
 */

import type { GateDefinition, GateResult, JudgeDefinition } from './types.js';
import { execShell, succeeded, describeFailure } from './exec.js';
import { clamp, tail } from './util.js';
import { log } from './log.js';

/** How much gate output to retain in the report, per stream. */
const OUTPUT_TAIL_CHARS = 4000;

export interface GateRunContext {
  worktreePath: string;
  candidateId: string;
  runId: string;
  signal?: AbortSignal;
}

/** Run one gate and translate its exit status into a {@link GateResult}. */
export async function runGate(gate: GateDefinition, ctx: GateRunContext): Promise<GateResult> {
  const cwd = gate.cwd === undefined ? ctx.worktreePath : `${ctx.worktreePath}/${gate.cwd}`;

  const result = await execShell(gate.run, {
    cwd,
    timeoutMs: gate.timeoutMs,
    env: {
      ...(gate.env ?? {}),
      FLASHOVER: '1',
      FLASHOVER_RUN_ID: ctx.runId,
      FLASHOVER_CANDIDATE_ID: ctx.candidateId,
      FLASHOVER_GATE: gate.name,
      FLASHOVER_WORKTREE: ctx.worktreePath,
      // Keep gate logs free of escape codes, and stop tools from prompting.
      NO_COLOR: '1',
      CI: '1',
    },
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });

  const passed = succeeded(result);
  log.debug(`${ctx.candidateId}: gate "${gate.name}" ${passed ? 'passed' : `failed (${describeFailure(result)})`}`);

  return {
    name: gate.name,
    weight: gate.weight,
    required: gate.required,
    passed,
    exitCode: result.code,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stdoutTail: tail(result.stdout, OUTPUT_TAIL_CHARS),
    stderrTail: tail(result.stderr === '' && result.spawnError !== undefined ? result.spawnError : result.stderr, OUTPUT_TAIL_CHARS),
  };
}

export interface GateBatteryOutcome {
  results: GateResult[];
  /** Name of the required gate that stopped the run, or null if none did. */
  eliminatedBy: string | null;
}

/**
 * Run a list of gates in order, short-circuiting on the first required failure.
 *
 * Gates are intentionally *not* parallelized within a candidate. They share one
 * worktree, so concurrent builds would race on the same output directories.
 * Parallelism happens across candidates instead.
 */
export async function runGateBattery(
  gates: readonly GateDefinition[],
  ctx: GateRunContext,
  onGateFinished?: (result: GateResult) => void,
): Promise<GateBatteryOutcome> {
  const results: GateResult[] = [];

  for (const gate of gates) {
    if (ctx.signal?.aborted === true) break;
    const result = await runGate(gate, ctx);
    results.push(result);
    onGateFinished?.(result);

    if (!result.passed && gate.required) {
      return { results, eliminatedBy: gate.name };
    }
  }

  return { results, eliminatedBy: null };
}

export interface JudgeOutcome {
  /** Normalized 0-100 score, or null when the judge could not produce one. */
  score: number | null;
  /** Why the score is null, for the report. */
  failure: string | null;
  durationMs: number;
  rawOutput: string;
}

/**
 * Run the external judge over a candidate's diff.
 *
 * flashover stays model-agnostic by treating the judge as an opaque command: it
 * receives the unified diff on stdin and prints a score. That means a judge can
 * be an LLM call, a heuristic script, a static analyzer, or a coin flip, with no
 * provider integration in this codebase.
 *
 * The diff is delivered as the exact bytes written to the patch file, not a
 * decoded copy, so what the judge scores is what `git apply` would consume.
 *
 * Accepted output formats, checked in order:
 *  - JSON object anywhere in stdout containing a numeric `score` field
 *  - a bare number on the last non-empty line
 *
 * A judge that fails or emits garbage yields a null score rather than an error,
 * so one flaky judge cannot void an entire tournament.
 */
export async function runJudge(
  judge: JudgeDefinition,
  patch: Buffer | string,
  ctx: GateRunContext,
): Promise<JudgeOutcome> {
  const result = await execShell(judge.run, {
    cwd: ctx.worktreePath,
    timeoutMs: judge.timeoutMs,
    input: patch,
    env: {
      ...(judge.env ?? {}),
      FLASHOVER: '1',
      FLASHOVER_RUN_ID: ctx.runId,
      FLASHOVER_CANDIDATE_ID: ctx.candidateId,
      FLASHOVER_WORKTREE: ctx.worktreePath,
      NO_COLOR: '1',
    },
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });

  const rawOutput = tail(result.stdout, OUTPUT_TAIL_CHARS);

  if (!succeeded(result)) {
    const failure = `judge command failed (${describeFailure(result)})`;
    log.debug(`${ctx.candidateId}: ${failure}`);
    return { score: null, failure, durationMs: result.durationMs, rawOutput };
  }

  const score = parseJudgeScore(result.stdout);
  if (score === null) {
    const failure = 'judge output did not contain a score between 0 and 100';
    log.warn(`${ctx.candidateId}: ${failure}`);
    return { score: null, failure, durationMs: result.durationMs, rawOutput };
  }

  return { score, failure: null, durationMs: result.durationMs, rawOutput };
}

/**
 * Extract a 0-100 score from judge stdout.
 *
 * Exported for unit testing. Returns null when no score can be found, and
 * clamps out-of-range numbers rather than rejecting them, since a judge
 * answering `120` clearly means "excellent".
 */
export function parseJudgeScore(stdout: string): number | null {
  // Prefer structured output: scan JSON objects from the end, so a judge that
  // narrates before emitting JSON still works.
  const jsonMatches = [...stdout.matchAll(/\{[^{}]*"score"\s*:\s*(-?\d+(?:\.\d+)?)[^{}]*\}/g)];
  const lastJson = jsonMatches.at(-1);
  if (lastJson?.[1] !== undefined) {
    const parsed = Number.parseFloat(lastJson[1]);
    if (Number.isFinite(parsed)) return clamp(parsed, 0, 100);
  }

  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const lastLine = lines.at(-1);
  if (lastLine === undefined) return null;

  // Accept `87`, `87.5`, `87/100`, and `score: 87`.
  const numberMatch = /(-?\d+(?:\.\d+)?)\s*(?:\/\s*100)?\s*$/.exec(lastLine);
  if (numberMatch?.[1] === undefined) return null;

  const parsed = Number.parseFloat(numberMatch[1]);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 100) : null;
}

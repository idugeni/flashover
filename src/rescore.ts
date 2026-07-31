/**
 * Re-verification of a previous run.
 *
 * Agents are the only expensive step in a tournament; gates and judges are
 * cheap. That asymmetry makes tuning them painful, because changing a weight or
 * fixing a judge normally means paying for N fresh agent invocations to see the
 * effect.
 *
 * Every candidate's diff is already persisted under `.flashover/*\/patches/`, so
 * that cost is avoidable. `rescore` rebuilds each candidate's worktree from the
 * original base revision, applies the stored patch, and runs the *current* gates
 * and judge against it. Same inputs, new verdict, no tokens spent.
 *
 * What it deliberately does not do:
 *
 * - **Re-run agents.** Candidates that failed or produced nothing are carried
 *   over verbatim, still unrankable. Their transcripts remain the source of
 *   truth for why.
 * - **Invent timings.** `agentDurationMs` is a ranking tie-breaker, so it is
 *   inherited from the source run rather than replaced by however long
 *   `git apply` happened to take. A rescored leaderboard has to break ties the
 *   same way the original would have.
 * - **Re-derive the base.** The base sha comes from the source report, not from
 *   the current HEAD, because a patch is only meaningful against the revision it
 *   was recorded against.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CandidateResult, GateResult, ResolvedConfig, RunReport } from './types.js';
import { FlashoverError, REPORT_VERSION } from './types.js';
import { runGateBattery, runJudge } from './gates.js';
import * as git from './git.js';
import { computeScore, pickWinner, rankCandidates } from './score.js';
import { writeReport } from './report.js';
import { cleanupWorktrees, promoteWinner } from './tournament.js';
import type { TournamentEvent } from './tournament.js';
import { log } from './log.js';
import { pool } from './util.js';

export interface RescoreOptions {
  /** Current configuration; its gates and judge are what the rescore applies. */
  config: ResolvedConfig;
  /** The run being rescored. */
  source: RunReport;
  /** Identifier for the new run this produces. */
  runId: string;
  onEvent?: (event: TournamentEvent) => void;
  signal?: AbortSignal;
}

/** Per-candidate plan: an existing result plus where to rebuild it. */
interface RescorePlan {
  id: string;
  index: number;
  /** The candidate as recorded by the source run. */
  source: CandidateResult;
  worktreePath: string;
  /** Stored patch acting as the input. Never rewritten. */
  patchPath: string;
}

/**
 * Re-verify a previous run's patches against the current gates.
 *
 * Resolves to a fresh {@link RunReport} carrying `rescoredFrom`, written to disk
 * before this returns.
 */
export async function rescoreRun(options: RescoreOptions): Promise<RunReport> {
  const { config, source, runId } = options;
  const startedAt = new Date();

  // A patch only means something against the revision it was taken from. If that
  // commit is gone, say so rather than silently rescoring against something else.
  const baseSha = await resolveSourceBase(config.repoRoot, source);
  await git.ensureArtifactsIgnored(config.repoRoot);

  const runDir = join(config.workDir, `run-${runId}`);
  await mkdir(runDir, { recursive: true });

  const plans = buildRescorePlans(source, runDir);
  if (plans.length === 0) {
    throw new FlashoverError(
      `Run ${source.runId} has no candidate patches to rescore.`,
      'Every candidate either failed or produced no changes, so there is nothing to re-verify.',
    );
  }

  // Carried-over candidates are part of the report from the start: an agent that
  // crashed in the source run still belongs on the leaderboard.
  const results = new Map<string, CandidateResult>();
  for (const candidate of source.candidates) {
    results.set(candidate.id, carriedOver(candidate));
  }
  for (const plan of plans) {
    results.set(plan.id, pendingResult(plan));
  }

  const emit = (event: TournamentEvent): void => options.onEvent?.(event);
  const update = (id: string, patch: Partial<CandidateResult>, detail?: string): CandidateResult => {
    const current = results.get(id);
    if (current === undefined) throw new Error(`unknown candidate ${id}`);
    const next = { ...current, ...patch };
    results.set(id, next);
    emit(
      detail === undefined
        ? { type: 'candidate-update', candidate: next }
        : { type: 'candidate-update', candidate: next, detail },
    );
    return next;
  };

  emit({ type: 'run-start', runId, runDir, total: plans.length, baseSha });
  log.info(`Rescoring ${plans.length} stored patch${plans.length === 1 ? '' : 'es'} from run ${source.runId}`);

  const configuredGateWeight = config.scoredGates.reduce((total, gate) => total + gate.weight, 0);

  await pool(plans, config.concurrency, async (plan) => {
    try {
      await rescoreCandidate({ plan, config, baseSha, runId, configuredGateWeight, update, emit, signal: options.signal });
    } catch (err) {
      // One unusable patch must not void the rescore, exactly as one failing
      // candidate does not void a tournament.
      const message = err instanceof Error ? err.message : String(err);
      log.debug(`${plan.id}: ${message}`);
      update(plan.id, { status: 'error', error: message });
    }
  });

  const ordered = source.candidates
    .map((candidate) => results.get(candidate.id))
    .filter((candidate): candidate is CandidateResult => candidate !== undefined);

  const winner = pickWinner(rankCandidates(ordered), config.minScore);

  let promotedBranch: string | null = null;
  let promotedPatch: string | null = null;
  if (winner !== null) {
    update(winner.id, { status: 'winner' });
    emit({ type: 'promoting', candidateId: winner.id });
    const promotion = await promoteWinner(config, results.get(winner.id) ?? winner);
    promotedBranch = promotion.branch;
    promotedPatch = promotion.patch;
  }

  await cleanupWorktrees(config, plans, winner?.id ?? null);

  const finishedAt = new Date();
  const report: RunReport = {
    version: REPORT_VERSION,
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    // The task is the one the agents were actually given, not anything the
    // rescore invocation might imply.
    prompt: source.prompt,
    baseSha,
    repoRoot: config.repoRoot,
    candidates: source.candidates
      .map((candidate) => results.get(candidate.id))
      .filter((candidate): candidate is CandidateResult => candidate !== undefined),
    winnerId: winner?.id ?? null,
    promotedBranch,
    promotedPatch,
    rescoredFrom: source.runId,
  };

  await writeReport(runDir, report);
  emit({ type: 'run-finished', report });
  return report;
}

interface RescoreCandidateArgs {
  plan: RescorePlan;
  config: ResolvedConfig;
  baseSha: string;
  runId: string;
  configuredGateWeight: number;
  update: (id: string, patch: Partial<CandidateResult>, detail?: string) => CandidateResult;
  emit: (event: TournamentEvent) => void;
  signal?: AbortSignal;
}

async function rescoreCandidate(args: RescoreCandidateArgs): Promise<void> {
  const { plan, config, update, emit } = args;

  if (args.signal?.aborted === true) {
    update(plan.id, { status: 'error', error: 'cancelled before start' });
    return;
  }

  await git.addWorktree(config.repoRoot, plan.worktreePath, args.baseSha);
  if (config.seed.copy.length > 0 || config.seed.link.length > 0) {
    await git.seedWorktree(config.repoRoot, plan.worktreePath, config.seed);
  }

  update(plan.id, { status: 'verifying' }, 'applying patch');

  await git.applyPatch(plan.worktreePath, plan.patchPath);
  await git.stageAll(plan.worktreePath);

  // An empty result here means the stored patch was empty, which the source run
  // would have recorded as `no-changes`. Treat it the same way rather than
  // scoring a candidate that changed nothing.
  if (await git.hasNoStagedChanges(plan.worktreePath)) {
    update(plan.id, { status: 'no-changes' });
    return;
  }

  // Recomputed from the rebuilt worktree rather than copied from the source
  // report, so a patch that no longer produces the recorded diff is visible
  // instead of assumed.
  const diff = await git.stagedDiffStat(plan.worktreePath);
  const commitSha = await git.commitStaged(
    plan.worktreePath,
    `flashover(rescore ${plan.source.agentName}): ${plan.id} from run ${args.runId}`,
  );

  update(plan.id, { diff, commitSha });

  const gateCtx = {
    worktreePath: plan.worktreePath,
    candidateId: plan.id,
    runId: args.runId,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };

  const onGate = (gate: GateResult): void => emit({ type: 'gate-finished', candidateId: plan.id, gate });
  const recordedGates: GateResult[] = [];

  if (config.setupGates.length > 0) {
    const setup = await runGateBattery(config.setupGates, gateCtx, onGate);
    recordedGates.push(...setup.results);
    if (setup.eliminatedBy !== null) {
      update(plan.id, { status: 'eliminated', eliminatedBy: setup.eliminatedBy, gates: [...recordedGates] });
      return;
    }
    update(plan.id, { gates: [...recordedGates] });
  }

  const battery = await runGateBattery(config.scoredGates, gateCtx, onGate);
  recordedGates.push(...battery.results);

  let judgeScore: number | null = null;
  if (config.judge !== null && battery.eliminatedBy === null) {
    const patchBytes = await readFile(plan.patchPath);
    const outcome = await runJudge(config.judge, patchBytes, gateCtx);
    judgeScore = outcome.score;
  }

  update(plan.id, {
    status: battery.eliminatedBy === null ? 'scored' : 'eliminated',
    eliminatedBy: battery.eliminatedBy,
    gates: [...recordedGates],
    judgeScore,
    score: computeScore({
      gates: battery.results,
      judgeScore,
      judgeWeight: config.judge?.weight ?? 0,
      configuredGateWeight: args.configuredGateWeight,
    }),
  });
}

/**
 * Resolve the base revision the source run measured against.
 *
 * `promote: none` leaves candidate commits unreachable, so they can be garbage
 * collected — but the base is normally a real branch tip and survives. When it
 * does not, rescoring is impossible and saying so beats producing a verdict
 * against the wrong tree.
 */
async function resolveSourceBase(repoRoot: string, source: RunReport): Promise<string> {
  try {
    return await git.revParse(repoRoot, source.baseSha);
  } catch {
    throw new FlashoverError(
      `Base revision ${source.baseSha.slice(0, 12)} from run ${source.runId} no longer exists in this repository.`,
      'The stored patches can only be re-verified against the revision they were taken from.',
    );
  }
}

/** Candidates with a usable stored patch, in their original order. */
function buildRescorePlans(source: RunReport, runDir: string): RescorePlan[] {
  const plans: RescorePlan[] = [];

  for (const candidate of source.candidates) {
    if (candidate.patchPath === null) continue;
    if (!existsSync(candidate.patchPath)) {
      log.warn(`${candidate.id}: stored patch is missing, skipping (${candidate.patchPath})`);
      continue;
    }
    plans.push({
      id: candidate.id,
      index: candidate.index,
      source: candidate,
      // Kept under the new run's directory, so the source run's artifacts stay
      // untouched and remain rescorable again.
      worktreePath: join(runDir, candidate.id),
      patchPath: candidate.patchPath,
    });
  }

  return plans;
}

/**
 * A candidate carried into the new report without being re-verified.
 *
 * Agents are not re-run, so a candidate that crashed or produced nothing has no
 * patch to score. Its verdict is already final and is reproduced as-is, with
 * gate results cleared because the gates it faced no longer exist.
 */
function carriedOver(candidate: CandidateResult): CandidateResult {
  return { ...candidate, gates: [], judgeScore: null, score: 0, eliminatedBy: null };
}

/** Starting state for a candidate that will be re-verified. */
function pendingResult(plan: RescorePlan): CandidateResult {
  return {
    ...plan.source,
    status: 'pending',
    worktreePath: plan.worktreePath,
    // Inherited on purpose: see the module comment on tie-breaker fidelity.
    agentDurationMs: plan.source.agentDurationMs,
    diff: null,
    commitSha: null,
    gates: [],
    judgeScore: null,
    score: 0,
    eliminatedBy: null,
  };
}

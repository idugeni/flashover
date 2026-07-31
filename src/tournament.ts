/**
 * The tournament orchestrator.
 *
 * Lifecycle of a single candidate, in the order the steps must happen:
 *
 * ```
 * worktree add --detach   isolate, so agents cannot see or clobber each other
 * seed                    materialize gitignored build inputs (node_modules, .env)
 * run agent               the only step that consumes tokens
 * git add -A              capture whatever the agent left behind
 * diff + patch            record the result before any gate can pollute the tree
 * commit                  give the diff a stable sha so promotion is a ref write
 * setup gates             install/build; failure means "cannot be evaluated"
 * scored gates            the actual verification, short-circuiting on required
 * judge                   optional subjective score over the diff
 * ```
 *
 * The diff is captured *before* gates run. Gates create artifacts (node_modules,
 * dist, coverage) and a later `git add -A` would attribute all of it to the
 * agent. Committing early also means promotion never has to check anything out.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  CandidateResult,
  CandidateStatus,
  GateResult,
  ResolvedConfig,
  RosterEntry,
  RunReport,
} from './types.js';
import { REPORT_VERSION } from './types.js';
import { runAgent } from './agent.js';
import { runGateBattery, runJudge } from './gates.js';
import * as git from './git.js';
import { computeScore, pickWinner, rankCandidates, totalConfiguredWeight } from './score.js';
import { writeReport } from './report.js';
import { log } from './log.js';
import { pool, slugify } from './util.js';

/** Progress notifications for the live view. */
export type TournamentEvent =
  | { type: 'run-start'; runId: string; runDir: string; total: number; baseSha: string }
  | { type: 'candidate-update'; candidate: CandidateResult; detail?: string }
  | { type: 'gate-finished'; candidateId: string; gate: GateResult }
  | { type: 'promoting'; candidateId: string }
  | { type: 'run-finished'; report: RunReport };

export interface TournamentOptions {
  config: ResolvedConfig;
  runId: string;
  onEvent?: (event: TournamentEvent) => void;
  signal?: AbortSignal;
}

/** Internal per-candidate plan derived from the roster. */
interface CandidatePlan {
  id: string;
  index: number;
  agent: RosterEntry['agent'];
  worktreePath: string;
  logPath: string;
  patchPath: string;
}

/**
 * Run a full tournament and return its report.
 *
 * The report is written to disk before this resolves, including when the run is
 * aborted partway through, so a cancelled run is still inspectable.
 */
export async function runTournament(options: TournamentOptions): Promise<RunReport> {
  const { config, runId } = options;
  const startedAt = new Date();

  const baseSha = await git.revParse(config.repoRoot, config.baseRef);
  await git.ensureArtifactsIgnored(config.repoRoot);
  warnAboutSeedGateConflicts(config);
  await warnAboutTrackedSeeds(config);

  const runDir = join(config.workDir, `run-${runId}`);
  const scratchDir = join(runDir, 'scratch');
  await mkdir(runDir, { recursive: true });

  const plans = buildPlans(config, runDir);
  const results = new Map<string, CandidateResult>();
  for (const plan of plans) {
    results.set(plan.id, initialResult(plan));
  }

  const emit = (event: TournamentEvent): void => options.onEvent?.(event);
  const update = (id: string, patch: Partial<CandidateResult>, detail?: string): CandidateResult => {
    const current = results.get(id);
    if (current === undefined) throw new Error(`unknown candidate ${id}`);
    const next = { ...current, ...patch };
    results.set(id, next);
    emit(detail === undefined ? { type: 'candidate-update', candidate: next } : { type: 'candidate-update', candidate: next, detail });
    return next;
  };

  emit({ type: 'run-start', runId, runDir, total: plans.length, baseSha });

  const configuredGateWeight = config.scoredGates.reduce((total, gate) => total + gate.weight, 0);

  await pool(plans, config.concurrency, async (plan) => {
    try {
      await runCandidate({ plan, config, baseSha, runId, scratchDir, configuredGateWeight, update, emit, signal: options.signal });
    } catch (err) {
      // An infrastructure failure for one candidate must not void the tournament.
      const message = err instanceof Error ? err.message : String(err);
      log.debug(`${plan.id}: ${message}`);
      update(plan.id, { status: 'error', error: message });
    }
  });

  const candidates = plans.map((plan) => results.get(plan.id)).filter((r): r is CandidateResult => r !== undefined);
  const ranked = rankCandidates(candidates);
  const winner = pickWinner(ranked, config.minScore);

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
    prompt: config.prompt,
    baseSha,
    repoRoot: config.repoRoot,
    candidates: plans
      .map((plan) => results.get(plan.id))
      .filter((r): r is CandidateResult => r !== undefined),
    winnerId: winner?.id ?? null,
    promotedBranch,
    promotedPatch,
  };

  await writeReport(runDir, report);
  emit({ type: 'run-finished', report });
  return report;
}

interface RunCandidateArgs {
  plan: CandidatePlan;
  config: ResolvedConfig;
  baseSha: string;
  runId: string;
  scratchDir: string;
  configuredGateWeight: number;
  update: (id: string, patch: Partial<CandidateResult>, detail?: string) => CandidateResult;
  emit: (event: TournamentEvent) => void;
  signal?: AbortSignal;
}

async function runCandidate(args: RunCandidateArgs): Promise<void> {
  const { plan, config, update, emit } = args;

  if (args.signal?.aborted === true) {
    update(plan.id, { status: 'error', error: 'cancelled before start' });
    return;
  }

  await git.addWorktree(config.repoRoot, plan.worktreePath, args.baseSha);
  if (config.seed.copy.length > 0 || config.seed.link.length > 0) {
    await git.seedWorktree(config.repoRoot, plan.worktreePath, config.seed);
  }

  update(plan.id, { status: 'running' });

  const agentOutcome = await runAgent({
    agent: plan.agent,
    prompt: config.prompt,
    worktreePath: plan.worktreePath,
    candidateId: plan.id,
    index: plan.index,
    runId: args.runId,
    logPath: plan.logPath,
    scratchDir: args.scratchDir,
    // A per-agent limit wins over the run-wide one, so a slow local harness and a
    // fast hosted agent can share a roster without one of them being misjudged.
    timeoutMs: plan.agent.timeoutMs ?? config.agentTimeoutMs,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });

  const agentFailed =
    agentOutcome.spawnError !== undefined || agentOutcome.timedOut || agentOutcome.exitCode !== 0;

  if (agentFailed) {
    // Strict on purpose: an agent that reports failure has not earned the cost of
    // running a full test suite against its output. Its transcript and worktree
    // are still kept for inspection.
    update(plan.id, {
      status: 'agent-failed',
      agentExitCode: agentOutcome.exitCode,
      agentDurationMs: agentOutcome.durationMs,
      agentTimedOut: agentOutcome.timedOut,
      ...(agentOutcome.spawnError !== undefined ? { error: agentOutcome.spawnError } : {}),
    });
    return;
  }

  update(plan.id, {
    status: 'verifying',
    agentExitCode: agentOutcome.exitCode,
    agentDurationMs: agentOutcome.durationMs,
    agentTimedOut: false,
  });

  // Capture the result now, before gates create build artifacts.
  await git.stageAll(plan.worktreePath);
  if (await git.hasNoStagedChanges(plan.worktreePath)) {
    update(plan.id, { status: 'no-changes' });
    return;
  }

  const diff = await git.stagedDiffStat(plan.worktreePath);
  await git.exportStagedPatch(plan.worktreePath, plan.patchPath);
  const commitSha = await git.commitStaged(plan.worktreePath, buildCommitMessage(config.prompt, plan));

  update(plan.id, { diff, patchPath: plan.patchPath, commitSha });

  const gateCtx = {
    worktreePath: plan.worktreePath,
    candidateId: plan.id,
    runId: args.runId,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };

  const onGate = (gate: GateResult): void => emit({ type: 'gate-finished', candidateId: plan.id, gate });

  // Gate results accumulate locally so setup and scored outcomes both survive
  // into the report, in execution order.
  const recordedGates: GateResult[] = [];

  // Setup gates are preconditions: without them the scored gates are meaningless.
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
    // Skip the judge for eliminated candidates: it usually costs money and
    // cannot change the outcome.
    // Read as bytes so the judge sees the patch exactly as git wrote it.
    const patchBytes = await readFile(plan.patchPath);
    const outcome = await runJudge(config.judge, patchBytes, gateCtx);
    judgeScore = outcome.score;
  }

  const score = computeScore({
    gates: battery.results,
    judgeScore,
    judgeWeight: config.judge?.weight ?? 0,
    configuredGateWeight: args.configuredGateWeight,
  });

  update(plan.id, {
    status: battery.eliminatedBy === null ? 'scored' : 'eliminated',
    eliminatedBy: battery.eliminatedBy,
    gates: [...recordedGates],
    judgeScore,
    score,
  });
}

/** Expand the roster into one plan per candidate. */
function buildPlans(config: ResolvedConfig, runDir: string): CandidatePlan[] {
  const plans: CandidatePlan[] = [];
  let index = 0;

  for (const entry of config.roster) {
    for (let copy = 0; copy < entry.count; copy += 1) {
      const id = `c${index + 1}`;
      plans.push({
        id,
        index,
        agent: entry.agent,
        worktreePath: join(runDir, id),
        logPath: join(runDir, 'logs', `${id}.log`),
        patchPath: join(runDir, 'patches', `${id}.patch`),
      });
      index += 1;
    }
  }

  return plans;
}

function initialResult(plan: CandidatePlan): CandidateResult {
  return {
    id: plan.id,
    index: plan.index,
    agentName: plan.agent.name,
    status: 'pending' satisfies CandidateStatus,
    worktreePath: plan.worktreePath,
    logPath: plan.logPath,
    agentExitCode: null,
    agentDurationMs: 0,
    agentTimedOut: false,
    diff: null,
    patchPath: null,
    commitSha: null,
    gates: [],
    judgeScore: null,
    score: 0,
    eliminatedBy: null,
  };
}

function buildCommitMessage(prompt: string, plan: CandidatePlan): string {
  const firstLine = prompt.split('\n')[0] ?? 'flashover candidate';
  return [
    `flashover(${plan.agent.name}): ${firstLine.slice(0, 68)}`,
    '',
    `Candidate: ${plan.id}`,
    `Agent: ${plan.agent.name}`,
    '',
    prompt,
  ].join('\n');
}

/**
 * Make the winning diff reachable outside `.flashover/`.
 *
 * Branch mode writes a ref at the candidate's commit. Because worktrees share
 * one object database, the commit survives worktree removal, and the user's
 * working tree and index are never touched.
 *
 * Exported because `rescore` promotes by the same rules; duplicating the
 * `none` / `patch` / `branch` semantics would let the two commands drift.
 */
export async function promoteWinner(
  config: ResolvedConfig,
  winner: CandidateResult,
): Promise<{ branch: string | null; patch: string | null }> {
  // `none` reports nothing as promoted: the caller asked flashover to judge, not
  // to hand back an artifact. The patch still exists under `.flashover/` and is
  // reachable through the candidate's own `patchPath`, so no data is lost.
  if (config.promote.mode === 'none') {
    return { branch: null, patch: null };
  }

  if (config.promote.mode === 'patch') {
    return { branch: null, patch: winner.patchPath };
  }

  if (winner.commitSha === null) {
    log.warn(`Cannot promote ${winner.id} to a branch: no commit was created.`);
    return { branch: null, patch: winner.patchPath };
  }

  const desired = `${config.promote.branchPrefix}${slugify(config.prompt.split('\n')[0] ?? 'task')}`;
  const branch = await git.uniqueBranchName(config.repoRoot, desired);
  await git.createBranchAt(config.repoRoot, branch, winner.commitSha);
  return { branch, patch: winner.patchPath };
}

/**
 * Remove worktrees according to the keep policy.
 *
 * Failures here are logged but never fatal: the run already produced its result,
 * and leftover directories are recoverable with `flashover clean`.
 *
 * Takes the minimum shape it needs rather than a full plan, so `rescore` can
 * reuse it with its own plan type.
 */
export async function cleanupWorktrees(
  config: ResolvedConfig,
  plans: readonly { id: string; worktreePath: string }[],
  winnerId: string | null,
): Promise<void> {
  if (config.keep === 'all') return;

  for (const plan of plans) {
    if (config.keep === 'winner' && plan.id === winnerId) continue;
    try {
      await git.removeWorktree(config.repoRoot, plan.worktreePath);
    } catch (err) {
      log.debug(`Could not remove worktree ${plan.worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await git.pruneWorktrees(config.repoRoot);
}

/**
 * Warn when a seeded path is tracked by git.
 *
 * Seeding implies "this content is an input, not part of the change", and
 * flashover enforces that by excluding seeded paths from candidate diffs. If the
 * path is tracked, that exclusion would throw away genuine edits, so the user
 * needs to know.
 */
/** Commands that rewrite a dependency directory wholesale. */
const DESTRUCTIVE_INSTALL_PATTERN =
  /\b(?:npm\s+(?:ci|install|i)\b|yarn\s+(?:install)?\b|pnpm\s+(?:install|i)\b|bun\s+install\b|poetry\s+install\b|pip\s+install\b|cargo\s+(?:fetch|vendor)\b)/;

/**
 * Warn when a gate would write through a symlinked seed.
 *
 * A linked seed points at the user's own directory and is shared by every
 * candidate. `npm ci` deletes and recreates `node_modules`, so combining the two
 * means several candidates concurrently rewriting the user's real dependency
 * tree. That is data loss outside the sandbox flashover promises, so it is worth
 * an explicit warning even though it cannot be detected perfectly.
 */
function warnAboutSeedGateConflicts(config: ResolvedConfig): void {
  if (config.seed.link.length === 0) return;

  const allGates = [...config.setupGates, ...config.scoredGates];
  for (const gate of allGates) {
    if (!DESTRUCTIVE_INSTALL_PATTERN.test(gate.run)) continue;
    log.warn(
      `Gate "${gate.name}" runs an install command while ${config.seed.link.join(', ')} ` +
        'is symlinked into every candidate.',
    );
    log.warn(
      '  That writes through the link into your own working copy, from multiple candidates at once. ' +
        'Move the path to seed.copy, or drop the install gate.',
    );
    return;
  }
}

async function warnAboutTrackedSeeds(config: ResolvedConfig): Promise<void> {
  for (const path of [...config.seed.copy, ...config.seed.link]) {
    if (await git.isPathTracked(config.repoRoot, path)) {
      log.warn(
        `Seed path "${path}" is tracked by git. flashover excludes seeded paths from candidate ` +
          'diffs, so any agent changes under it will be discarded. Remove it from seed if agents should edit it.',
      );
    }
  }
}

/**
 * Scoring and ranking.
 *
 * The scoring model is deliberately boring and explainable: a weighted pass rate
 * over the configured gates, optionally blended with an external judge score.
 * Anyone reading a leaderboard should be able to recompute it by hand, because a
 * ranking nobody trusts is a ranking nobody ships from.
 */

import type { CandidateResult, CandidateStatus, GateResult, ResolvedConfig } from './types.js';
import { clamp } from './util.js';

/** Statuses that represent a candidate eligible to win. */
const RANKABLE_STATUSES: readonly CandidateStatus[] = ['scored', 'winner'];

/**
 * Total weight available from configuration.
 *
 * Uses configured gates rather than executed gates, so a candidate eliminated
 * halfway through is not flattered by having fewer gates counted against it.
 */
export function totalConfiguredWeight(config: Pick<ResolvedConfig, 'scoredGates' | 'judge'>): number {
  const gateWeight = config.scoredGates.reduce((total, gate) => total + gate.weight, 0);
  return gateWeight + (config.judge?.weight ?? 0);
}

export interface ScoreInput {
  /** Results for scored gates only. Setup gates carry weight 0 and are harmless. */
  gates: readonly GateResult[];
  /** Judge score in 0-100, or null when no judge ran or it failed. */
  judgeScore: number | null;
  /** Configured judge weight, ignored when `judgeScore` is null. */
  judgeWeight: number;
  /** Sum of all configured scored gate weights. */
  configuredGateWeight: number;
}

/**
 * Compute a candidate's final score on a 0-100 scale.
 *
 * Two decisions worth knowing about:
 *
 *  - Gates that never ran, because an earlier required gate eliminated the
 *    candidate, count as failures. Their weight stays in the denominator.
 *  - When the judge fails to produce a score, its weight is dropped from *that
 *    candidate's* denominator rather than scored as zero. A broken judge is
 *    flashover's problem, not the candidate's, and silently zeroing it would let
 *    infrastructure flakiness decide which patch ships.
 */
export function computeScore(input: ScoreInput): number {
  const judgeCounts = input.judgeScore !== null && input.judgeWeight > 0;
  const denominator = input.configuredGateWeight + (judgeCounts ? input.judgeWeight : 0);
  if (denominator <= 0) return 0;

  let numerator = input.gates.reduce((total, gate) => (gate.passed ? total + gate.weight : total), 0);
  if (judgeCounts) {
    numerator += (clamp(input.judgeScore ?? 0, 0, 100) / 100) * input.judgeWeight;
  }

  return clamp((numerator / denominator) * 100, 0, 100);
}

/** True when a candidate produced a verified diff and can be promoted. */
export function isRankable(candidate: Pick<CandidateResult, 'status'>): boolean {
  return RANKABLE_STATUSES.includes(candidate.status);
}

/**
 * Order two candidates, best first.
 *
 * Tie-breakers, in order after the score itself:
 *
 *  1. **Smaller diff wins.** Given equal verified behaviour, the smaller change
 *     is cheaper to review and less likely to carry unrelated churn. This also
 *     discourages the common agent failure mode of reformatting whole files.
 *  2. **Faster agent wins.** A weak proxy for a more direct solution, and it
 *     keeps results stable rather than arbitrary.
 *  3. **Lower index wins**, purely so ordering is deterministic.
 */
export function compareCandidates(a: CandidateResult, b: CandidateResult): number {
  const aRankable = isRankable(a);
  const bRankable = isRankable(b);
  if (aRankable !== bRankable) return aRankable ? -1 : 1;

  if (b.score !== a.score) return b.score - a.score;

  const aChurn = diffChurn(a);
  const bChurn = diffChurn(b);
  if (aChurn !== bChurn) return aChurn - bChurn;

  if (a.agentDurationMs !== b.agentDurationMs) return a.agentDurationMs - b.agentDurationMs;

  return a.index - b.index;
}

/** Total lines touched, used as the diff-size tie-breaker. */
function diffChurn(candidate: CandidateResult): number {
  if (candidate.diff === null) return Number.POSITIVE_INFINITY;
  return candidate.diff.insertions + candidate.diff.deletions;
}

/** Return a new array sorted best-first. Does not mutate the input. */
export function rankCandidates(candidates: readonly CandidateResult[]): CandidateResult[] {
  return [...candidates].sort(compareCandidates);
}

/**
 * Pick the winner from a ranked list.
 *
 * Returns null when nothing is rankable, or when the best candidate falls short
 * of `minScore`. Refusing to promote is a feature: a run where every agent broke
 * the build should not quietly hand back the least broken option.
 */
export function pickWinner(ranked: readonly CandidateResult[], minScore: number): CandidateResult | null {
  const best = ranked.find((candidate) => isRankable(candidate));
  if (best === undefined) return null;
  return best.score >= minScore ? best : null;
}

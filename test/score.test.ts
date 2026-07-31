import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareCandidates, computeScore, isRankable, pickWinner, rankCandidates, totalConfiguredWeight } from '../src/score.js';
import type { CandidateResult, CandidateStatus, GateResult } from '../src/types.js';

function gate(name: string, passed: boolean, weight: number, required = false): GateResult {
  return {
    name,
    weight,
    required,
    passed,
    exitCode: passed ? 0 : 1,
    signal: null,
    durationMs: 10,
    timedOut: false,
    stdoutTail: '',
    stderrTail: '',
  };
}

function candidate(overrides: Partial<CandidateResult> & { id: string }): CandidateResult {
  return {
    index: 0,
    agentName: 'claude',
    status: 'scored' satisfies CandidateStatus,
    worktreePath: `/tmp/${overrides.id}`,
    logPath: `/tmp/${overrides.id}.log`,
    agentExitCode: 0,
    agentDurationMs: 1000,
    agentTimedOut: false,
    diff: { filesChanged: 1, insertions: 10, deletions: 5 },
    patchPath: null,
    commitSha: 'abc123',
    gates: [],
    judgeScore: null,
    score: 50,
    eliminatedBy: null,
    ...overrides,
  };
}

describe('computeScore', () => {
  it('returns a weighted pass rate', () => {
    // 5 of 8 available weight passed.
    const score = computeScore({
      gates: [gate('test', true, 5), gate('lint', false, 3)],
      judgeScore: null,
      judgeWeight: 0,
      configuredGateWeight: 8,
    });

    assert.equal(score, 62.5);
  });

  it('awards 100 when everything passes', () => {
    const score = computeScore({
      gates: [gate('test', true, 5), gate('lint', true, 3)],
      judgeScore: null,
      judgeWeight: 0,
      configuredGateWeight: 8,
    });

    assert.equal(score, 100);
  });

  it('counts gates that never ran as failures', () => {
    // Eliminated after the first gate: only one result exists, but the
    // denominator still reflects all configured weight.
    const score = computeScore({
      gates: [gate('typecheck', false, 2, true)],
      judgeScore: null,
      judgeWeight: 0,
      configuredGateWeight: 10,
    });

    assert.equal(score, 0);
  });

  it('blends the judge score in proportion to its weight', () => {
    // Gates contribute 5/5, judge contributes 0.5 * 5 = 2.5, total 7.5 of 10.
    const score = computeScore({
      gates: [gate('test', true, 5)],
      judgeScore: 50,
      judgeWeight: 5,
      configuredGateWeight: 5,
    });

    assert.equal(score, 75);
  });

  it('drops the judge from the denominator when it produced no score', () => {
    // A broken judge must not silently penalize the candidate: this stays 100
    // rather than collapsing to 50.
    const score = computeScore({
      gates: [gate('test', true, 5)],
      judgeScore: null,
      judgeWeight: 5,
      configuredGateWeight: 5,
    });

    assert.equal(score, 100);
  });

  it('clamps an out-of-range judge score', () => {
    const score = computeScore({
      gates: [],
      judgeScore: 250,
      judgeWeight: 10,
      configuredGateWeight: 0,
    });

    assert.equal(score, 100);
  });

  it('returns 0 rather than dividing by zero', () => {
    const score = computeScore({ gates: [], judgeScore: null, judgeWeight: 0, configuredGateWeight: 0 });
    assert.equal(score, 0);
  });
});

describe('totalConfiguredWeight', () => {
  it('sums gate weights and the judge weight', () => {
    const total = totalConfiguredWeight({
      scoredGates: [
        { name: 'a', run: 'true', weight: 2, required: false, timeoutMs: 1000 },
        { name: 'b', run: 'true', weight: 3, required: false, timeoutMs: 1000 },
      ],
      judge: { run: 'true', weight: 5, timeoutMs: 1000 },
    });

    assert.equal(total, 10);
  });

  it('handles a missing judge', () => {
    const total = totalConfiguredWeight({
      scoredGates: [{ name: 'a', run: 'true', weight: 4, required: false, timeoutMs: 1000 }],
      judge: null,
    });

    assert.equal(total, 4);
  });
});

describe('isRankable', () => {
  it('accepts only scored and winning candidates', () => {
    assert.equal(isRankable({ status: 'scored' }), true);
    assert.equal(isRankable({ status: 'winner' }), true);
    for (const status of ['pending', 'running', 'verifying', 'eliminated', 'no-changes', 'agent-failed', 'error'] as const) {
      assert.equal(isRankable({ status }), false, `${status} must not be rankable`);
    }
  });
});

describe('compareCandidates', () => {
  it('ranks rankable candidates above failures', () => {
    const good = candidate({ id: 'c1', score: 10 });
    const failed = candidate({ id: 'c2', status: 'eliminated', score: 90 });

    assert.ok(compareCandidates(good, failed) < 0);
    assert.ok(compareCandidates(failed, good) > 0);
  });

  it('orders by score descending', () => {
    const low = candidate({ id: 'c1', score: 60 });
    const high = candidate({ id: 'c2', score: 90 });

    assert.ok(compareCandidates(high, low) < 0);
  });

  it('breaks score ties in favour of the smaller diff', () => {
    const small = candidate({ id: 'c1', score: 80, diff: { filesChanged: 1, insertions: 4, deletions: 1 } });
    const large = candidate({ id: 'c2', score: 80, diff: { filesChanged: 9, insertions: 400, deletions: 90 } });

    assert.ok(compareCandidates(small, large) < 0);
  });

  it('breaks diff ties in favour of the faster agent', () => {
    const fast = candidate({ id: 'c1', score: 80, agentDurationMs: 1000 });
    const slow = candidate({ id: 'c2', score: 80, agentDurationMs: 9000 });

    assert.ok(compareCandidates(fast, slow) < 0);
  });

  it('falls back to index for full determinism', () => {
    const first = candidate({ id: 'c1', index: 0, score: 80 });
    const second = candidate({ id: 'c2', index: 1, score: 80 });

    assert.ok(compareCandidates(first, second) < 0);
    assert.equal(compareCandidates(first, first), 0);
  });
});

describe('rankCandidates', () => {
  it('sorts best first without mutating the input', () => {
    const input = [
      candidate({ id: 'c1', index: 0, score: 40 }),
      candidate({ id: 'c2', index: 1, score: 95 }),
      candidate({ id: 'c3', index: 2, status: 'agent-failed', score: 0 }),
      candidate({ id: 'c4', index: 3, score: 70 }),
    ];
    const originalOrder = input.map((entry) => entry.id);

    const ranked = rankCandidates(input);

    assert.deepEqual(ranked.map((entry) => entry.id), ['c2', 'c4', 'c1', 'c3']);
    assert.deepEqual(input.map((entry) => entry.id), originalOrder, 'input must not be reordered');
  });
});

describe('pickWinner', () => {
  it('picks the highest ranked rankable candidate', () => {
    const ranked = rankCandidates([
      candidate({ id: 'c1', index: 0, score: 60 }),
      candidate({ id: 'c2', index: 1, score: 88 }),
    ]);

    assert.equal(pickWinner(ranked, 0)?.id, 'c2');
  });

  it('refuses to promote below the minimum score', () => {
    const ranked = rankCandidates([candidate({ id: 'c1', score: 55 })]);

    assert.equal(pickWinner(ranked, 60), null);
    assert.equal(pickWinner(ranked, 55)?.id, 'c1');
  });

  it('returns null when nothing is rankable', () => {
    const ranked = rankCandidates([
      candidate({ id: 'c1', status: 'agent-failed' }),
      candidate({ id: 'c2', status: 'no-changes' }),
    ]);

    assert.equal(pickWinner(ranked, 0), null);
  });
});

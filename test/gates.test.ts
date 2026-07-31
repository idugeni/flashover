import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseJudgeScore, runGate, runGateBattery, runJudge } from '../src/gates.js';
import type { GateDefinition } from '../src/types.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

const CWD = mkdtempSync(join(tmpdir(), 'flashover-gates-'));

const CTX = { worktreePath: CWD, candidateId: 'c1', runId: 'test-run' };

function gate(overrides: Partial<GateDefinition> & { name: string; run: string }): GateDefinition {
  return { weight: 1, required: false, timeoutMs: 10_000, ...overrides };
}

describe('parseJudgeScore', () => {
  it('reads a bare number on the last line', () => {
    assert.equal(parseJudgeScore('87\n'), 87);
  });

  it('reads a decimal', () => {
    assert.equal(parseJudgeScore('72.5'), 72.5);
  });

  it('ignores narration before the score', () => {
    assert.equal(parseJudgeScore('Looks reasonable overall.\nMinor nits.\n91\n'), 91);
  });

  it('accepts an x/100 form', () => {
    assert.equal(parseJudgeScore('64/100'), 64);
  });

  it('accepts a labelled score', () => {
    assert.equal(parseJudgeScore('score: 45'), 45);
  });

  it('prefers structured JSON output', () => {
    assert.equal(parseJudgeScore('{"score": 78, "reason": "solid"}'), 78);
  });

  it('uses the last JSON object when several are present', () => {
    assert.equal(parseJudgeScore('{"score": 10}\nrevised:\n{"score": 90}'), 90);
  });

  it('clamps out-of-range values', () => {
    assert.equal(parseJudgeScore('120'), 100);
    assert.equal(parseJudgeScore('-5'), 0);
    assert.equal(parseJudgeScore('{"score": 500}'), 100);
  });

  it('returns null when there is no score', () => {
    assert.equal(parseJudgeScore(''), null);
    assert.equal(parseJudgeScore('no idea\n'), null);
    assert.equal(parseJudgeScore('\n\n  \n'), null);
  });
});

describe('runGate', () => {
  it('passes on exit code 0', async () => {
    const result = await runGate(gate({ name: 'ok', run: 'exit 0' }), CTX);

    assert.equal(result.passed, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.name, 'ok');
  });

  it('fails on a non-zero exit code', async () => {
    const result = await runGate(gate({ name: 'bad', run: 'exit 3' }), CTX);

    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 3);
  });

  it('captures stdout and stderr separately', async () => {
    const result = await runGate(gate({ name: 'io', run: 'echo to-out; echo to-err >&2' }), CTX);

    assert.match(result.stdoutTail, /to-out/);
    assert.match(result.stderrTail, /to-err/);
  });

  it('supports shell features in the command', async () => {
    const result = await runGate(gate({ name: 'pipe', run: 'echo hello | grep -q hello && true' }), CTX);
    assert.equal(result.passed, true);
  });

  it('marks a gate that exceeds its timeout', async () => {
    const result = await runGate(gate({ name: 'slow', run: 'sleep 30', timeoutMs: 300 }), CTX);

    assert.equal(result.passed, false);
    assert.equal(result.timedOut, true);
    assert.ok(result.durationMs < 10_000, `killed promptly, took ${result.durationMs}ms`);
  });

  it('exposes gate metadata to the command as environment variables', async () => {
    const result = await runGate(
      gate({ name: 'envcheck', run: 'test "$FLASHOVER_CANDIDATE_ID" = c1 && test "$FLASHOVER_GATE" = envcheck' }),
      CTX,
    );

    assert.equal(result.passed, true);
  });

  it('carries weight and required flags into the result', async () => {
    const result = await runGate(gate({ name: 'w', run: 'true', weight: 7, required: true }), CTX);

    assert.equal(result.weight, 7);
    assert.equal(result.required, true);
  });
});

describe('runGateBattery', () => {
  it('runs every gate when none is required', async () => {
    const outcome = await runGateBattery(
      [gate({ name: 'a', run: 'exit 1' }), gate({ name: 'b', run: 'true' })],
      CTX,
    );

    assert.equal(outcome.results.length, 2);
    assert.equal(outcome.eliminatedBy, null);
  });

  it('stops at the first failing required gate', async () => {
    const outcome = await runGateBattery(
      [
        gate({ name: 'first', run: 'true' }),
        gate({ name: 'blocker', run: 'exit 1', required: true }),
        gate({ name: 'never', run: 'true' }),
      ],
      CTX,
    );

    assert.equal(outcome.eliminatedBy, 'blocker');
    assert.deepEqual(outcome.results.map((r) => r.name), ['first', 'blocker']);
  });

  it('continues past a failing optional gate', async () => {
    const outcome = await runGateBattery(
      [gate({ name: 'optional', run: 'exit 1' }), gate({ name: 'after', run: 'true', required: true })],
      CTX,
    );

    assert.equal(outcome.eliminatedBy, null);
    assert.equal(outcome.results.length, 2);
  });

  it('reports each gate through the callback in order', async () => {
    const seen: string[] = [];
    await runGateBattery([gate({ name: 'x', run: 'true' }), gate({ name: 'y', run: 'true' })], CTX, (result) =>
      seen.push(result.name),
    );

    assert.deepEqual(seen, ['x', 'y']);
  });

  it('handles an empty gate list', async () => {
    const outcome = await runGateBattery([], CTX);
    assert.deepEqual(outcome, { results: [], eliminatedBy: null });
  });
});

describe('runJudge', () => {
  const judge = { run: 'cat >/dev/null; echo 77', weight: 3, timeoutMs: 10_000 };

  it('parses the score from judge stdout', async () => {
    const outcome = await runJudge(judge, 'diff --git a/x b/x\n', CTX);

    assert.equal(outcome.score, 77);
    assert.equal(outcome.failure, null);
  });

  it('feeds the diff to the judge on stdin', async () => {
    const outcome = await runJudge(
      { run: 'grep -q MARKER && echo 100 || echo 0', weight: 3, timeoutMs: 10_000 },
      'diff with MARKER inside\n',
      CTX,
    );

    assert.equal(outcome.score, 100);
  });

  it('returns a null score when the judge exits non-zero', async () => {
    const outcome = await runJudge({ run: 'exit 2', weight: 3, timeoutMs: 10_000 }, 'x', CTX);

    assert.equal(outcome.score, null);
    assert.match(outcome.failure ?? '', /judge command failed/);
  });

  it('returns a null score when the judge emits no number', async () => {
    const outcome = await runJudge({ run: 'cat >/dev/null; echo hmm', weight: 3, timeoutMs: 10_000 }, 'x', CTX);

    assert.equal(outcome.score, null);
    assert.match(outcome.failure ?? '', /did not contain a score/);
  });
});

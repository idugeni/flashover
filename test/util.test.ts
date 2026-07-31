import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clamp, formatDuration, pool, renderTable, slugify, tail, truncate } from '../src/util.js';

describe('pool', () => {
  it('preserves input order regardless of completion order', async () => {
    const delays = [30, 5, 20, 1];
    const results = await pool(delays, 4, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return `${index}:${delay}`;
    });

    assert.deepEqual(results, ['0:30', '1:5', '2:20', '3:1']);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await pool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });

    assert.equal(peak, 3);
  });

  it('propagates the first error after in-flight work settles', async () => {
    let completed = 0;

    await assert.rejects(
      pool([1, 2, 3, 4], 2, async (item) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (item === 2) throw new Error('boom');
        completed += 1;
      }),
      /boom/,
    );

    // The sibling that was already running is allowed to finish.
    assert.ok(completed >= 1);
  });

  it('handles an empty input list', async () => {
    assert.deepEqual(await pool([], 4, async () => 'unused'), []);
  });
});

describe('formatDuration', () => {
  it('scales units with magnitude', () => {
    assert.equal(formatDuration(0), '0ms');
    assert.equal(formatDuration(999), '999ms');
    assert.equal(formatDuration(1500), '1.5s');
    assert.equal(formatDuration(65_000), '1m 05s');
    assert.equal(formatDuration(3_600_000 + 120_000), '1h 02m');
  });

  it('renders a placeholder for nonsense input', () => {
    assert.equal(formatDuration(-1), '-');
    assert.equal(formatDuration(Number.NaN), '-');
  });
});

describe('tail', () => {
  it('returns short text unchanged', () => {
    assert.equal(tail('hello', 100), 'hello');
  });

  it('keeps the end of long text and reports the elision', () => {
    const result = tail('abcdefghij', 4);
    assert.ok(result.includes('ghij'), 'retains the tail');
    assert.ok(result.includes('6 chars elided'), 'reports how much was dropped');
  });
});

describe('truncate', () => {
  it('adds an ellipsis only when it shortens the text', () => {
    assert.equal(truncate('abcdef', 10), 'abcdef');
    assert.equal(truncate('abcdef', 4), 'abc…');
  });
});

describe('slugify', () => {
  it('produces a git-ref-safe slug', () => {
    assert.equal(slugify('Fix the flaky AUTH test!'), 'fix-the-flaky-auth-test');
  });

  it('never returns an empty string', () => {
    assert.equal(slugify('!!!'), 'task');
    assert.equal(slugify(''), 'task');
  });

  it('does not leave a trailing separator after truncation', () => {
    const slug = slugify('aaaa bbbb cccc dddd', 10);
    assert.ok(!slug.endsWith('-'), `unexpected trailing dash in "${slug}"`);
    assert.ok(slug.length <= 10);
  });
});

describe('clamp', () => {
  it('constrains values to the range', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(11, 0, 10), 10);
  });

  it('falls back to the minimum for NaN', () => {
    assert.equal(clamp(Number.NaN, 3, 10), 3);
  });
});

describe('renderTable', () => {
  it('aligns columns and separates the header', () => {
    // Column widths come from the widest cell: 3 for "c10", 5 for "score".
    const table = renderTable(['id', 'score'], [['c1', '100'], ['c10', '5']], [1]);

    assert.deepEqual(table.split('\n'), [
      'id   score',
      '---  -----',
      'c1     100',
      'c10      5',
    ]);
  });

  it('trims trailing padding so lines have no invisible whitespace', () => {
    const table = renderTable(['a', 'bbbb'], [['x', 'y']]);
    for (const line of table.split('\n')) {
      assert.equal(line, line.trimEnd(), `line has trailing whitespace: "${line}"`);
    }
  });
});

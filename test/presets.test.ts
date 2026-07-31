import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PRESETS, presetNames, resolveAgent, substitutePlaceholders } from '../src/presets.js';
import { FlashoverError } from '../src/types.js';

describe('preset registry', () => {
  it('exposes the documented presets', () => {
    const names = presetNames();

    for (const expected of ['claude', 'codex', 'cursor-agent', 'opencode', 'aider']) {
      assert.ok(names.includes(expected), `missing preset ${expected}`);
    }
  });

  it('hides the internal noop helper from the public list', () => {
    assert.ok(!presetNames().includes('noop'));
    assert.ok(PRESETS['noop'] !== undefined, 'but it still exists for smoke tests');
  });

  it('gives every prompt-in-argv preset a {{prompt}} placeholder', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      if (preset.promptMode !== 'arg') continue;
      assert.ok(
        preset.args.some((arg) => arg.includes('{{prompt}}')),
        `preset ${name} would never receive the task`,
      );
    }
  });
});

describe('resolveAgent', () => {
  it('accepts a bare preset name', () => {
    const { agent, count } = resolveAgent('claude');

    assert.equal(agent.name, 'claude');
    assert.equal(agent.command, 'claude');
    assert.equal(count, 1);
  });

  it('honours an explicit count', () => {
    assert.equal(resolveAgent({ preset: 'codex', count: 4 }).count, 4);
  });

  it('overrides individual preset fields', () => {
    const { agent } = resolveAgent({ preset: 'claude', args: ['--print', '{{prompt}}'], name: 'claude-fast' });

    assert.equal(agent.name, 'claude-fast');
    assert.equal(agent.command, 'claude', 'command still comes from the preset');
    assert.deepEqual(agent.args, ['--print', '{{prompt}}']);
  });

  it('supports a fully custom agent with no preset', () => {
    const { agent } = resolveAgent({ name: 'mine', command: './run.sh', args: ['{{prompt}}'] });

    assert.equal(agent.command, './run.sh');
    assert.equal(agent.promptMode, 'arg');
  });

  it('merges env from preset and override', () => {
    const { agent } = resolveAgent({ preset: 'claude', env: { MY_KEY: 'x' } });
    assert.equal(agent.env?.['MY_KEY'], 'x');
  });

  it('rejects an unknown preset with no command', () => {
    assert.throws(
      () => resolveAgent('does-not-exist'),
      (err: unknown) => err instanceof FlashoverError && /Unknown agent preset/.test(err.message),
    );
  });

  it('rejects an entry with neither preset nor command', () => {
    assert.throws(
      () => resolveAgent({}),
      (err: unknown) => err instanceof FlashoverError && /either a "preset" or a "command"/.test(err.message),
    );
  });

  it('rejects a non-positive count', () => {
    assert.throws(
      () => resolveAgent({ preset: 'claude', count: 0 }),
      (err: unknown) => err instanceof FlashoverError && /invalid count/.test(err.message),
    );
  });

  it('rejects promptMode "arg" without a {{prompt}} placeholder', () => {
    assert.throws(
      () => resolveAgent({ command: './run.sh', args: ['--go'], promptMode: 'arg' }),
      (err: unknown) => err instanceof FlashoverError && /no argument contains \{\{prompt\}\}/.test(err.message),
    );
  });

  it('rejects promptMode "file" without a {{promptFile}} placeholder', () => {
    assert.throws(
      () => resolveAgent({ command: './run.sh', args: ['--go'], promptMode: 'file' }),
      (err: unknown) => err instanceof FlashoverError && /no argument contains \{\{promptFile\}\}/.test(err.message),
    );
  });

  it('allows promptMode "stdin" with no placeholders', () => {
    const { agent } = resolveAgent({ command: './run.sh', args: [], promptMode: 'stdin' });
    assert.equal(agent.promptMode, 'stdin');
  });
});

describe('substitutePlaceholders', () => {
  it('replaces known placeholders', () => {
    const args = substitutePlaceholders(['-p', '{{prompt}}', '--dir', '{{worktree}}'], {
      prompt: 'fix the bug',
      worktree: '/tmp/c1',
    });

    assert.deepEqual(args, ['-p', 'fix the bug', '--dir', '/tmp/c1']);
  });

  it('substitutes multiple placeholders inside one argument', () => {
    const args = substitutePlaceholders(['{{candidateId}}-{{index}}'], { candidateId: 'c3', index: '2' });
    assert.deepEqual(args, ['c3-2']);
  });

  it('leaves unknown placeholders visible instead of blanking them', () => {
    // A silent empty string would turn a typo into a baffling agent invocation.
    const args = substitutePlaceholders(['{{typo}}'], { prompt: 'x' });
    assert.deepEqual(args, ['{{typo}}']);
  });

  it('does not treat prompt content as a placeholder source', () => {
    const args = substitutePlaceholders(['{{prompt}}'], { prompt: 'use {{worktree}} literally' });
    assert.deepEqual(args, ['use {{worktree}} literally'], 'substitution must not recurse');
  });
});

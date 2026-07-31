import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ConfigOverrides } from '../src/config.js';
import { findConfigFile, loadConfigFile, resolveConfig } from '../src/config.js';
import type { FlashoverConfig } from '../src/types.js';
import { FlashoverError } from '../src/types.js';
import { setLogLevel } from '../src/log.js';

// Config resolution emits warnings for recoverable oddities; keep test output clean.
setLogLevel('error');

const REPO_ROOT = '/tmp/fake-repo';

function resolve(raw: FlashoverConfig, overrides: ConfigOverrides = {}) {
  return resolveConfig(raw, { prompt: 'do the thing', ...overrides }, {
    repoRoot: REPO_ROOT,
    configDir: REPO_ROOT,
  });
}

/** Minimal valid config: one agent and one scored gate. */
const BASE: FlashoverConfig = {
  agent: 'claude',
  gates: { scored: [{ name: 'test', run: 'npm test', weight: 5, required: true }] },
};

describe('resolveConfig defaults', () => {
  it('applies documented defaults', () => {
    const config = resolve(BASE);

    assert.equal(config.candidates, 3);
    assert.equal(config.concurrency, 3);
    assert.equal(config.agentTimeoutMs, 20 * 60 * 1000);
    assert.equal(config.baseRef, 'HEAD');
    assert.equal(config.keep, 'winner');
    assert.equal(config.promote.mode, 'branch');
    assert.equal(config.promote.branchPrefix, 'flashover/');
    assert.equal(config.minScore, 0);
    assert.equal(config.judge, null);
    assert.deepEqual(config.seed, { copy: [], link: [] });
    assert.equal(config.workDir, join(REPO_ROOT, '.flashover'));
  });

  it('scales a single-agent roster to the requested candidate count', () => {
    const config = resolve(BASE, { candidates: 5 });

    assert.equal(config.candidates, 5);
    assert.equal(config.roster.length, 1);
    assert.equal(config.roster[0]?.count, 5);
  });

  it('caps concurrency at the candidate count', () => {
    const config = resolve(BASE, { candidates: 2, concurrency: 99 });
    assert.equal(config.concurrency, 2);
  });

  it('derives the candidate total from an explicit multi-agent roster', () => {
    const config = resolve({
      ...BASE,
      agents: [{ preset: 'claude', count: 2 }, { preset: 'codex' }],
    });

    assert.equal(config.candidates, 3);
    assert.equal(config.roster.length, 2);
  });

  it('converts a seconds timeout override into milliseconds', () => {
    const config = resolve(BASE, { agentTimeoutMs: 90_000 });
    assert.equal(config.agentTimeoutMs, 90_000);
  });
});

describe('resolveConfig prompts', () => {
  it('prefers the CLI prompt over the config file', () => {
    const config = resolve({ ...BASE, prompt: 'from file' }, { prompt: 'from cli' });
    assert.equal(config.prompt, 'from cli');
  });

  it('falls back to the config file prompt', () => {
    const config = resolveConfig({ ...BASE, prompt: 'from file' }, {}, {
      repoRoot: REPO_ROOT,
      configDir: REPO_ROOT,
    });
    assert.equal(config.prompt, 'from file');
  });

  it('reads a prompt file relative to the config directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flashover-prompt-'));
    writeFileSync(join(dir, 'task.md'), '  Implement the thing.  \n', 'utf8');

    const config = resolveConfig(BASE, { promptFile: 'task.md' }, { repoRoot: dir, configDir: dir });

    assert.equal(config.prompt, 'Implement the thing.');
  });

  it('rejects a run with no prompt at all', () => {
    assert.throws(
      () => resolveConfig(BASE, {}, { repoRoot: REPO_ROOT, configDir: REPO_ROOT }),
      (err: unknown) => err instanceof FlashoverError && /No task prompt/.test(err.message),
    );
  });

  it('rejects a missing prompt file', () => {
    assert.throws(
      () => resolveConfig(BASE, { promptFile: 'nope.md' }, { repoRoot: REPO_ROOT, configDir: REPO_ROOT }),
      (err: unknown) => err instanceof FlashoverError && /Prompt file not found/.test(err.message),
    );
  });

  it('rejects an inline prompt combined with --prompt-file', () => {
    // Ambiguous intent: guessing which one the user meant is worse than asking.
    assert.throws(
      () => resolve(BASE, { promptFile: 'task.md' }),
      (err: unknown) => err instanceof FlashoverError && /Both a task argument and --prompt-file/.test(err.message),
    );
  });

  it('lets --prompt-file override a prompt set in the config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flashover-override-'));
    writeFileSync(join(dir, 'task.md'), 'from the file\n', 'utf8');

    const config = resolveConfig({ ...BASE, prompt: 'from config' }, { promptFile: 'task.md' }, {
      repoRoot: dir,
      configDir: dir,
    });

    assert.equal(config.prompt, 'from the file');
  });
});

describe('resolveConfig validation', () => {
  it('requires a way to rank candidates', () => {
    assert.throws(
      () => resolve({ agent: 'claude' }),
      (err: unknown) => err instanceof FlashoverError && /cannot be ranked/.test(err.message),
    );
  });

  it('accepts a judge as the only scoring mechanism', () => {
    const config = resolve({ agent: 'claude', judge: { run: 'my-judge', weight: 4 } });

    assert.equal(config.scoredGates.length, 0);
    assert.equal(config.judge?.weight, 4);
  });

  it('rejects a configuration whose total weight is zero', () => {
    assert.throws(
      () => resolve({ agent: 'claude', gates: { scored: [{ name: 'test', run: 'npm test', weight: 0 }] } }),
      (err: unknown) => err instanceof FlashoverError && /weight is zero/.test(err.message),
    );
  });

  it('requires an agent', () => {
    assert.throws(
      () => resolve({ gates: { scored: [{ name: 't', run: 'true' }] } }),
      (err: unknown) => err instanceof FlashoverError && /No agent configured/.test(err.message),
    );
  });

  it('rejects duplicate gate names', () => {
    assert.throws(
      () =>
        resolve({
          agent: 'claude',
          gates: { scored: [{ name: 'test', run: 'a' }, { name: 'test', run: 'b' }] },
        }),
      (err: unknown) => err instanceof FlashoverError && /Duplicate gate name/.test(err.message),
    );
  });

  it('rejects a gate with no command', () => {
    assert.throws(
      () => resolve({ agent: 'claude', gates: { scored: [{ name: 'test' }] } }),
      (err: unknown) => err instanceof FlashoverError && /non-empty "run"/.test(err.message),
    );
  });

  it('rejects an unknown promote mode', () => {
    assert.throws(
      () => resolve(BASE, { promoteMode: 'teleport' as never }),
      (err: unknown) => err instanceof FlashoverError && /promote\.mode/.test(err.message),
    );
  });

  it('rejects an out-of-range minScore', () => {
    assert.throws(
      () => resolve(BASE, { minScore: 101 }),
      (err: unknown) => err instanceof FlashoverError && /minScore/.test(err.message),
    );
  });

  it('rejects a config declaring a future schema version', () => {
    assert.throws(
      () => resolve({ ...BASE, version: 99 }),
      (err: unknown) => err instanceof FlashoverError && /understands up to/.test(err.message),
    );
  });

  it('forces setup gates to be required and unweighted', () => {
    const config = resolve({
      ...BASE,
      gates: {
        setup: [{ name: 'install', run: 'npm ci', required: false, weight: 9 }],
        scored: [{ name: 'test', run: 'npm test', weight: 5 }],
      },
    });

    const setup = config.setupGates[0];
    assert.equal(setup?.required, true, 'a failed setup step makes scoring meaningless');
    assert.equal(setup?.weight, 0);
  });
});

describe('inline gate syntax', () => {
  it('parses name, command, required flag, and weight', () => {
    const config = resolve(BASE, { gates: ['!test:npm test*5'] });
    const gate = config.scoredGates[0];

    assert.equal(gate?.name, 'test');
    assert.equal(gate?.run, 'npm test');
    assert.equal(gate?.required, true);
    assert.equal(gate?.weight, 5);
  });

  it('defaults to optional with weight 1', () => {
    const config = resolve(BASE, { gates: ['lint:npm run lint'] });
    const gate = config.scoredGates[0];

    assert.equal(gate?.required, false);
    assert.equal(gate?.weight, 1);
  });

  it('keeps colons inside the command', () => {
    const config = resolve(BASE, { gates: ['check:sh -c "echo a:b"'] });
    assert.equal(config.scoredGates[0]?.run, 'sh -c "echo a:b"');
  });

  it('generates a name when only a command is given', () => {
    const config = resolve(BASE, { gates: ['npm test'] });
    assert.equal(config.scoredGates[0]?.name, 'gate1');
    assert.equal(config.scoredGates[0]?.run, 'npm test');
  });

  it('replaces file-configured gates entirely', () => {
    const config = resolve(BASE, { gates: ['only:true'] });
    assert.equal(config.scoredGates.length, 1);
    assert.equal(config.scoredGates[0]?.name, 'only');
  });
});

describe('inline agent syntax', () => {
  it('parses a count suffix', () => {
    const config = resolve(BASE, { agents: ['claude:2'] });

    assert.equal(config.candidates, 2);
    assert.equal(config.roster[0]?.count, 2);
  });

  it('merges repeated identical agents into one roster entry', () => {
    const config = resolve(BASE, { agents: ['claude', 'claude', 'codex'] });

    assert.equal(config.roster.length, 2);
    assert.equal(config.roster[0]?.count, 2);
    assert.equal(config.candidates, 3);
  });

  it('rejects an unknown preset', () => {
    assert.throws(
      () => resolve(BASE, { agents: ['nonexistent-agent'] }),
      (err: unknown) => err instanceof FlashoverError && /Unknown agent preset/.test(err.message),
    );
  });

  it('keeps agents with different timeouts as separate roster entries', () => {
    // Merging these would apply one agent's limit to the other, quietly undoing
    // the only reason to set a per-agent timeout in the first place.
    const config = resolve({
      ...BASE,
      agents: [
        { preset: 'claude', timeoutMs: 60_000 },
        { preset: 'claude', timeoutMs: 600_000 },
      ],
    });

    assert.equal(config.roster.length, 2);
    assert.equal(config.candidates, 2);
  });

  it('still merges identical agents that share a timeout', () => {
    const config = resolve({
      ...BASE,
      agents: [
        { preset: 'claude', timeoutMs: 60_000 },
        { preset: 'claude', timeoutMs: 60_000 },
      ],
    });

    assert.equal(config.roster.length, 1);
    assert.equal(config.roster[0]?.count, 2);
  });
});

describe('seed resolution', () => {
  it('merges config and CLI seed paths', () => {
    const config = resolve({ ...BASE, seed: { link: ['node_modules'] } }, { seedCopy: ['.env'] });

    assert.deepEqual(config.seed.link, ['node_modules']);
    assert.deepEqual(config.seed.copy, ['.env']);
  });

  it('normalizes redundant path syntax and removes duplicates', () => {
    const config = resolve(BASE, { seedLink: ['./node_modules/', 'node_modules'] });
    assert.deepEqual(config.seed.link, ['node_modules']);
  });

  it('rejects paths escaping the repository', () => {
    assert.throws(
      () => resolve(BASE, { seedLink: ['../secrets'] }),
      (err: unknown) => err instanceof FlashoverError && /relative path inside the repository/.test(err.message),
    );
    assert.throws(
      () => resolve(BASE, { seedCopy: ['/etc/passwd'] }),
      (err: unknown) => err instanceof FlashoverError && /relative path inside the repository/.test(err.message),
    );
  });

  it('rejects a path listed as both copy and link', () => {
    assert.throws(
      () => resolve(BASE, { seedLink: ['node_modules'], seedCopy: ['node_modules'] }),
      (err: unknown) => err instanceof FlashoverError && /both seed\.link and seed\.copy/.test(err.message),
    );
  });
});

describe('config file discovery and parsing', () => {
  it('finds a config file by walking up to the stop directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'flashover-find-'));
    const nested = join(root, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'flashover.yaml'), 'version: 1\n', 'utf8');

    assert.equal(findConfigFile(nested, root), join(realpathSync(root), 'flashover.yaml'));
  });

  it('returns null when nothing is found before the stop directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'flashover-none-'));
    assert.equal(findConfigFile(root, root), null);
  });

  it('stops at the repository root even when reached through a symlink', () => {
    // Reproduces the macOS default, where /tmp and /var are symlinks into
    // /private while git reports resolved paths. Without resolving both sides,
    // the stop comparison never matches and the walk escapes the repository,
    // picking up an unrelated config from a parent directory.
    const outer = mkdtempSync(join(tmpdir(), 'flashover-symlink-'));
    const repoRoot = join(outer, 'repo');
    mkdirSync(join(repoRoot, 'packages', 'app'), { recursive: true });

    // A config that lives outside the repository and must never be selected.
    writeFileSync(join(outer, 'flashover.yaml'), 'version: 1\n', 'utf8');

    const linkedRepo = join(outer, 'repo-link');
    symlinkSync(repoRoot, linkedRepo);

    assert.equal(findConfigFile(join(linkedRepo, 'packages', 'app'), repoRoot), null);
  });

  it('finds a config inside the repository when reached through a symlink', () => {
    const outer = mkdtempSync(join(tmpdir(), 'flashover-symlink-hit-'));
    const repoRoot = join(outer, 'repo');
    mkdirSync(join(repoRoot, 'packages', 'app'), { recursive: true });
    writeFileSync(join(repoRoot, 'flashover.yaml'), 'version: 1\n', 'utf8');

    const linkedRepo = join(outer, 'repo-link');
    symlinkSync(repoRoot, linkedRepo);

    // The returned path is symlink-resolved, matching what git would report.
    assert.equal(
      findConfigFile(join(linkedRepo, 'packages', 'app'), repoRoot),
      join(realpathSync(repoRoot), 'flashover.yaml'),
    );
  });

  it('parses YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flashover-yaml-'));
    const path = join(dir, 'flashover.yaml');
    writeFileSync(path, 'version: 1\nagent: claude\ncandidates: 4\n', 'utf8');

    const raw = loadConfigFile(path);

    assert.equal(raw.agent, 'claude');
    assert.equal(raw.candidates, 4);
  });

  it('parses JSON through the same loader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flashover-json-'));
    const path = join(dir, 'flashover.json');
    writeFileSync(path, '{"agent":"codex","candidates":2}', 'utf8');

    const raw = loadConfigFile(path);

    assert.equal(raw.agent, 'codex');
    assert.equal(raw.candidates, 2);
  });

  it('treats an empty file as an empty config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flashover-empty-'));
    const path = join(dir, 'flashover.yaml');
    writeFileSync(path, '', 'utf8');

    assert.deepEqual(loadConfigFile(path), {});
  });

  it('rejects a top-level sequence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flashover-list-'));
    const path = join(dir, 'flashover.yaml');
    writeFileSync(path, '- a\n- b\n', 'utf8');

    assert.throws(
      () => loadConfigFile(path),
      (err: unknown) => err instanceof FlashoverError && /mapping at the top level/.test(err.message),
    );
  });

  it('rejects malformed YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flashover-bad-'));
    const path = join(dir, 'flashover.yaml');
    writeFileSync(path, 'a: [1,\n', 'utf8');

    assert.throws(
      () => loadConfigFile(path),
      (err: unknown) => err instanceof FlashoverError && /not valid YAML\/JSON/.test(err.message),
    );
  });
});

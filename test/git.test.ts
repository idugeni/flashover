import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { execFile } from '../src/exec.js';
import * as git from '../src/git.js';
import { FlashoverError } from '../src/types.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

describe('parseNumstat', () => {
  it('sums insertions and deletions across files', () => {
    const stat = git.parseNumstat('3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n');

    assert.deepEqual(stat, { filesChanged: 2, insertions: 13, deletions: 1 });
  });

  it('counts binary files without line counts', () => {
    const stat = git.parseNumstat('-\t-\tassets/logo.png\n5\t2\tsrc/a.ts\n');

    assert.equal(stat.filesChanged, 2);
    assert.equal(stat.insertions, 5);
    assert.equal(stat.deletions, 2);
  });

  it('returns zeros for empty output', () => {
    assert.deepEqual(git.parseNumstat(''), { filesChanged: 0, insertions: 0, deletions: 0 });
    assert.deepEqual(git.parseNumstat('\n\n'), { filesChanged: 0, insertions: 0, deletions: 0 });
  });

  it('ignores malformed lines', () => {
    assert.equal(git.parseNumstat('garbage\n1\t1\tok.ts\n').filesChanged, 1);
  });
});

/**
 * Integration coverage for the worktree lifecycle. These exercise real git,
 * because the isolation guarantees flashover advertises are only meaningful if
 * git actually behaves as assumed.
 */
describe('worktree lifecycle', () => {
  let repoRoot: string;
  let baseSha: string;

  const run = async (args: string[], cwd = repoRoot): Promise<string> => {
    const result = await execFile('git', args, { cwd, timeoutMs: 30_000 });
    assert.ok(result.code === 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };

  before(async () => {
    // Symlink-resolved, because git reports real paths and macOS puts /var behind a symlink.
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'flashover-repo-')));
    await run(['init', '-b', 'main']);
    await run(['config', 'user.name', 'Test User']);
    await run(['config', 'user.email', 'test@example.com']);
    await writeFile(join(repoRoot, 'app.txt'), 'original\n', 'utf8');
    // Directory-only pattern, matching the overwhelmingly common real-world form
    // (`node_modules/`). Its interaction with symlinked seeds is tested below.
    await writeFile(join(repoRoot, '.gitignore'), 'ignored-dir/\n', 'utf8');
    // Must exist before check-ignore can match a directory-only pattern.
    await mkdir(join(repoRoot, 'ignored-dir'), { recursive: true });
    await writeFile(join(repoRoot, 'ignored-dir', 'dep.txt'), 'dependency\n', 'utf8');
    await run(['add', '-A']);
    await run(['commit', '-m', 'initial']);
    baseSha = await run(['rev-parse', 'HEAD']);
  });

  after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('finds the repository root from a subdirectory', async () => {
    const nested = join(repoRoot, 'a', 'b');
    await mkdir(nested, { recursive: true });

    assert.equal(await git.findRepoRoot(nested), repoRoot);
  });

  it('rejects a directory that is not a repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'flashover-not-repo-'));
    await assert.rejects(
      git.findRepoRoot(outside),
      (err: unknown) => err instanceof FlashoverError && /Not inside a git repository/.test(err.message),
    );
  });

  it('resolves and rejects revisions', async () => {
    assert.equal(await git.revParse(repoRoot, 'HEAD'), baseSha);
    await assert.rejects(
      git.revParse(repoRoot, 'no-such-ref'),
      (err: unknown) => err instanceof FlashoverError && /Cannot resolve base revision/.test(err.message),
    );
  });

  it('reports the current branch and clean status', async () => {
    assert.equal(await git.currentBranch(repoRoot), 'main');
    assert.deepEqual(await git.statusLines(repoRoot), []);
  });

  it('adds .flashover/ to .git/info/exclude without touching .gitignore', async () => {
    const gitignoreBefore = await readFile(join(repoRoot, '.gitignore'), 'utf8');

    await git.ensureArtifactsIgnored(repoRoot);
    // Idempotent: a second call must not duplicate the entry.
    await git.ensureArtifactsIgnored(repoRoot);

    const exclude = await readFile(join(repoRoot, '.git', 'info', 'exclude'), 'utf8');
    const occurrences = exclude.split('\n').filter((line) => line.trim() === '.flashover/').length;

    assert.equal(occurrences, 1);
    assert.equal(await readFile(join(repoRoot, '.gitignore'), 'utf8'), gitignoreBefore);
  });

  it('captures a candidate diff, commits it, and promotes a branch', async () => {
    const worktreePath = join(repoRoot, '.flashover', 'test-run', 'c1');

    await git.addWorktree(repoRoot, worktreePath, baseSha);
    assert.ok(existsSync(join(worktreePath, 'app.txt')), 'worktree is populated from the base revision');

    // Stand in for an agent editing the tree.
    await writeFile(join(worktreePath, 'app.txt'), 'original\nagent line\n', 'utf8');
    await writeFile(join(worktreePath, 'new-file.txt'), 'brand new\n', 'utf8');

    assert.equal(await git.hasNoStagedChanges(worktreePath), true, 'nothing staged before add');
    await git.stageAll(worktreePath);
    assert.equal(await git.hasNoStagedChanges(worktreePath), false);

    const stat = await git.stagedDiffStat(worktreePath);
    assert.equal(stat.filesChanged, 2);
    assert.equal(stat.insertions, 2);

    const patchPath = join(repoRoot, '.flashover', 'test-run', 'patches', 'c1.patch');
    await git.exportStagedPatch(worktreePath, patchPath);
    const patch = await readFile(patchPath, 'utf8');
    assert.match(patch, /new-file\.txt/);
    assert.match(patch, /\+agent line/);

    const commitSha = await git.commitStaged(worktreePath, 'candidate c1');
    assert.match(commitSha, /^[0-9a-f]{40}$/);

    const branch = await git.uniqueBranchName(repoRoot, 'flashover/test-task');
    await git.createBranchAt(repoRoot, branch, commitSha);

    assert.equal(await git.branchExists(repoRoot, branch), true);
    assert.equal(await run(['rev-parse', branch]), commitSha);

    // The whole point: the user's checkout is untouched.
    assert.equal(await git.currentBranch(repoRoot), 'main');
    assert.equal(await readFile(join(repoRoot, 'app.txt'), 'utf8'), 'original\n');

    // The commit must survive removal of the worktree that produced it.
    await git.removeWorktree(repoRoot, worktreePath);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(await run(['cat-file', '-t', commitSha]), 'commit');
  });

  it('generates a fresh name when a branch already exists', async () => {
    await git.createBranchAt(repoRoot, 'flashover/collide', baseSha);

    assert.equal(await git.uniqueBranchName(repoRoot, 'flashover/collide'), 'flashover/collide-2');
  });

  it('reports no staged changes when an agent does nothing', async () => {
    const worktreePath = join(repoRoot, '.flashover', 'test-run', 'c2');
    await git.addWorktree(repoRoot, worktreePath, baseSha);

    await git.stageAll(worktreePath);

    assert.equal(await git.hasNoStagedChanges(worktreePath), true);
    await git.removeWorktree(repoRoot, worktreePath);
  });

  it('replaces a leftover worktree directory from a crashed run', async () => {
    const worktreePath = join(repoRoot, '.flashover', 'test-run', 'c3');
    await mkdir(worktreePath, { recursive: true });
    await writeFile(join(worktreePath, 'stale.txt'), 'junk\n', 'utf8');

    await git.addWorktree(repoRoot, worktreePath, baseSha);

    assert.ok(existsSync(join(worktreePath, 'app.txt')));
    assert.equal(existsSync(join(worktreePath, 'stale.txt')), false);
    await git.removeWorktree(repoRoot, worktreePath);
  });

  it('seeds a gitignored path by symlink without polluting the diff', async () => {
    const worktreePath = join(repoRoot, '.flashover', 'test-run', 'c4');

    await git.addWorktree(repoRoot, worktreePath, baseSha);
    assert.equal(existsSync(join(worktreePath, 'ignored-dir')), false, 'fresh worktrees omit ignored paths');

    await git.seedWorktree(repoRoot, worktreePath, { link: ['ignored-dir'] });
    assert.equal(await readFile(join(worktreePath, 'ignored-dir', 'dep.txt'), 'utf8'), 'dependency\n');

    // Regression guard: git's `ignored-dir/` pattern does NOT match a symlink, so
    // without seedWorktree registering an explicit exclude the link itself would
    // be staged and counted as the agent's work.
    await git.stageAll(worktreePath);
    assert.equal(await git.hasNoStagedChanges(worktreePath), true, 'symlinked seed leaked into the diff');

    await git.removeWorktree(repoRoot, worktreePath);
  });

  it('seeds a gitignored path by copy without polluting the diff', async () => {
    const worktreePath = join(repoRoot, '.flashover', 'test-run', 'c6');

    await git.addWorktree(repoRoot, worktreePath, baseSha);
    await git.seedWorktree(repoRoot, worktreePath, { copy: ['ignored-dir'] });

    assert.equal(await readFile(join(worktreePath, 'ignored-dir', 'dep.txt'), 'utf8'), 'dependency\n');

    await git.stageAll(worktreePath);
    assert.equal(await git.hasNoStagedChanges(worktreePath), true);

    await git.removeWorktree(repoRoot, worktreePath);
  });

  it('skips seed paths that do not exist in the repository', async () => {
    const worktreePath = join(repoRoot, '.flashover', 'test-run', 'c7');
    await git.addWorktree(repoRoot, worktreePath, baseSha);

    // Missing seeds are a warning, not a failure: a shared config may list
    // node_modules for a repo that has not been installed yet.
    await git.seedWorktree(repoRoot, worktreePath, { link: ['does-not-exist'], copy: ['also-missing'] });

    assert.equal(existsSync(join(worktreePath, 'does-not-exist')), false);
    await git.removeWorktree(repoRoot, worktreePath);
  });

  it('distinguishes tracked from untracked paths', async () => {
    assert.equal(await git.isPathTracked(repoRoot, 'app.txt'), true);
    assert.equal(await git.isPathTracked(repoRoot, 'ignored-dir'), false);
    assert.equal(await git.isPathTracked(repoRoot, 'nope.txt'), false);
  });

  it('lists only non-main worktrees', async () => {
    const worktreePath = join(repoRoot, '.flashover', 'test-run', 'c5');
    await git.addWorktree(repoRoot, worktreePath, baseSha);

    const listed = await git.listWorktrees(repoRoot);

    assert.ok(listed.some((path) => path.endsWith('c5')), 'includes the candidate worktree');
    assert.ok(!listed.includes(repoRoot), 'excludes the main worktree');

    await git.removeWorktree(repoRoot, worktreePath);
  });
});

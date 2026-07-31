/**
 * Git plumbing and worktree isolation.
 *
 * Isolation model: each candidate gets its own `git worktree` checked out at a
 * detached base revision under `.flashover/`. Agents are free to trash their
 * worktree; the user's working tree is never touched, not even by the promotion
 * step, which creates a branch pointer with `git branch <name> <sha>` rather
 * than checking anything out.
 */

import { existsSync } from 'node:fs';
import { cp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { DiffStat } from './types.js';
import { FlashoverError } from './types.js';
import { execFile, succeeded, describeFailure } from './exec.js';
import type { ExecResult } from './exec.js';
import { log } from './log.js';

/** Timeout for ordinary git plumbing commands. */
const GIT_TIMEOUT_MS = 60_000;

/** Longer timeout for commands that touch the whole tree. */
const GIT_SLOW_TIMEOUT_MS = 10 * 60_000;

/** Identity used when the repository has no configured committer. */
const FALLBACK_IDENTITY = { name: 'flashover', email: 'flashover@localhost' } as const;

/** Run git and return the result without throwing. */
async function git(args: readonly string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<ExecResult> {
  return execFile('git', args, { cwd, timeoutMs });
}

/** Run git, throwing a {@link FlashoverError} on failure. */
async function gitOrThrow(args: readonly string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const result = await git(args, cwd, timeoutMs);
  if (!succeeded(result)) {
    const detail = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim();
    throw new FlashoverError(`git ${args.join(' ')} failed (${describeFailure(result)}).`, detail === '' ? undefined : detail);
  }
  return result.stdout.trim();
}

/**
 * Locate the repository root containing `cwd`.
 *
 * @throws {FlashoverError} when `cwd` is not inside a git repository, or the
 * repository has no commits yet.
 */
export async function findRepoRoot(cwd: string): Promise<string> {
  const probe = await git(['rev-parse', '--show-toplevel'], cwd);
  if (!succeeded(probe)) {
    if (probe.spawnError !== undefined) {
      throw new FlashoverError('git is not installed or not on PATH.', 'flashover uses git worktrees to isolate candidates.');
    }
    throw new FlashoverError(
      `Not inside a git repository: ${cwd}`,
      'flashover isolates each agent in a git worktree, so it needs a repository. Run `git init && git commit` first.',
    );
  }

  const root = probe.stdout.trim();
  const head = await git(['rev-parse', '--verify', 'HEAD'], root);
  if (!succeeded(head)) {
    throw new FlashoverError(
      'This repository has no commits yet, so there is no base revision to branch from.',
      'Make an initial commit, then run flashover again.',
    );
  }
  return root;
}

/** Resolve a revision to a full sha. */
export async function revParse(repoRoot: string, ref: string): Promise<string> {
  const result = await git(['rev-parse', '--verify', `${ref}^{commit}`], repoRoot);
  if (!succeeded(result)) {
    throw new FlashoverError(`Cannot resolve base revision "${ref}".`, 'Pass an existing commit, branch, or tag via --base.');
  }
  return result.stdout.trim();
}

/** Short sha for display. */
export async function shortSha(repoRoot: string, sha: string): Promise<string> {
  const result = await git(['rev-parse', '--short', sha], repoRoot);
  return succeeded(result) ? result.stdout.trim() : sha.slice(0, 7);
}

/** Porcelain status lines for the working tree, empty when clean. */
export async function statusLines(repoRoot: string): Promise<string[]> {
  const output = await gitOrThrow(['status', '--porcelain'], repoRoot);
  return output === '' ? [] : output.split('\n');
}

/** Name of the currently checked out branch, or null when detached. */
export async function currentBranch(repoRoot: string): Promise<string | null> {
  const result = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot);
  return succeeded(result) ? result.stdout.trim() : null;
}

/**
 * Add ignore patterns to `.git/info/exclude`, idempotently.
 *
 * Two deliberate choices:
 *
 *  - **`.git/info/exclude`, not `.gitignore`.** flashover is borrowing the user's
 *    repository and should not leave a tracked-file change behind.
 *  - **The shared exclude file, not a per-worktree one.** Linked worktrees read
 *    ignore rules from the common git directory; a file written to
 *    `.git/worktrees/<name>/info/exclude` has no effect. Verified behaviour,
 *    not an assumption.
 *
 * Failures are logged and swallowed. The worst outcome is cosmetic noise in
 * `git status`, which is not worth aborting a run over.
 */
export async function ensureExcluded(repoRoot: string, patterns: readonly string[]): Promise<void> {
  if (patterns.length === 0) return;
  const excludePath = join(repoRoot, '.git', 'info', 'exclude');

  try {
    let existing = '';
    if (existsSync(excludePath)) existing = await readFile(excludePath, 'utf8');

    const present = new Set(existing.split('\n').map((line) => line.trim()));
    const missing = patterns.filter((pattern) => !present.has(pattern));
    if (missing.length === 0) return;

    await mkdir(dirname(excludePath), { recursive: true });
    const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n';
    await writeFile(excludePath, `${existing}${prefix}# added by flashover\n${missing.join('\n')}\n`, 'utf8');
    log.debug(`Excluded ${missing.join(', ')} via .git/info/exclude`);
  } catch (err) {
    log.debug(`Could not update .git/info/exclude: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Ensure flashover's own artifact directory never shows up as untracked. */
export async function ensureArtifactsIgnored(repoRoot: string): Promise<void> {
  await ensureExcluded(repoRoot, ['.flashover/']);
}

/** Create a detached worktree for `sha` at `worktreePath`. */
export async function addWorktree(repoRoot: string, worktreePath: string, sha: string): Promise<void> {
  await mkdir(dirname(worktreePath), { recursive: true });
  // A leftover directory from a crashed run would make `worktree add` fail.
  if (existsSync(worktreePath)) await removeWorktree(repoRoot, worktreePath);

  const result = await git(['worktree', 'add', '--detach', worktreePath, sha], repoRoot, GIT_SLOW_TIMEOUT_MS);
  if (!succeeded(result)) {
    throw new FlashoverError(
      `Failed to create worktree at ${worktreePath} (${describeFailure(result)}).`,
      result.stderr.trim() || 'Try `git worktree prune` and run again.',
    );
  }
}

/**
 * Remove a worktree, falling back to a plain directory delete.
 *
 * Agents sometimes leave processes holding files open, which makes
 * `git worktree remove` refuse. Since the worktree is disposable by
 * construction, deleting the directory and pruning the registry is safe.
 */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  const result = await git(['worktree', 'remove', '--force', worktreePath], repoRoot, GIT_SLOW_TIMEOUT_MS);
  if (succeeded(result)) return;

  try {
    await rm(worktreePath, { recursive: true, force: true });
  } catch (err) {
    log.debug(`Could not delete ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await git(['worktree', 'prune'], repoRoot);
}

/** Drop worktree registry entries whose directories are gone. */
export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await git(['worktree', 'prune'], repoRoot);
}

/** Absolute paths of registered worktrees, excluding the main one. */
export async function listWorktrees(repoRoot: string): Promise<string[]> {
  const output = await gitOrThrow(['worktree', 'list', '--porcelain'], repoRoot);
  const paths: string[] = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const path = resolve(line.slice('worktree '.length).trim());
    if (path !== resolve(repoRoot)) paths.push(path);
  }
  return paths;
}

/**
 * Populate a fresh worktree with paths from the main repository.
 *
 * Fresh worktrees lack gitignored build inputs such as `node_modules` or
 * `.env`, which most verification gates need. Copying is slow but safe; linking
 * is instant but shared, so an agent that mutates a linked directory affects
 * every candidate. Callers choose per path.
 */
export async function seedWorktree(
  repoRoot: string,
  worktreePath: string,
  seed: { copy?: readonly string[]; link?: readonly string[] },
): Promise<void> {
  const requested = [...(seed.link ?? []), ...(seed.copy ?? [])];

  // Seeded paths must be invisible to `git add -A`, or they would be attributed
  // to the agent and inflate every candidate's diff.
  //
  // The usual ignore rule for these paths is directory-only, e.g. `node_modules/`.
  // A trailing slash does not match a *symlink* to a directory, so a linked seed
  // would be staged despite the repository "ignoring" it. Registering each path
  // without a trailing slash closes that gap for links and copies alike.
  await ensureExcluded(repoRoot, requested);

  for (const relative of seed.link ?? []) {
    const source = join(repoRoot, relative);
    const target = join(worktreePath, relative);
    if (!existsSync(source)) {
      log.debug(`seed.link skipped, missing in repo: ${relative}`);
      continue;
    }
    if (existsSync(target)) continue;
    await mkdir(dirname(target), { recursive: true });
    await symlink(source, target);
  }

  for (const relative of seed.copy ?? []) {
    const source = join(repoRoot, relative);
    const target = join(worktreePath, relative);
    if (!existsSync(source)) {
      log.debug(`seed.copy skipped, missing in repo: ${relative}`);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true, dereference: false });
  }
}

/**
 * True when `relativePath` is ignored by the repository's ignore rules.
 *
 * Used to warn about seed paths that would otherwise be staged as if the agent
 * had created them, silently inflating every candidate's diff.
 */
export async function isPathIgnored(repoRoot: string, relativePath: string): Promise<boolean> {
  const result = await git(['check-ignore', '--quiet', '--no-index', relativePath], repoRoot);
  // Exit 0 means ignored, 1 means not ignored, anything else is an error.
  return result.code === 0;
}

/**
 * True when git tracks `relativePath`.
 *
 * Seeding a tracked path is a configuration mistake worth surfacing: flashover
 * excludes seeded paths from candidate diffs, so real changes to a tracked path
 * would be silently discarded.
 */
export async function isPathTracked(repoRoot: string, relativePath: string): Promise<boolean> {
  const result = await git(['ls-files', '--error-unmatch', '--', relativePath], repoRoot);
  return result.code === 0;
}

/** Stage every change in a worktree, including untracked and deleted files. */
export async function stageAll(worktreePath: string): Promise<void> {
  await gitOrThrow(['add', '-A'], worktreePath, GIT_SLOW_TIMEOUT_MS);
}

/**
 * Diff statistics for staged changes.
 *
 * Binary files report `-` for both counts in numstat; they are counted as
 * changed files contributing zero lines.
 */
export async function stagedDiffStat(worktreePath: string): Promise<DiffStat> {
  const output = await gitOrThrow(['diff', '--cached', '--numstat'], worktreePath, GIT_SLOW_TIMEOUT_MS);
  return parseNumstat(output);
}

/** Parse `git diff --numstat` output. Exported for unit testing. */
export function parseNumstat(output: string): DiffStat {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    filesChanged += 1;
    const added = Number.parseInt(parts[0] ?? '', 10);
    const removed = Number.parseInt(parts[1] ?? '', 10);
    if (Number.isFinite(added)) insertions += added;
    if (Number.isFinite(removed)) deletions += removed;
  }

  return { filesChanged, insertions, deletions };
}

/** True when the worktree has no staged changes relative to HEAD. */
export async function hasNoStagedChanges(worktreePath: string): Promise<boolean> {
  const result = await git(['diff', '--cached', '--quiet'], worktreePath, GIT_SLOW_TIMEOUT_MS);
  // `--quiet` exits 0 when there is no diff, 1 when there is one.
  return result.code === 0;
}

/**
 * Export staged changes as a patch file.
 *
 * `--binary` is used so the patch round-trips through `git apply` even when
 * binary assets changed.
 */
export async function exportStagedPatch(worktreePath: string, outputPath: string): Promise<void> {
  const result = await git(['diff', '--cached', '--binary'], worktreePath, GIT_SLOW_TIMEOUT_MS);
  if (!succeeded(result)) {
    throw new FlashoverError(`Failed to export patch from ${worktreePath} (${describeFailure(result)}).`, result.stderr.trim() || undefined);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.stdout, 'utf8');
}

/**
 * Commit all staged changes in a worktree and return the new commit sha.
 *
 * A fallback identity is supplied when the repository has none configured, so
 * flashover works on freshly cloned CI checkouts.
 */
export async function commitStaged(worktreePath: string, message: string): Promise<string> {
  const identityArgs = await resolveIdentityArgs(worktreePath);
  await gitOrThrow(
    [...identityArgs, 'commit', '--no-verify', '--no-gpg-sign', '-m', message],
    worktreePath,
    GIT_SLOW_TIMEOUT_MS,
  );
  return gitOrThrow(['rev-parse', 'HEAD'], worktreePath);
}

async function resolveIdentityArgs(cwd: string): Promise<string[]> {
  const name = await git(['config', '--get', 'user.name'], cwd);
  const email = await git(['config', '--get', 'user.email'], cwd);
  const args: string[] = [];
  if (!succeeded(name) || name.stdout.trim() === '') {
    args.push('-c', `user.name=${FALLBACK_IDENTITY.name}`);
  }
  if (!succeeded(email) || email.stdout.trim() === '') {
    args.push('-c', `user.email=${FALLBACK_IDENTITY.email}`);
  }
  return args;
}

/** True when a local branch of this name exists. */
export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const result = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot);
  return result.code === 0;
}

/** Append `-2`, `-3`, ... until the branch name is free. */
export async function uniqueBranchName(repoRoot: string, desired: string): Promise<string> {
  if (!(await branchExists(repoRoot, desired))) return desired;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${desired}-${suffix}`;
    if (!(await branchExists(repoRoot, candidate))) return candidate;
  }
  throw new FlashoverError(`Could not find an unused branch name based on "${desired}".`);
}

/**
 * Point a new branch at an existing commit.
 *
 * Deliberately does not check the branch out: the user's working tree and index
 * stay exactly as they were before flashover ran.
 */
export async function createBranchAt(repoRoot: string, branch: string, sha: string): Promise<void> {
  const result = await git(['branch', branch, sha], repoRoot);
  if (!succeeded(result)) {
    throw new FlashoverError(`Failed to create branch "${branch}" (${describeFailure(result)}).`, result.stderr.trim() || undefined);
  }
}

/** Verify a patch applies cleanly to the current working tree. */
export async function patchApplies(repoRoot: string, patchPath: string): Promise<boolean> {
  const result = await git(['apply', '--check', patchPath], repoRoot, GIT_SLOW_TIMEOUT_MS);
  return result.code === 0;
}

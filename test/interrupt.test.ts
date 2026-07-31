/**
 * Interruption behaviour.
 *
 * The CLI makes a specific promise about Ctrl-C: agents are stopped, a partial
 * report is still written, and the exit code is 130. Everything about that is
 * load-bearing — a run abandoned halfway is exactly when you most want to know
 * what the agents had done — and until now it rested entirely on reading the
 * code.
 *
 * Tested against the real CLI as a child process, with a real signal. Anything
 * less would be testing the abort plumbing rather than the promise.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { RunReport } from '../src/types.js';

/** The CLI as built by `build:test`, so this test needs no separate build step. */
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

/** SIGINT has no faithful equivalent on Windows, which the package does not target. */
const SKIP_REASON = process.platform === 'win32' ? 'POSIX signals only' : undefined;

function setupRepo(): string {
  // Symlink-resolved, because git reports real paths and macOS puts /var behind one.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'flashover-interrupt-')));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  };

  git('init', '-b', 'main');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'app.txt'), 'original\n', 'utf8');

  // An agent that never finishes on its own. The run can only end by being killed.
  const config = [
    'version: 1',
    'agents:',
    '  - name: hanger',
    `    command: ${JSON.stringify(process.execPath)}`,
    `    args: ['-e', 'setInterval(() => {}, 1000)']`,
    '    promptMode: stdin',
    '    count: 2',
    'concurrency: 2',
    'gates:',
    '  scored:',
    '    - name: noop',
    '      run: "true"',
    '      weight: 1',
    'keep: none',
    '',
  ].join('\n');
  writeFileSync(join(repo, 'flashover.yaml'), config, 'utf8');

  git('add', '-A');
  git('commit', '-m', 'baseline');
  return repo;
}

/** Newest run directory, or null while none exists yet. */
function latestRunDir(repo: string): string | null {
  const workDir = join(repo, '.flashover');
  if (!existsSync(workDir)) return null;
  const runs = readdirSync(workDir).filter((name) => name.startsWith('run-')).sort();
  const latest = runs.at(-1);
  return latest === undefined ? null : join(workDir, latest);
}

/**
 * Resolve once an agent transcript exists.
 *
 * The transcript is opened before the agent is spawned, so its presence is the
 * earliest reliable proof that the run reached the stage where a SIGINT is
 * meaningful — the handler is installed well before this point.
 */
async function waitForAgentStart(repo: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const runDir = latestRunDir(repo);
    if (runDir !== null) {
      const logPath = join(runDir, 'logs', 'c1.log');
      if (existsSync(logPath) && readFileSync(logPath, 'utf8').includes('# started:')) return;
    }
    if (Date.now() > deadline) throw new Error('agent never started');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('interruption', () => {
  it(
    'stops the agents, writes a partial report, and exits 130',
    { skip: SKIP_REASON, timeout: 90_000 },
    async () => {
      const repo = setupRepo();

      const child = spawn(process.execPath, [CLI, 'hang forever', '--no-live', '--quiet'], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Drained rather than ignored: an undrained pipe can block the child, and
      // stderr is what explains an unexpected exit code.
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.stdout?.resume();

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('close', (code, signal) => resolve({ code, signal }));
      });

      await waitForAgentStart(repo, 30_000);
      child.kill('SIGINT');

      const result = await exited;

      // 130 is part of the documented contract, distinct from 1 (no acceptable
      // winner) and 2 (usage error). A caller has to be able to tell "cancelled"
      // from "the agents all failed".
      assert.equal(
        result.code,
        130,
        `expected exit 130, got code ${String(result.code)} signal ${String(result.signal)}\nstderr:\n${stderr}`,
      );

      const runDir = latestRunDir(repo);
      assert.ok(runDir !== null, 'no run directory was created');

      const reportPath = join(runDir, 'report.json');
      assert.ok(existsSync(reportPath), 'a cancelled run must still leave a report');

      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as RunReport;
      assert.equal(report.candidates.length, 2, 'every planned candidate belongs in the report');
      assert.equal(report.winnerId, null, 'a cancelled run has no winner');

      // Nothing was verified, so nothing may be promoted.
      assert.equal(report.promotedBranch, null);

      for (const candidate of report.candidates) {
        assert.ok(
          candidate.status === 'agent-failed' || candidate.status === 'error',
          `candidate ${candidate.id} ended as "${candidate.status}", which claims more than an interrupted run knows`,
        );
      }

      // The guarantee that matters most: interrupting flashover must not damage
      // the repository it borrowed.
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      assert.equal(branch, 'main', 'the user was left on a different branch');

      const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
      assert.equal(status, '', 'the working tree was left dirty');

      // A worktree still registered but missing would make the next run fail.
      const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' });
      assert.ok(!worktrees.includes('prunable'), `stale worktree registration survived:\n${worktrees}`);

      // And the proof that it does not: a fresh run has to be able to start.
      // `--dry-run` reaches config resolution and the dirty-tree check without
      // spending anything, which is where a damaged repository would surface.
      const followUp = spawn(process.execPath, [CLI, 'anything', '--dry-run', '--quiet'], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      followUp.stdout?.resume();
      followUp.stderr?.resume();
      const followUpCode = await new Promise<number | null>((resolve) => {
        followUp.on('close', (code) => resolve(code));
      });
      assert.equal(followUpCode, 0, 'the repository was left unusable for the next run');
    },
  );
});

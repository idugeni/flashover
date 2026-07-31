import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { commandExists, describeFailure, execFile, execShell, posixShellAvailable, succeeded } from '../src/exec.js';

const CWD = mkdtempSync(join(tmpdir(), 'flashover-exec-'));

describe('execFile', () => {
  it('captures stdout of a successful command', async () => {
    const result = await execFile('echo', ['hello'], { cwd: CWD });

    assert.ok(succeeded(result));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /hello/);
  });

  it('reports a non-zero exit without throwing', async () => {
    const result = await execFile('sh', ['-c', 'exit 7'], { cwd: CWD });

    assert.equal(result.code, 7);
    assert.equal(succeeded(result), false);
    assert.equal(describeFailure(result), 'exit code 7');
  });

  it('reports a missing binary as a spawn error rather than rejecting', async () => {
    const result = await execFile('flashover-definitely-not-a-real-binary', [], { cwd: CWD });

    assert.equal(succeeded(result), false);
    assert.match(result.spawnError ?? '', /Command not found/);
    assert.equal(describeFailure(result), result.spawnError);
  });

  it('does not pass arguments through a shell', async () => {
    // With shell interpretation this would expand; as a literal argv entry it
    // must survive verbatim.
    const result = await execFile('echo', ['$HOME'], { cwd: CWD });
    assert.match(result.stdout.trim(), /^\$HOME$/);
  });

  it('injects environment overrides', async () => {
    const result = await execFile('sh', ['-c', 'echo "$FLASHOVER_TEST_VAR"'], {
      cwd: CWD,
      env: { FLASHOVER_TEST_VAR: 'present' },
    });

    assert.match(result.stdout, /present/);
  });

  it('can unset an inherited variable', async () => {
    process.env['FLASHOVER_TO_REMOVE'] = 'x';
    try {
      const result = await execFile('sh', ['-c', 'echo "[${FLASHOVER_TO_REMOVE-unset}]"'], {
        cwd: CWD,
        env: { FLASHOVER_TO_REMOVE: undefined },
      });
      assert.match(result.stdout, /\[unset\]/);
    } finally {
      delete process.env['FLASHOVER_TO_REMOVE'];
    }
  });

  it('runs in the requested working directory', async () => {
    const result = await execFile('pwd', [], { cwd: CWD });
    // macOS reports /private/var for /var, so compare the trailing segment.
    assert.ok(result.stdout.trim().endsWith(CWD.split('/').pop() ?? ''), result.stdout);
  });
});

describe('execShell', () => {
  it('supports pipes and operators', async () => {
    const result = await execShell('printf "a\\nb\\n" | wc -l', { cwd: CWD });

    assert.ok(succeeded(result));
    assert.equal(result.stdout.trim(), '2');
  });

  it('writes input to stdin', async () => {
    const result = await execShell('cat', { cwd: CWD, input: 'piped payload' });
    assert.match(result.stdout, /piped payload/);
  });

  it('leaves stdin closed when no input is given', async () => {
    // Without stdin wired to /dev/null this would hang until the timeout.
    const result = await execShell('cat', { cwd: CWD, timeoutMs: 5000 });

    assert.equal(result.timedOut, false);
    assert.ok(succeeded(result));
  });
});

describe('timeouts', () => {
  it('kills a process that exceeds its timeout', async () => {
    const started = Date.now();
    const result = await execShell('sleep 30', { cwd: CWD, timeoutMs: 300 });

    assert.equal(result.timedOut, true);
    assert.equal(succeeded(result), false);
    assert.equal(describeFailure(result), 'timed out');
    assert.ok(Date.now() - started < 10_000, 'returned promptly');
  });

  it('kills the whole process tree, not just the direct child', async () => {
    // The shell backgrounds a grandchild that would outlive a naive kill and
    // create the marker file after the parent is gone.
    const marker = join(CWD, `orphan-${Date.now()}.marker`);
    const result = await execShell(`sh -c '(sleep 2; touch ${marker}) & sleep 30'`, {
      cwd: CWD,
      timeoutMs: 300,
    });

    assert.equal(result.timedOut, true);

    // Wait past the point where a surviving grandchild would have written it.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(existsSync(marker), false, 'grandchild survived the timeout kill');
  });
});

describe('abort signal', () => {
  it('terminates a running process when aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const result = await execShell('sleep 30', { cwd: CWD, signal: controller.signal });

    assert.equal(succeeded(result), false);
    assert.equal(result.timedOut, false, 'an abort is not a timeout');
  });

  it('does not start a process that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await execShell('sleep 30', { cwd: CWD, signal: controller.signal });
    assert.equal(succeeded(result), false);
  });
});

describe('output limits', () => {
  it('caps retained output and keeps the tail', async () => {
    const result = await execShell('for i in $(seq 1 5000); do echo "line $i"; done', {
      cwd: CWD,
      maxBufferChars: 2000,
    });

    assert.ok(result.stdout.length <= 2000, `retained ${result.stdout.length} chars`);
    assert.match(result.stdout, /line 5000/, 'the most recent output is what explains a failure');
  });

  it('streams chunks to the callback as they arrive', async () => {
    const chunks: string[] = [];
    await execShell('echo one; echo two', { cwd: CWD, onStdout: (chunk) => chunks.push(chunk) });

    assert.match(chunks.join(''), /one/);
    assert.match(chunks.join(''), /two/);
  });

  it('writes stdout to a file verbatim, ignoring the cap', async () => {
    // The escape hatch that keeps large patches intact. Deliberately spawns node
    // rather than a shell, so the guarantee is tested on every platform.
    const target = join(CWD, `stdout-path-${Date.now()}.out`);
    const size = 400_000;

    const result = await execFile(process.execPath, ['-e', `process.stdout.write('x'.repeat(${size}))`], {
      cwd: CWD,
      stdoutPath: target,
      // Far below the payload: proves the cap does not apply to this path.
      maxBufferChars: 1000,
    });

    assert.ok(succeeded(result), `exec failed: ${result.spawnError ?? result.stderr}`);
    assert.equal(result.stdout, '', 'buffered stdout stays empty in file mode');
    assert.equal(statSync(target).size, size, 'file must hold the whole payload');
  });

  it('resolves only after the stdout file has flushed', async () => {
    // The child can close before its output finishes draining, so a caller that
    // reads the file the moment exec resolves would otherwise see a short read.
    const target = join(CWD, `stdout-flush-${Date.now()}.out`);
    const size = 2_000_000;

    await execFile(process.execPath, ['-e', `process.stdout.write('y'.repeat(${size}))`], {
      cwd: CWD,
      stdoutPath: target,
    });

    assert.equal(statSync(target).size, size);
  });
});

describe('commandExists', () => {
  it('finds a binary that is present', async () => {
    // git rather than sh: flashover requires git unconditionally, and this
    // resolver deliberately no longer depends on a shell being installed.
    assert.equal(await commandExists('git'), true);
  });

  it('reports a binary that is absent', async () => {
    assert.equal(await commandExists('flashover-definitely-not-a-real-binary'), false);
  });

  it('resolves without spawning a shell', async () => {
    // Regression: the old implementation asked `sh -c "command -v ..."`, so
    // wherever sh is missing every binary was reported missing — including git,
    // on the same doctor run that had just used git to read the repository.
    assert.equal(await commandExists('node'), true);
  });

  it('checks an explicit path directly instead of searching PATH', async () => {
    assert.equal(await commandExists(process.execPath), true);
    assert.equal(await commandExists(join(CWD, 'nope-not-here')), false);
  });

  it('rejects an empty name', async () => {
    assert.equal(await commandExists('   '), false);
  });
});

describe('posixShellAvailable', () => {
  it('agrees with PATH resolution of sh', async () => {
    // Two independent mechanisms — actually spawning the shell versus resolving
    // it on PATH — must not disagree. Their disagreement was the bug: doctor
    // reported binaries as missing based on a shell it never verified existed.
    assert.equal(await posixShellAvailable(), await commandExists('sh'));
  });
});

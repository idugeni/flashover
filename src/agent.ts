/**
 * Agent invocation.
 *
 * One rule dominates this module: **nothing flashover writes may land inside the
 * candidate worktree.** Results are measured by diffing the worktree, so a
 * prompt file or log dropped in there would show up as if the agent had authored
 * it. Prompt files and logs therefore live in the run directory under
 * `.flashover/`, and only their paths are handed to the agent.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentDefinition } from './types.js';
import { execFile } from './exec.js';
import type { ExecResult } from './exec.js';
import { substitutePlaceholders } from './presets.js';
import { log } from './log.js';

export interface AgentRunContext {
  agent: AgentDefinition;
  /** The task description handed to the agent. */
  prompt: string;
  /** Absolute path to this candidate's isolated worktree. */
  worktreePath: string;
  /** Short candidate id such as `c2`. */
  candidateId: string;
  /** Zero-based candidate index. */
  index: number;
  /** Identifier of the enclosing run, exposed to the agent as an env var. */
  runId: string;
  /** Absolute path for the captured transcript. Outside the worktree. */
  logPath: string;
  /** Directory for auxiliary files such as the prompt file. Outside the worktree. */
  scratchDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AgentRunOutcome {
  /** The fully substituted command line that was executed. */
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  /** Set when the agent binary could not be launched at all. */
  spawnError?: string;
  logPath: string;
}

/**
 * Run a single agent against a single worktree.
 *
 * Resolves even when the agent fails; the caller decides what a non-zero exit
 * means. Output is streamed to `logPath` as it arrives so a long run can be
 * tailed live with `tail -f`.
 */
export async function runAgent(ctx: AgentRunContext): Promise<AgentRunOutcome> {
  await mkdir(dirname(ctx.logPath), { recursive: true });
  await mkdir(ctx.scratchDir, { recursive: true });

  // Written outside the worktree so it never appears in the candidate's diff.
  const promptFilePath = join(ctx.scratchDir, `${ctx.candidateId}.prompt.txt`);
  if (ctx.agent.promptMode === 'file') {
    await writeFile(promptFilePath, ctx.prompt, 'utf8');
  }

  const args = substitutePlaceholders(ctx.agent.args, {
    prompt: ctx.prompt,
    promptFile: promptFilePath,
    worktree: ctx.worktreePath,
    candidateId: ctx.candidateId,
    index: String(ctx.index),
  });

  const logStream = createWriteStream(ctx.logPath, { flags: 'a' });
  const header = [
    `# flashover candidate ${ctx.candidateId}`,
    `# agent: ${ctx.agent.name}`,
    `# command: ${[ctx.agent.command, ...args].join(' ')}`,
    `# worktree: ${ctx.worktreePath}`,
    `# started: ${new Date().toISOString()}`,
    '',
    '',
  ].join('\n');
  logStream.write(header);

  log.debug(`${ctx.candidateId}: exec ${[ctx.agent.command, ...args].join(' ')}`);

  let result: ExecResult;
  try {
    result = await execFile(ctx.agent.command, args, {
      cwd: ctx.worktreePath,
      timeoutMs: ctx.timeoutMs,
      env: {
        ...(ctx.agent.env ?? {}),
        FLASHOVER: '1',
        FLASHOVER_RUN_ID: ctx.runId,
        FLASHOVER_CANDIDATE_ID: ctx.candidateId,
        FLASHOVER_CANDIDATE_INDEX: String(ctx.index),
        FLASHOVER_WORKTREE: ctx.worktreePath,
        FLASHOVER_PROMPT_FILE: promptFilePath,
        // Agents that respect this render plain, parseable output.
        NO_COLOR: '1',
      },
      ...(ctx.agent.promptMode === 'stdin' ? { input: ctx.prompt } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      onStdout: (chunk) => logStream.write(chunk),
      onStderr: (chunk) => logStream.write(chunk),
    });
  } finally {
    await new Promise<void>((resolveClose) => logStream.end(resolveClose));
  }

  const outcome: AgentRunOutcome = {
    command: result.command,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    logPath: ctx.logPath,
  };
  if (result.spawnError !== undefined) outcome.spawnError = result.spawnError;
  return outcome;
}

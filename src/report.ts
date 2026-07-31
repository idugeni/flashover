/**
 * Report persistence and rendering.
 *
 * Every run leaves a machine-readable `report.json` next to its worktrees. That
 * file is the contract for anything downstream: CI summaries, dashboards, or a
 * later `flashover report` invocation. The human-facing renderers in this module
 * are derived views over it, never a separate source of truth.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CandidateResult, RunReport } from './types.js';
import { FlashoverError } from './types.js';
import { formatDuration, renderTable, truncate } from './util.js';
import { isRankable, rankCandidates } from './score.js';
import { style } from './log.js';

/** Filename used for the machine-readable report inside a run directory. */
export const REPORT_FILENAME = 'report.json';

/** Persist a report as pretty-printed JSON. */
export async function writeReport(runDir: string, report: RunReport): Promise<string> {
  const path = join(runDir, REPORT_FILENAME);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

/** Read and parse a previously written report. */
export async function readReport(path: string): Promise<RunReport> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new FlashoverError(`No report found at ${path}.`, 'Run flashover first, or pass a path to an existing report.json.');
  }
  try {
    return JSON.parse(text) as RunReport;
  } catch (err) {
    throw new FlashoverError(`Report at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Locate the most recent run directory under `.flashover/`.
 *
 * Run ids are timestamp-prefixed, so lexicographic order is chronological.
 */
export async function findLatestRunDir(workDir: string): Promise<string | null> {
  if (!existsSync(workDir)) return null;
  const entries = await readdir(workDir, { withFileTypes: true });
  const runDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-'))
    .map((entry) => entry.name)
    .sort();
  const latest = runDirs.at(-1);
  return latest === undefined ? null : join(workDir, latest);
}

/** Short status label plus colour for terminal output. */
function statusLabel(candidate: CandidateResult): string {
  switch (candidate.status) {
    case 'winner':
      return style.green('WINNER');
    case 'scored':
      return 'scored';
    case 'eliminated':
      return style.red(`cut: ${candidate.eliminatedBy ?? 'gate'}`);
    case 'no-changes':
      return style.yellow('no changes');
    case 'agent-failed':
      return style.red('agent failed');
    case 'error':
      return style.red('error');
    case 'running':
    case 'verifying':
    case 'pending':
      return style.gray(candidate.status);
    default:
      return candidate.status;
  }
}

/** `3/4` summary of scored gate outcomes, counting only gates that ran. */
function gateSummary(candidate: CandidateResult): string {
  const scored = candidate.gates.filter((gate) => gate.weight > 0);
  if (scored.length === 0) return '-';
  const passed = scored.filter((gate) => gate.passed).length;
  return `${passed}/${scored.length}`;
}

function diffSummary(candidate: CandidateResult): string {
  if (candidate.diff === null) return '-';
  const { filesChanged, insertions, deletions } = candidate.diff;
  return `${filesChanged}f +${insertions}/-${deletions}`;
}

function scoreCell(candidate: CandidateResult): string {
  if (!isRankable(candidate)) return '-';
  const text = candidate.score.toFixed(1);
  if (candidate.status === 'winner') return style.bold(style.green(text));
  return text;
}

/**
 * Render the leaderboard table.
 *
 * Candidates are always shown, including failures. Seeing that four of five
 * agents broke the build is the most useful signal a run can produce.
 */
export function renderLeaderboard(report: RunReport): string {
  const ranked = rankCandidates(report.candidates);
  const rows = ranked.map((candidate, position) => [
    isRankable(candidate) ? `${position + 1}` : '-',
    candidate.id,
    truncate(candidate.agentName, 16),
    statusLabel(candidate),
    scoreCell(candidate),
    gateSummary(candidate),
    diffSummary(candidate),
    formatDuration(candidate.agentDurationMs),
  ]);

  return renderTable(
    ['#', 'id', 'agent', 'status', 'score', 'gates', 'diff', 'agent time'],
    rows,
    [0, 4],
  );
}

/**
 * Detail block for candidates that failed, with the tail of the output that
 * explains why. Returns an empty string when everything passed.
 */
export function renderFailureDetails(report: RunReport, maxChars = 1200): string {
  const sections: string[] = [];

  for (const candidate of report.candidates) {
    const failedGates = candidate.gates.filter((gate) => !gate.passed);
    const hasProblem =
      candidate.status === 'agent-failed' ||
      candidate.status === 'error' ||
      candidate.status === 'no-changes' ||
      failedGates.length > 0;
    if (!hasProblem) continue;

    const lines: string[] = [`${style.bold(candidate.id)} (${candidate.agentName}) — ${statusLabel(candidate)}`];

    if (candidate.error !== undefined) {
      lines.push(`  error: ${candidate.error}`);
    }
    if (candidate.status === 'agent-failed') {
      const reason = candidate.agentTimedOut ? 'timed out' : `exit code ${String(candidate.agentExitCode)}`;
      lines.push(`  agent ${reason} — transcript: ${candidate.logPath}`);
    }
    if (candidate.status === 'no-changes') {
      lines.push(`  agent exited cleanly but left no changes — transcript: ${candidate.logPath}`);
    }

    for (const gate of failedGates) {
      const reason = gate.timedOut ? 'timed out' : `exit ${String(gate.exitCode)}`;
      lines.push(`  gate ${style.red(gate.name)} ${reason}${gate.required ? ' (required)' : ''}`);
      const output = (gate.stderrTail.trim() === '' ? gate.stdoutTail : gate.stderrTail).trim();
      if (output !== '') {
        for (const line of truncate(output, maxChars).split('\n')) {
          lines.push(`    ${style.gray(line)}`);
        }
      }
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * Markdown summary suitable for a PR body or a CI job summary.
 *
 * Kept free of ANSI escapes, unlike the terminal renderers above.
 */
export function renderMarkdownReport(report: RunReport): string {
  const ranked = rankCandidates(report.candidates);
  const lines: string[] = [
    '## flashover results',
    '',
    `**Task:** ${report.prompt.split('\n')[0] ?? ''}`,
    '',
    `Base \`${report.baseSha.slice(0, 7)}\` · ${report.candidates.length} candidates · ${formatDuration(report.durationMs)}`,
    '',
    '| # | id | agent | status | score | gates | diff | agent time |',
    '| --- | --- | --- | --- | --: | --- | --- | --- |',
  ];

  for (const [position, candidate] of ranked.entries()) {
    const plainStatus =
      candidate.status === 'eliminated' ? `cut: ${candidate.eliminatedBy ?? 'gate'}` : candidate.status;
    lines.push(
      `| ${isRankable(candidate) ? position + 1 : '-'} | ${candidate.id} | ${candidate.agentName} | ${plainStatus} ` +
        `| ${isRankable(candidate) ? candidate.score.toFixed(1) : '-'} | ${gateSummary(candidate)} ` +
        `| ${diffSummary(candidate)} | ${formatDuration(candidate.agentDurationMs)} |`,
    );
  }

  lines.push('');
  if (report.winnerId === null) {
    lines.push('**No winner promoted.** No candidate met the required gates and minimum score.');
  } else {
    lines.push(`**Winner:** \`${report.winnerId}\``);
    if (report.promotedBranch !== null) lines.push(`**Branch:** \`${report.promotedBranch}\``);
    if (report.promotedPatch !== null) lines.push(`**Patch:** \`${report.promotedPatch}\``);
  }

  return lines.join('\n');
}

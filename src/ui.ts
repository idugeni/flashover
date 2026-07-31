/**
 * Live terminal view for a running tournament.
 *
 * Two renderers share one interface. On a TTY, a fixed block of candidate rows
 * is redrawn in place. Everywhere else, including CI logs and pipes, each state
 * transition is emitted as a single append-only line, because overwriting output
 * in a log file produces unreadable garbage.
 */

import type { CandidateResult, CandidateStatus } from './types.js';
import type { TournamentEvent } from './tournament.js';
import { formatDuration, renderTable, truncate } from './util.js';
import { log, style, supportsLiveRender } from './log.js';

export interface LiveView {
  handle(event: TournamentEvent): void;
  /** Tear down timers and leave the cursor in a sane state. */
  stop(): void;
}

/** Row state tracked per candidate while the run is in flight. */
interface Row {
  id: string;
  agentName: string;
  status: CandidateStatus;
  detail: string;
  startedAt: number | null;
  finishedAt: number | null;
  gatesPassed: number;
  gatesRun: number;
}

/**
 * Build the appropriate view.
 *
 * @param forcePlain disable in-place rendering even on a TTY, e.g. for `--no-live`.
 */
export function createLiveView(forcePlain = false): LiveView {
  return supportsLiveRender && !forcePlain ? new InPlaceView() : new PlainView();
}

/** Human-readable label for a status, without colour. */
function plainStatus(row: Row): string {
  switch (row.status) {
    case 'running':
      return 'running agent';
    case 'verifying':
      return row.detail === '' ? 'verifying' : `gate: ${row.detail}`;
    case 'eliminated':
      return `eliminated (${row.detail})`;
    case 'no-changes':
      return 'no changes';
    case 'agent-failed':
      return 'agent failed';
    default:
      return row.status;
  }
}

function colourFor(status: CandidateStatus): (text: string) => string {
  switch (status) {
    case 'winner':
    case 'scored':
      return style.green;
    case 'eliminated':
    case 'agent-failed':
    case 'error':
      return style.red;
    case 'no-changes':
      return style.yellow;
    case 'running':
    case 'verifying':
      return style.cyan;
    default:
      return style.gray;
  }
}

/** Statuses after which the elapsed timer should stop. */
const TERMINAL_STATUSES: readonly CandidateStatus[] = [
  'scored',
  'winner',
  'eliminated',
  'no-changes',
  'agent-failed',
  'error',
];

/** Shared bookkeeping for both renderers. */
abstract class BaseView implements LiveView {
  protected rows = new Map<string, Row>();
  protected total = 0;

  handle(event: TournamentEvent): void {
    switch (event.type) {
      case 'run-start':
        this.total = event.total;
        this.onStart(event.baseSha, event.runDir);
        break;

      case 'candidate-update': {
        this.upsert(event.candidate, event.detail);
        this.onChange(event.candidate.id);
        break;
      }

      case 'gate-finished': {
        const row = this.rows.get(event.candidateId);
        if (row !== undefined) {
          row.gatesRun += 1;
          if (event.gate.passed) row.gatesPassed += 1;
          row.detail = event.gate.name;
        }
        this.onChange(event.candidateId);
        break;
      }

      case 'promoting':
        this.onChange(event.candidateId);
        break;

      case 'run-finished':
        this.stop();
        break;

      default:
        break;
    }
  }

  protected upsert(candidate: CandidateResult, detail?: string): Row {
    const existing = this.rows.get(candidate.id);
    const row: Row = existing ?? {
      id: candidate.id,
      agentName: candidate.agentName,
      status: candidate.status,
      detail: '',
      startedAt: null,
      finishedAt: null,
      gatesPassed: 0,
      gatesRun: 0,
    };

    const wasTerminal = TERMINAL_STATUSES.includes(row.status);
    row.status = candidate.status;
    row.agentName = candidate.agentName;

    if (candidate.status === 'running' && row.startedAt === null) row.startedAt = Date.now();
    if (!wasTerminal && TERMINAL_STATUSES.includes(candidate.status)) row.finishedAt = Date.now();

    if (candidate.status === 'eliminated') row.detail = candidate.eliminatedBy ?? 'gate';
    else if (detail !== undefined) row.detail = detail;

    this.rows.set(candidate.id, row);
    return row;
  }

  protected elapsed(row: Row): string {
    if (row.startedAt === null) return '-';
    const end = row.finishedAt ?? Date.now();
    return formatDuration(end - row.startedAt);
  }

  protected abstract onStart(baseSha: string, runDir: string): void;
  protected abstract onChange(candidateId: string): void;
  abstract stop(): void;
}

/** Append-only renderer for pipes, CI, and dumb terminals. */
class PlainView extends BaseView {
  private lastPrinted = new Map<string, string>();

  protected override onStart(baseSha: string, runDir: string): void {
    log.info(`Igniting ${this.total} candidates from ${baseSha.slice(0, 7)}`);
    log.info(`Artifacts: ${runDir}`);
    log.blank();
  }

  protected override onChange(candidateId: string): void {
    const row = this.rows.get(candidateId);
    if (row === undefined) return;

    // Only print when the meaningful part of the line actually changed,
    // otherwise a long run floods the log with duplicates.
    const line = `${row.id} ${row.agentName} ${plainStatus(row)}`;
    if (this.lastPrinted.get(candidateId) === line) return;
    this.lastPrinted.set(candidateId, line);

    const colour = colourFor(row.status);
    log.info(`  ${style.bold(row.id.padEnd(4))} ${row.agentName.padEnd(14)} ${colour(plainStatus(row))}`);
  }

  override stop(): void {
    // Nothing to unwind: no timers and no cursor manipulation.
  }
}

/** In-place block renderer for interactive terminals. */
class InPlaceView extends BaseView {
  private linesDrawn = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  protected override onStart(baseSha: string, runDir: string): void {
    log.info(`${style.bold('flashover')} igniting ${style.bold(String(this.total))} candidates from ${style.cyan(baseSha.slice(0, 7))}`);
    log.info(style.gray(`artifacts: ${runDir}`));
    log.blank();

    // Redraw on a timer so elapsed times advance even while nothing changes.
    this.timer = setInterval(() => this.draw(), 1000);
    // Do not hold the event loop open on account of the display.
    this.timer.unref();
  }

  protected override onChange(): void {
    this.draw();
  }

  private draw(): void {
    if (this.stopped) return;

    const rows = [...this.rows.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    const table = renderTable(
      ['id', 'agent', 'state', 'gates', 'elapsed'],
      rows.map((row) => [
        row.id,
        truncate(row.agentName, 16),
        colourFor(row.status)(plainStatus(row)),
        row.gatesRun === 0 ? '-' : `${row.gatesPassed}/${row.gatesRun}`,
        this.elapsed(row),
      ]),
      [4],
    );

    const output = table.split('\n');
    this.rewind();
    process.stderr.write(`${output.join('\n')}\n`);
    this.linesDrawn = output.length;
  }

  /**
   * Move the cursor back to the top of the previously drawn block and clear
   * everything below it.
   */
  private rewind(): void {
    if (this.linesDrawn === 0) return;
    // Cursor up N lines, then erase from cursor to end of screen. Clearing to the
    // end rather than line by line keeps the display consistent even if the
    // block shrinks between frames.
    process.stderr.write(`\u001B[${this.linesDrawn}A\u001B[0J`);
  }

  override stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    // Leave the final frame on screen; the caller prints the leaderboard next.
    this.linesDrawn = 0;
    process.stderr.write('\n');
  }
}

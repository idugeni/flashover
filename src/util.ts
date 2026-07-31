/** Small dependency-free helpers shared across modules. */

import { randomBytes } from 'node:crypto';

/**
 * Run `worker` over `items` with at most `limit` in flight at once.
 *
 * Results are returned in input order regardless of completion order. The pool
 * does not swallow errors: if a worker rejects, the returned promise rejects
 * once the already-started workers settle.
 */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const effectiveLimit = Math.max(1, Math.min(Math.floor(limit), items.length || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;
  let firstError: unknown;

  const runners = Array.from({ length: effectiveLimit }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      // `noUncheckedIndexedAccess` widens this to T | undefined; the bounds
      // check above guarantees it is present.
      const item = items[index] as T;
      try {
        results[index] = await worker(item, index);
      } catch (err) {
        if (firstError === undefined) firstError = err;
        return;
      }
    }
  });

  await Promise.all(runners);
  if (firstError !== undefined) throw firstError;
  return results;
}

/** Format a millisecond duration as a compact human string, e.g. `1m 04s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Keep only the last `maxChars` characters of `text`, prefixing an elision
 * marker when content was dropped.
 */
export function tail(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `...[${text.length - maxChars} chars elided]...\n${text.slice(text.length - maxChars)}`;
}

/** Truncate to `max` characters with a trailing ellipsis. */
export function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Collapse arbitrary text into a git-ref-safe slug. */
export function slugify(text: string, maxLength = 32): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug === '' ? 'task' : slug;
}

/** Constrain `value` to the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Timestamp-based run id, sortable and filesystem safe.
 * Example: `20260731-055412-338-9f3a`, as `date-time-millis-random`.
 *
 * Both trailing segments earn their place:
 *
 * - **Milliseconds** keep lexicographic order chronological at a resolution
 *   finer than a human can start two runs. `findLatestRunDir` sorts run ids as
 *   strings, so a coarser stamp would make "latest" ambiguous for back-to-back
 *   runs and could report the wrong one.
 * - **Random suffix** guarantees two runs never share a directory. Creating a
 *   candidate worktree clears any leftover directory at its path, so a collision
 *   would delete a concurrent run's worktree from under it.
 */
export function makeRunId(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const millis = String(now.getMilliseconds()).padStart(3, '0');
  return `${date}-${time}-${millis}-${randomBytes(2).toString('hex')}`;
}

/** Render a plain text table with right-aligned numeric columns. */
export function renderTable(headers: readonly string[], rows: readonly string[][], alignRight: readonly number[] = []): string {
  const widths = headers.map((header, columnIndex) => {
    const cellWidths = rows.map((row) => (row[columnIndex] ?? '').length);
    return Math.max(header.length, ...(cellWidths.length > 0 ? cellWidths : [0]));
  });

  const formatRow = (cells: readonly string[]): string =>
    cells
      .map((cell, columnIndex) => {
        const width = widths[columnIndex] ?? cell.length;
        return alignRight.includes(columnIndex) ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  const separator = widths.map((width) => '-'.repeat(width)).join('  ');
  return [formatRow(headers), separator, ...rows.map(formatRow)].join('\n');
}

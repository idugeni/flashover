/**
 * Minimal logger with ANSI colours that degrade to plain text when the output
 * is not a TTY, when `NO_COLOR` is set, or when `--quiet` is active.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const colorEnabled =
  process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb' && process.stderr.isTTY === true;

function wrap(code: string): (text: string) => string {
  return (text: string) => (colorEnabled ? `\u001B[${code}m${text}\u001B[0m` : text);
}

/** Terminal styling helpers. No-ops when colour is disabled. */
export const style = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

/** True when the terminal supports the cursor movement used by the live view. */
export const supportsLiveRender = colorEnabled;

let currentLevel: LogLevel = 'info';

/** Set the global threshold. Messages below it are dropped. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

/**
 * All diagnostics go to stderr so that stdout stays reserved for machine
 * readable output such as `--json`.
 */
function emit(text: string): void {
  process.stderr.write(`${text}\n`);
}

export const log = {
  debug(message: string): void {
    if (enabled('debug')) emit(`${style.gray('  debug')} ${style.gray(message)}`);
  },
  info(message: string): void {
    if (enabled('info')) emit(message);
  },
  success(message: string): void {
    if (enabled('info')) emit(`${style.green('✓')} ${message}`);
  },
  warn(message: string): void {
    if (enabled('warn')) emit(`${style.yellow('!')} ${message}`);
  },
  error(message: string): void {
    if (enabled('error')) emit(`${style.red('✗')} ${message}`);
  },
  /** Blank separator line, suppressed in quiet mode. */
  blank(): void {
    if (enabled('info')) emit('');
  },
  /** Write pre-formatted text verbatim, e.g. a rendered table. */
  raw(text: string): void {
    if (enabled('info')) emit(text);
  },
};

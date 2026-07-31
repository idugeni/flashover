/**
 * Core type definitions for flashover.
 *
 * Two families of types live here:
 *  - Configuration types: what the user declares (`FlashoverConfig`) and what
 *    the rest of the codebase actually consumes after defaults are applied and
 *    shorthands are expanded (`ResolvedConfig`).
 *  - Result types: the immutable record of what happened during a run, which is
 *    serialized verbatim into `report.json`.
 */

/** Bumped when the on-disk config schema changes incompatibly. */
export const CONFIG_VERSION = 1;

/** Bumped when the on-disk report schema changes incompatibly. */
export const REPORT_VERSION = 1;

/**
 * How an agent CLI expects to receive the task prompt.
 *
 * - `arg`   the prompt is substituted into the argv list via `{{prompt}}`
 * - `stdin` the prompt is written to the process stdin, then stdin is closed
 * - `file`  the prompt is written to a temp file, path substituted via `{{promptFile}}`
 */
export type PromptMode = 'arg' | 'stdin' | 'file';

/** A fully specified, runnable agent invocation. */
export interface AgentDefinition {
  /** Human-readable label shown in the leaderboard, e.g. `claude`. */
  name: string;
  /** Executable to spawn. Never run through a shell. */
  command: string;
  /** Argument list. Entries may contain `{{placeholder}}` tokens. */
  args: readonly string[];
  promptMode: PromptMode;
  /** Extra environment variables layered on top of the parent process env. */
  env?: Readonly<Record<string, string>>;
  /** Optional docs link, surfaced by `flashover doctor`. */
  docs?: string;
}

/** One entry of the expanded roster: an agent plus how many copies to run. */
export interface RosterEntry {
  agent: AgentDefinition;
  count: number;
}

/**
 * A verification gate: a shell command run inside a candidate worktree whose
 * exit code decides pass/fail.
 */
export interface GateDefinition {
  name: string;
  /** Shell command line, executed with `sh -c` inside the candidate worktree. */
  run: string;
  /**
   * Relative contribution to the candidate's score. Ignored for setup gates.
   * Must be >= 0.
   */
  weight: number;
  /** When true, a failure eliminates the candidate outright. */
  required: boolean;
  timeoutMs: number;
  /** Directory relative to the candidate worktree root. */
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

/**
 * An optional external judge. flashover stays model-agnostic: the judge is any
 * command that reads a unified diff on stdin and prints a score from 0-100 as
 * the last non-empty line of stdout.
 */
export interface JudgeDefinition {
  run: string;
  /** Weighted alongside scored gates. */
  weight: number;
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
}

/** What to do with the winning diff. */
export type PromoteMode = 'branch' | 'patch' | 'none';

/** Which candidate worktrees survive after the run. */
export type KeepMode = 'all' | 'winner' | 'none';

/** Raw user-authored configuration. Every field is optional. */
export interface FlashoverConfig {
  version?: number;
  prompt?: string;
  promptFile?: string;
  candidates?: number;
  concurrency?: number;
  agent?: string | AgentConfigInput;
  agents?: Array<string | AgentConfigInput>;
  agentTimeoutMs?: number;
  baseRef?: string;
  gates?: {
    setup?: GateConfigInput[];
    scored?: GateConfigInput[];
  };
  judge?: JudgeConfigInput;
  seed?: SeedConfigInput;
  promote?: {
    mode?: PromoteMode;
    branchPrefix?: string;
  };
  keep?: KeepMode;
  minScore?: number;
}

/**
 * Paths to materialize inside each fresh worktree before agents start.
 *
 * A new worktree contains only tracked files, so gitignored build inputs such as
 * `node_modules` or `.env` are absent and gates like `npm test` would fail for
 * reasons unrelated to the agent's work.
 */
export interface SeedConfigInput {
  /**
   * Copied per candidate. Safe but slow; use when gates or agents may mutate the
   * contents.
   */
  copy?: string[];
  /**
   * Symlinked to the main repository. Instant and disk-cheap, but shared across
   * all candidates, so a candidate that writes through the link affects the
   * others.
   */
  link?: string[];
}

/** Agent as written in a config file: a preset name plus optional overrides. */
export interface AgentConfigInput {
  /** Name of a built-in preset to start from. */
  preset?: string;
  name?: string;
  command?: string;
  args?: string[];
  promptMode?: PromptMode;
  env?: Record<string, string>;
  /** Run this many copies of the agent. Defaults to 1. */
  count?: number;
}

/** Gate as written in a config file. */
export interface GateConfigInput {
  name?: string;
  run?: string;
  weight?: number;
  required?: boolean;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

/** Judge as written in a config file. */
export interface JudgeConfigInput {
  run?: string;
  weight?: number;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** Configuration after defaults, validation, and roster expansion. */
export interface ResolvedConfig {
  version: number;
  prompt: string;
  /** Expanded one entry per agent kind, with counts. */
  roster: RosterEntry[];
  /** Total number of candidates, i.e. the sum of all roster counts. */
  candidates: number;
  concurrency: number;
  agentTimeoutMs: number;
  setupGates: GateDefinition[];
  scoredGates: GateDefinition[];
  judge: JudgeDefinition | null;
  /** Normalized, always present, possibly with empty lists. */
  seed: { copy: string[]; link: string[] };
  promote: {
    mode: PromoteMode;
    branchPrefix: string;
  };
  keep: KeepMode;
  /** Absolute path to the git repository root. */
  repoRoot: string;
  /** Absolute path to the run artifact directory, i.e. `<repoRoot>/.flashover`. */
  workDir: string;
  /** Revision every candidate branches from. */
  baseRef: string;
  /** Winner must reach at least this score, otherwise the run exits non-zero. */
  minScore: number;
}

/** Lifecycle state of a single candidate. */
export type CandidateStatus =
  /** Queued, not started yet. */
  | 'pending'
  /** Agent process is running. */
  | 'running'
  /** Agent finished; gates are running. */
  | 'verifying'
  /** Agent exited cleanly but left the worktree untouched. */
  | 'no-changes'
  /** Agent process itself failed or timed out. */
  | 'agent-failed'
  /** A required gate failed. */
  | 'eliminated'
  /** Completed and scored, but not the winner. */
  | 'scored'
  /** Highest ranked candidate. */
  | 'winner'
  /** Infrastructure error inside flashover, not the agent's fault. */
  | 'error';

/** Outcome of one gate against one candidate. */
export interface GateResult {
  name: string;
  weight: number;
  required: boolean;
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  /** Last few KB of output, for the failure summary. */
  stdoutTail: string;
  stderrTail: string;
}

/** Line/file counts for a candidate's diff. */
export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** Everything flashover knows about one candidate after the run. */
export interface CandidateResult {
  /** Stable short id, e.g. `c1`. */
  id: string;
  /** Zero-based position in the roster expansion. */
  index: number;
  agentName: string;
  status: CandidateStatus;
  worktreePath: string;
  /** Path to the captured agent stdout/stderr log. */
  logPath: string;
  agentExitCode: number | null;
  agentDurationMs: number;
  agentTimedOut: boolean;
  diff: DiffStat | null;
  /** Path to the exported `.patch` file, when changes were produced. */
  patchPath: string | null;
  /** Commit created inside the candidate worktree holding its changes. */
  commitSha: string | null;
  gates: GateResult[];
  /** Raw 0-100 judge score, or null when no judge ran. */
  judgeScore: number | null;
  /** Final weighted score, 0-100. */
  score: number;
  /** Name of the required gate that knocked this candidate out. */
  eliminatedBy: string | null;
  /** Present only for `error` status. */
  error?: string;
}

/** Serialized summary of a complete run. */
export interface RunReport {
  version: number;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  prompt: string;
  /** Resolved sha of `baseRef` at run start. */
  baseSha: string;
  repoRoot: string;
  candidates: CandidateResult[];
  winnerId: string | null;
  promotedBranch: string | null;
  promotedPatch: string | null;
}

/** Thrown for user-facing problems: bad config, dirty repo, missing binary. */
export class FlashoverError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'FlashoverError';
    if (hint !== undefined) this.hint = hint;
  }
}

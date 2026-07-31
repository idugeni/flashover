/**
 * Configuration discovery, validation, and normalization.
 *
 * The CLI never consumes raw user config. Everything funnels through
 * {@link resolveConfig}, which applies defaults, expands shorthands, validates
 * invariants, and hands back a {@link ResolvedConfig} the rest of the code can
 * trust.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type {
  FlashoverConfig,
  GateConfigInput,
  GateDefinition,
  JudgeDefinition,
  KeepMode,
  PromoteMode,
  ResolvedConfig,
  RosterEntry,
} from './types.js';
import { CONFIG_VERSION, FlashoverError } from './types.js';
import { resolveAgent } from './presets.js';
import { log } from './log.js';

/** Candidate config filenames, in discovery order. */
export const CONFIG_FILENAMES = [
  'flashover.yaml',
  'flashover.yml',
  'flashover.json',
  '.flashover.yaml',
  '.flashover.yml',
  '.flashover.json',
] as const;

/** Default values applied when the user is silent. */
export const DEFAULTS = {
  candidates: 3,
  agentTimeoutMs: 20 * 60 * 1000,
  gateTimeoutMs: 10 * 60 * 1000,
  judgeTimeoutMs: 5 * 60 * 1000,
  judgeWeight: 3,
  gateWeight: 1,
  branchPrefix: 'flashover/',
  keep: 'winner' as KeepMode,
  promoteMode: 'branch' as PromoteMode,
  minScore: 0,
  baseRef: 'HEAD',
} as const;

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'version',
  'prompt',
  'promptFile',
  'candidates',
  'concurrency',
  'agent',
  'agents',
  'agentTimeoutMs',
  'baseRef',
  'gates',
  'judge',
  'seed',
  'promote',
  'keep',
  'minScore',
]);

const PROMOTE_MODES: readonly PromoteMode[] = ['branch', 'patch', 'none'];
const KEEP_MODES: readonly KeepMode[] = ['all', 'winner', 'none'];

/** Overrides supplied on the command line. All optional; they win over the file. */
export interface ConfigOverrides {
  prompt?: string;
  promptFile?: string;
  candidates?: number;
  concurrency?: number;
  agents?: string[];
  agentTimeoutMs?: number;
  keep?: KeepMode;
  promoteMode?: PromoteMode;
  branchPrefix?: string;
  minScore?: number;
  baseRef?: string;
  /** Replaces every scored gate when non-empty. */
  gates?: string[];
  judge?: string;
  /** Appended to `seed.link` from the config file. */
  seedLink?: string[];
  /** Appended to `seed.copy` from the config file. */
  seedCopy?: string[];
}

/** Walk up from `startDir` to the repo root looking for a config file. */
export function findConfigFile(startDir: string, stopDir?: string): string | null {
  let dir = resolve(startDir);
  const stop = stopDir === undefined ? null : resolve(stopDir);

  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = join(dir, filename);
      if (existsSync(candidate)) return candidate;
    }
    if (stop !== null && dir === stop) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Parse a YAML or JSON config file into a raw config object. */
export function loadConfigFile(filePath: string): FlashoverConfig {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new FlashoverError(`Could not read config file ${filePath}: ${describeError(err)}`);
  }

  let parsed: unknown;
  try {
    // YAML is a superset of JSON, so one parser handles both extensions.
    parsed = parseYaml(text);
  } catch (err) {
    throw new FlashoverError(`Config file ${filePath} is not valid YAML/JSON: ${describeError(err)}`);
  }

  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FlashoverError(`Config file ${filePath} must contain a mapping at the top level.`);
  }

  const config = parsed as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      log.warn(`Ignoring unknown config key "${key}" in ${filePath}`);
    }
  }
  return config as FlashoverConfig;
}

/** Context the resolver needs but cannot infer from the config itself. */
export interface ResolveContext {
  /** Absolute git repository root. */
  repoRoot: string;
  /** Directory the config file was loaded from, used to resolve `promptFile`. */
  configDir: string;
}

/**
 * Merge file config with CLI overrides and produce a validated
 * {@link ResolvedConfig}.
 *
 * @throws {FlashoverError} when the resulting configuration cannot run.
 */
export function resolveConfig(raw: FlashoverConfig, overrides: ConfigOverrides, ctx: ResolveContext): ResolvedConfig {
  const version = raw.version ?? CONFIG_VERSION;
  if (version > CONFIG_VERSION) {
    throw new FlashoverError(
      `Config declares version ${version} but this flashover build understands up to ${CONFIG_VERSION}.`,
      'Upgrade flashover: npm install -g flashover@latest',
    );
  }

  const prompt = resolvePrompt(raw, overrides, ctx);
  const roster = resolveRoster(raw, overrides);
  const rosterTotal = roster.reduce((total, entry) => total + entry.count, 0);

  // `candidates` acts as a target total. An explicit multi-agent roster already
  // encodes its own counts, so only a single-agent roster gets scaled up.
  const requestedCandidates = overrides.candidates ?? raw.candidates;
  const candidates = resolveCandidateCount(roster, rosterTotal, requestedCandidates);

  const concurrency = requirePositiveInt(
    overrides.concurrency ?? raw.concurrency ?? candidates,
    'concurrency',
  );

  const agentTimeoutMs = requirePositiveInt(
    overrides.agentTimeoutMs ?? raw.agentTimeoutMs ?? DEFAULTS.agentTimeoutMs,
    'agentTimeoutMs',
  );

  const setupGates = (raw.gates?.setup ?? []).map((gate, index) =>
    normalizeGate(gate, index, { kind: 'setup' }),
  );

  const scoredGates =
    overrides.gates !== undefined && overrides.gates.length > 0
      ? overrides.gates.map((spec, index) => parseInlineGate(spec, index))
      : (raw.gates?.scored ?? []).map((gate, index) => normalizeGate(gate, index, { kind: 'scored' }));

  assertUniqueNames([...setupGates, ...scoredGates]);

  const judge = resolveJudge(raw, overrides);

  if (scoredGates.length === 0 && judge === null) {
    throw new FlashoverError(
      'No scored gates and no judge configured, so candidates cannot be ranked.',
      'Add gates.scored to your config, pass --gate "name:command", or configure a judge. Run `flashover init` to generate a starter config.',
    );
  }

  const totalWeight =
    scoredGates.reduce((total, gate) => total + gate.weight, 0) + (judge?.weight ?? 0);
  if (totalWeight <= 0) {
    throw new FlashoverError(
      'Total scored weight is zero, so every candidate would score 0.',
      'Give at least one scored gate or the judge a weight greater than 0.',
    );
  }

  const promoteMode = validateEnum(
    overrides.promoteMode ?? raw.promote?.mode ?? DEFAULTS.promoteMode,
    PROMOTE_MODES,
    'promote.mode',
  );
  const keep = validateEnum(overrides.keep ?? raw.keep ?? DEFAULTS.keep, KEEP_MODES, 'keep');

  const minScore = overrides.minScore ?? raw.minScore ?? DEFAULTS.minScore;
  if (typeof minScore !== 'number' || Number.isNaN(minScore) || minScore < 0 || minScore > 100) {
    throw new FlashoverError(`minScore must be a number between 0 and 100, got ${String(minScore)}.`);
  }

  const branchPrefix = overrides.branchPrefix ?? raw.promote?.branchPrefix ?? DEFAULTS.branchPrefix;
  if (typeof branchPrefix !== 'string') {
    throw new FlashoverError('promote.branchPrefix must be a string.');
  }

  return {
    version,
    prompt,
    roster,
    candidates,
    concurrency: Math.min(concurrency, candidates),
    agentTimeoutMs,
    setupGates,
    scoredGates,
    judge,
    seed: resolveSeed(raw, overrides),
    promote: { mode: promoteMode, branchPrefix },
    keep,
    repoRoot: ctx.repoRoot,
    workDir: join(ctx.repoRoot, '.flashover'),
    baseRef: overrides.baseRef ?? raw.baseRef ?? DEFAULTS.baseRef,
    minScore,
  };
}

function resolvePrompt(raw: FlashoverConfig, overrides: ConfigOverrides, ctx: ResolveContext): string {
  const cliPrompt = overrides.prompt?.trim();
  const hasCliPrompt = cliPrompt !== undefined && cliPrompt !== '';

  // Two explicit, conflicting instructions. Silently discarding one of them would
  // send the agents after the wrong task, which is expensive to discover.
  if (hasCliPrompt && overrides.promptFile !== undefined) {
    throw new FlashoverError(
      'Both a task argument and --prompt-file were provided.',
      'Pass the task inline or via --prompt-file, not both.',
    );
  }

  const promptFile = overrides.promptFile ?? raw.promptFile;
  const inlinePrompt = raw.prompt;

  // An inline prompt from the CLI is the most specific signal available.
  if (hasCliPrompt) return cliPrompt;

  if (promptFile !== undefined) {
    const resolved = isAbsolute(promptFile) ? promptFile : join(ctx.configDir, promptFile);
    if (!existsSync(resolved)) {
      throw new FlashoverError(`Prompt file not found: ${resolved}`);
    }
    const text = readFileSync(resolved, 'utf8').trim();
    if (text === '') throw new FlashoverError(`Prompt file ${resolved} is empty.`);
    return text;
  }

  if (inlinePrompt !== undefined && inlinePrompt.trim() !== '') {
    return inlinePrompt.trim();
  }

  throw new FlashoverError(
    'No task prompt provided.',
    'Pass a prompt as the first argument: flashover run "fix the flaky auth test". Or set `prompt` / `promptFile` in your config.',
  );
}

function resolveRoster(raw: FlashoverConfig, overrides: ConfigOverrides): RosterEntry[] {
  // Precedence: --agent flags, then `agents`, then `agent`, then a helpful error.
  if (overrides.agents !== undefined && overrides.agents.length > 0) {
    return mergeRoster(overrides.agents.map((spec) => resolveAgent(parseInlineAgent(spec))));
  }
  if (raw.agents !== undefined && raw.agents.length > 0) {
    return mergeRoster(raw.agents.map((entry) => resolveAgent(entry)));
  }
  if (raw.agent !== undefined) {
    return mergeRoster([resolveAgent(raw.agent)]);
  }
  throw new FlashoverError(
    'No agent configured.',
    'Pass --agent claude (repeatable), or set `agent:` in flashover.yaml. Run `flashover doctor` to see which agent CLIs are installed.',
  );
}

/**
 * Accept `claude`, `claude:2`, or `claude=2` on the command line.
 * The numeric suffix is the copy count.
 */
function parseInlineAgent(spec: string): { preset: string; count?: number } {
  const match = /^([^:=]+)(?:[:=](\d+))?$/.exec(spec.trim());
  if (match === null || match[1] === undefined) {
    throw new FlashoverError(`Could not parse --agent value "${spec}".`, 'Expected forms: claude, claude:3');
  }
  const preset = match[1];
  const countText = match[2];
  return countText === undefined ? { preset } : { preset, count: Number.parseInt(countText, 10) };
}

/**
 * Accept `name:command` or bare `command` for `--gate`.
 * A `!` prefix marks the gate as required, and `*N` suffix sets the weight.
 * Examples: `--gate "test:npm test"`, `--gate "!build:npm run build"`,
 * `--gate "lint:npm run lint*2"`.
 */
function parseInlineGate(spec: string, index: number): GateDefinition {
  let text = spec.trim();
  if (text === '') throw new FlashoverError('Empty --gate value.');

  let required = false;
  if (text.startsWith('!')) {
    required = true;
    text = text.slice(1);
  }

  // Annotated: DEFAULTS is `as const`, so inference would pin this to the
  // literal type 1 and reject the parsed weight below.
  let weight: number = DEFAULTS.gateWeight;
  const weightMatch = /\*(\d+(?:\.\d+)?)$/.exec(text);
  if (weightMatch !== null && weightMatch[1] !== undefined) {
    weight = Number.parseFloat(weightMatch[1]);
    text = text.slice(0, weightMatch.index);
  }

  // Split on the first colon only, so commands may contain colons.
  const separator = text.indexOf(':');
  const hasName = separator > 0;
  const name = hasName ? text.slice(0, separator).trim() : `gate${index + 1}`;
  const run = (hasName ? text.slice(separator + 1) : text).trim();

  if (run === '') {
    throw new FlashoverError(`--gate "${spec}" has no command.`, 'Expected form: --gate "test:npm test"');
  }

  return { name, run, weight, required, timeoutMs: DEFAULTS.gateTimeoutMs };
}

function normalizeGate(input: GateConfigInput, index: number, opts: { kind: 'setup' | 'scored' }): GateDefinition {
  if (typeof input !== 'object' || input === null) {
    throw new FlashoverError(`gates.${opts.kind}[${index}] must be a mapping with a "run" field.`);
  }
  const run = input.run;
  if (typeof run !== 'string' || run.trim() === '') {
    throw new FlashoverError(`gates.${opts.kind}[${index}] is missing a non-empty "run" command.`);
  }

  const name = input.name ?? `${opts.kind}${index + 1}`;
  // Setup gates are pass/fail preconditions; weighting them would be meaningless.
  const weight = opts.kind === 'setup' ? 0 : input.weight ?? DEFAULTS.gateWeight;
  if (typeof weight !== 'number' || Number.isNaN(weight) || weight < 0) {
    throw new FlashoverError(`Gate "${name}" has invalid weight ${String(input.weight)}.`, 'weight must be a number >= 0.');
  }

  // A failed setup step means the candidate cannot be evaluated at all, so setup
  // gates are always required regardless of what the user wrote.
  const required = opts.kind === 'setup' ? true : input.required ?? false;
  const timeoutMs = requirePositiveInt(input.timeoutMs ?? DEFAULTS.gateTimeoutMs, `gate "${name}" timeoutMs`);

  const gate: GateDefinition = { name, run: run.trim(), weight, required, timeoutMs };
  if (input.cwd !== undefined) {
    if (isAbsolute(input.cwd)) {
      throw new FlashoverError(`Gate "${name}" cwd must be relative to the candidate worktree, got "${input.cwd}".`);
    }
    gate.cwd = input.cwd;
  }
  if (input.env !== undefined) gate.env = { ...input.env };
  return gate;
}

/**
 * Normalize seed paths, rejecting anything that could escape the worktree.
 *
 * CLI values are additive rather than overriding, because seeding is cumulative
 * by nature: a repo-level config listing `node_modules` plus an ad-hoc
 * `--seed-link .venv` should produce both.
 */
function resolveSeed(raw: FlashoverConfig, overrides: ConfigOverrides): { copy: string[]; link: string[] } {
  const validate = (paths: readonly string[], field: string): string[] => {
    const normalized: string[] = [];
    for (const entry of paths) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new FlashoverError(`${field} contains an empty path.`);
      }
      const clean = entry.trim().replace(/^\.\//, '').replace(/\/+$/, '');
      if (isAbsolute(clean) || clean.split('/').includes('..')) {
        throw new FlashoverError(
          `${field} entry "${entry}" must be a relative path inside the repository.`,
          'Seed paths are resolved against the repository root.',
        );
      }
      if (!normalized.includes(clean)) normalized.push(clean);
    }
    return normalized;
  };

  const link = validate([...(raw.seed?.link ?? []), ...(overrides.seedLink ?? [])], 'seed.link');
  const copy = validate([...(raw.seed?.copy ?? []), ...(overrides.seedCopy ?? [])], 'seed.copy');

  const conflict = link.find((path) => copy.includes(path));
  if (conflict !== undefined) {
    throw new FlashoverError(`"${conflict}" appears in both seed.link and seed.copy.`, 'Pick one strategy per path.');
  }

  return { copy, link };
}

function resolveJudge(raw: FlashoverConfig, overrides: ConfigOverrides): JudgeDefinition | null {
  const run = overrides.judge ?? raw.judge?.run;
  if (run === undefined || run.trim() === '') return null;

  const weight = raw.judge?.weight ?? DEFAULTS.judgeWeight;
  if (typeof weight !== 'number' || Number.isNaN(weight) || weight < 0) {
    throw new FlashoverError(`judge.weight must be a number >= 0, got ${String(raw.judge?.weight)}.`);
  }

  const judge: JudgeDefinition = {
    run: run.trim(),
    weight,
    timeoutMs: requirePositiveInt(raw.judge?.timeoutMs ?? DEFAULTS.judgeTimeoutMs, 'judge.timeoutMs'),
  };
  if (raw.judge?.env !== undefined) judge.env = { ...raw.judge.env };
  return judge;
}

/**
 * Scale a single-agent roster to the requested candidate count. Multi-agent
 * rosters keep their explicit counts, because silently rebalancing them would
 * contradict what the user wrote.
 */
function resolveCandidateCount(roster: RosterEntry[], rosterTotal: number, requested: number | undefined): number {
  if (requested === undefined) {
    return rosterTotal > 1 ? rosterTotal : DEFAULTS.candidates;
  }

  const count = requirePositiveInt(requested, 'candidates');
  if (roster.length === 1 && rosterTotal <= 1) {
    const only = roster[0];
    if (only !== undefined) only.count = count;
    return count;
  }
  if (count !== rosterTotal) {
    log.warn(
      `candidates=${count} conflicts with the roster total of ${rosterTotal}; using the roster counts. ` +
        'Set counts per agent instead, e.g. --agent claude:2 --agent codex:1',
    );
  }
  return rosterTotal;
}

/** Collapse duplicate agent entries so `--agent claude --agent claude` means two copies. */
function mergeRoster(entries: Array<{ agent: RosterEntry['agent']; count: number }>): RosterEntry[] {
  const merged: RosterEntry[] = [];
  for (const entry of entries) {
    const existing = merged.find(
      (candidate) =>
        candidate.agent.name === entry.agent.name &&
        candidate.agent.command === entry.agent.command &&
        candidate.agent.args.join('\u0000') === entry.agent.args.join('\u0000'),
    );
    if (existing === undefined) {
      merged.push({ agent: entry.agent, count: entry.count });
    } else {
      existing.count += entry.count;
    }
  }
  return merged;
}

function assertUniqueNames(gates: readonly GateDefinition[]): void {
  const seen = new Set<string>();
  for (const gate of gates) {
    if (seen.has(gate.name)) {
      throw new FlashoverError(`Duplicate gate name "${gate.name}".`, 'Gate names must be unique so reports stay unambiguous.');
    }
    seen.add(gate.name);
  }
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new FlashoverError(`${field} must be a positive number, got ${String(value)}.`);
  }
  return Math.floor(value);
}

function validateEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new FlashoverError(`${field} must be one of: ${allowed.join(', ')}. Got ${String(value)}.`);
  }
  return value as T;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

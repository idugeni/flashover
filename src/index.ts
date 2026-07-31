/**
 * Programmatic API.
 *
 * The CLI is a thin wrapper over these exports, so anything flashover can do from
 * a terminal can also be driven from code, for example from a custom CI step or
 * a bot that opens a pull request per winning candidate.
 *
 * ```ts
 * import { findRepoRoot, resolveConfig, runTournament, makeRunId } from 'flashover';
 *
 * const repoRoot = await findRepoRoot(process.cwd());
 * const config = resolveConfig(
 *   { agents: [{ preset: 'claude', count: 3 }], gates: { scored: [{ name: 'test', run: 'npm test', required: true, weight: 5 }] } },
 *   { prompt: 'fix the flaky auth test' },
 *   { repoRoot, configDir: repoRoot },
 * );
 * const report = await runTournament({ config, runId: makeRunId() });
 * console.log(report.winnerId);
 * ```
 */

export type {
  AgentConfigInput,
  AgentDefinition,
  CandidateResult,
  CandidateStatus,
  DiffStat,
  FlashoverConfig,
  GateConfigInput,
  GateDefinition,
  GateResult,
  JudgeConfigInput,
  JudgeDefinition,
  KeepMode,
  PromoteMode,
  PromptMode,
  ResolvedConfig,
  RosterEntry,
  RunReport,
  SeedConfigInput,
} from './types.js';
export { CONFIG_VERSION, REPORT_VERSION, FlashoverError } from './types.js';

export type { ConfigOverrides, ResolveContext } from './config.js';
export { CONFIG_FILENAMES, DEFAULTS, findConfigFile, loadConfigFile, resolveConfig } from './config.js';

export { PRESETS, presetNames, resolveAgent, substitutePlaceholders } from './presets.js';

export type { TournamentEvent, TournamentOptions } from './tournament.js';
export { runTournament } from './tournament.js';

export type { ScoreInput } from './score.js';
export { compareCandidates, computeScore, isRankable, pickWinner, rankCandidates, totalConfiguredWeight } from './score.js';

export {
  REPORT_FILENAME,
  findLatestRunDir,
  readReport,
  renderFailureDetails,
  renderLeaderboard,
  renderMarkdownReport,
  writeReport,
} from './report.js';

export { findRepoRoot, parseNumstat, revParse } from './git.js';

export type { LogLevel } from './log.js';
export { setLogLevel } from './log.js';

export { makeRunId } from './util.js';

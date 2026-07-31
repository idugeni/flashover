#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * Exit codes are part of the contract, because flashover is meant to be usable
 * as a CI step:
 *
 *   0  a winner was promoted
 *   1  the run completed but produced no acceptable winner
 *   2  usage, configuration, or environment error
 * 130  interrupted (SIGINT)
 */

import { existsSync, realpathSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { ConfigOverrides } from './config.js';
import { CONFIG_FILENAMES, findConfigFile, loadConfigFile, resolveConfig } from './config.js';
import { commandExists, posixShellAvailable } from './exec.js';
import * as git from './git.js';
import { log, setLogLevel, style } from './log.js';
import { PRESETS, presetNames } from './presets.js';
import {
  REPORT_FILENAME,
  findLatestRunDir,
  readReport,
  renderFailureDetails,
  renderLeaderboard,
  renderMarkdownReport,
} from './report.js';
import { runTournament } from './tournament.js';
import { rescoreRun } from './rescore.js';
import { reportPresetVerification, verifyPresets } from './verify.js';
import type { KeepMode, PromoteMode, RunReport } from './types.js';
import { FlashoverError } from './types.js';
import { createLiveView } from './ui.js';
import { formatDuration, makeRunId } from './util.js';

const EXIT_OK = 0;
const EXIT_NO_WINNER = 1;
const EXIT_USAGE = 2;
const EXIT_INTERRUPTED = 130;

const HELP = `${style.bold('flashover')} — ignite N coding agents at once, ship the one that survives.

${style.bold('USAGE')}
  flashover [run] <task>              run a tournament for a task
  flashover init                      write a starter flashover.yaml
  flashover doctor                    check git, config, and installed agents
  flashover doctor --verify-presets   run each installed agent for real, costs tokens
  flashover report [path]             re-print the leaderboard for a run
  flashover rescore [path]            re-score a run's stored patches, no agents
  flashover clean                     remove worktrees and run artifacts

${style.bold('EXAMPLES')}
  ${style.gray('# three Claude candidates, ranked by your test suite')}
  flashover "fix the flaky auth test" -a claude -n 3 -g "!test:npm test"

  ${style.gray('# pit different agents against each other')}
  flashover "add retry with backoff to the http client" -a claude -a codex -a cursor-agent

  ${style.gray('# weighted gates: tests matter 5x more than lint')}
  flashover "refactor the parser" -g "!test:npm test*5" -g "lint:npm run lint"

  ${style.gray('# retune gates against the last run, without paying for agents again')}
  flashover rescore -g "!test:npm test*5" -g "lint:npm run lint*2"

${style.bold('RUN OPTIONS')}
  -a, --agent <name[:count]>   agent preset, repeatable (e.g. claude, codex:2)
  -n, --candidates <n>         number of candidates for a single-agent roster
  -j, --concurrency <n>        max agents running at once (default: all)
  -g, --gate <spec>            scored gate, repeatable. Form: "[!]name:command[*weight]"
                               "!" marks it required, "*N" sets its weight
      --judge <command>        command scoring a diff on stdin, prints 0-100
  -f, --prompt-file <path>     read the task from a file instead of the argument
      --base <ref>             revision candidates branch from (default: HEAD)
      --timeout <seconds>      per-agent time limit (default: 1200)
      --min-score <0-100>      refuse to promote below this score (default: 0)
      --promote <mode>         branch | patch | none (default: branch)
      --branch-prefix <text>   prefix for the promoted branch (default: flashover/)
      --keep <mode>            all | winner | none — which worktrees survive
      --seed-link <path>       symlink a gitignored path into each worktree, repeatable
      --seed-copy <path>       copy a gitignored path into each worktree, repeatable
      --dry-run                print the resolved plan and exit

${style.bold('OUTPUT OPTIONS')}
  -c, --config <path>          config file to use (default: nearest flashover.yaml)
      --json                   print the run report as JSON on stdout
      --markdown               print a markdown summary on stdout
      --no-live                disable the in-place live view
      --force                  overwrite an existing config (init only)
  -q, --quiet                  errors only
  -v, --verbose                include debug output
  -h, --help                   show this help
      --version                show the version

${style.bold('EXIT CODES')}
  0 winner promoted   1 no acceptable winner   2 usage error   130 interrupted

${style.bold('HOW IT WORKS')}
  Each candidate runs in its own detached git worktree, so agents never see or
  clobber each other. The diff is captured before any gate runs, then gates score
  it. The winner becomes a branch; your working tree is never touched.

  Agents are the only step that costs money, so their diffs are kept. ${style.bold('rescore')}
  replays them against changed gates or a changed judge, free of charge.

Docs: https://github.com/idugeni/flashover
`;

interface ParsedCli {
  command: string;
  positionals: string[];
  values: Record<string, unknown>;
}

/** Option table shared by every subcommand. */
const OPTION_SPEC = {
  agent: { type: 'string', multiple: true, short: 'a' },
  candidates: { type: 'string', short: 'n' },
  concurrency: { type: 'string', short: 'j' },
  gate: { type: 'string', multiple: true, short: 'g' },
  judge: { type: 'string' },
  'prompt-file': { type: 'string', short: 'f' },
  config: { type: 'string', short: 'c' },
  base: { type: 'string' },
  timeout: { type: 'string' },
  'min-score': { type: 'string' },
  promote: { type: 'string' },
  'branch-prefix': { type: 'string' },
  keep: { type: 'string' },
  'seed-link': { type: 'string', multiple: true },
  'seed-copy': { type: 'string', multiple: true },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  markdown: { type: 'boolean' },
  'no-live': { type: 'boolean' },
  force: { type: 'boolean' },
  'verify-presets': { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const;

const KNOWN_COMMANDS = new Set(['run', 'init', 'doctor', 'report', 'rescore', 'clean', 'help', 'version']);

async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedCli;
  try {
    const result = parseArgs({
      args: [...argv],
      options: OPTION_SPEC,
      allowPositionals: true,
      strict: true,
    });
    const first = result.positionals[0];
    const isCommand = first !== undefined && KNOWN_COMMANDS.has(first);
    parsed = {
      command: isCommand ? first : 'run',
      positionals: isCommand ? result.positionals.slice(1) : result.positionals,
      values: result.values as Record<string, unknown>,
    };
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    log.info(`Run ${style.bold('flashover --help')} for usage.`);
    return EXIT_USAGE;
  }

  if (parsed.values['quiet'] === true) setLogLevel('error');
  else if (parsed.values['verbose'] === true) setLogLevel('debug');

  if (parsed.values['help'] === true || parsed.command === 'help') {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  if (parsed.values['version'] === true || parsed.command === 'version') {
    process.stdout.write(`${await readVersion()}\n`);
    return EXIT_OK;
  }

  switch (parsed.command) {
    case 'init':
      return commandInit(parsed);
    case 'doctor':
      return commandDoctor(parsed);
    case 'report':
      return commandReport(parsed);
    case 'rescore':
      return commandRescore(parsed);
    case 'clean':
      return commandClean(parsed);
    case 'run':
      return commandRun(parsed);
    default:
      log.error(`Unknown command "${parsed.command}".`);
      return EXIT_USAGE;
  }
}

/* ------------------------------------------------------------------ run --- */

async function commandRun(cli: ParsedCli): Promise<number> {
  const cwd = currentDir();
  const repoRoot = await git.findRepoRoot(cwd);

  const configPath = resolveConfigPath(cli, cwd, repoRoot);
  const rawConfig = configPath === null ? {} : loadConfigFile(configPath);
  if (configPath !== null) log.debug(`Using config ${configPath}`);

  const overrides = buildOverrides(cli);
  const inlinePrompt = cli.positionals.join(' ').trim();
  if (inlinePrompt !== '') overrides.prompt = inlinePrompt;

  const config = resolveConfig(rawConfig, overrides, {
    repoRoot,
    configDir: configPath === null ? repoRoot : dirname(configPath),
  });

  await warnIfWorkingTreeDirty(repoRoot, config.baseRef);

  if (cli.values['dry-run'] === true) {
    printPlan(config);
    return EXIT_OK;
  }

  const controller = new AbortController();
  let interrupted = false;
  const onSigint = (): void => {
    if (interrupted) {
      // A second Ctrl-C means the user is done waiting for a graceful stop.
      process.exit(EXIT_INTERRUPTED);
    }
    interrupted = true;
    log.blank();
    log.warn('Interrupted. Stopping agents and writing a partial report (Ctrl-C again to force quit)...');
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  const view = createLiveView(cli.values['no-live'] === true);

  let report: RunReport;
  try {
    report = await runTournament({
      config,
      runId: makeRunId(),
      onEvent: (event) => view.handle(event),
      signal: controller.signal,
    });
  } finally {
    view.stop();
    process.off('SIGINT', onSigint);
  }

  if (cli.values['json'] === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (cli.values['markdown'] === true) {
    process.stdout.write(`${renderMarkdownReport(report)}\n`);
  } else {
    printRunSummary(report, config.minScore);
  }

  if (interrupted) return EXIT_INTERRUPTED;
  return report.winnerId === null ? EXIT_NO_WINNER : EXIT_OK;
}

function printRunSummary(report: RunReport, minScore: number): void {
  log.blank();
  log.raw(renderLeaderboard(report));
  log.blank();

  const failures = renderFailureDetails(report);
  if (failures !== '') {
    log.raw(failures);
    log.blank();
  }

  log.info(style.gray(`run ${report.runId} · ${formatDuration(report.durationMs)} · report: ${join(reportDir(report), REPORT_FILENAME)}`));

  if (report.winnerId === null) {
    log.error('No winner promoted.');
    const reason =
      minScore > 0
        ? `No candidate passed the required gates with a score of at least ${minScore}.`
        : 'No candidate passed the required gates.';
    log.info(`  ${reason}`);
    log.info(`  Inspect the transcripts listed above, then adjust your gates or prompt.`);
    return;
  }

  const winner = report.candidates.find((candidate) => candidate.id === report.winnerId);
  log.success(
    `${style.bold(report.winnerId)} won with ${style.bold(winner?.score.toFixed(1) ?? '?')}/100` +
      (winner === undefined ? '' : ` (${winner.agentName})`),
  );

  if (report.promotedBranch !== null) {
    log.blank();
    log.info(`  ${style.bold('git diff')} ${report.promotedBranch}`);
    log.info(`  ${style.bold('git switch')} ${report.promotedBranch}`);
  } else if (report.promotedPatch !== null) {
    log.blank();
    log.info(`  ${style.bold('git apply')} ${report.promotedPatch}`);
  }
}

/** Directory holding a report, derived from the report's own fields. */
function reportDir(report: RunReport): string {
  return join(report.repoRoot, '.flashover', `run-${report.runId}`);
}

function printPlan(config: ReturnType<typeof resolveConfig>): void {
  log.info(style.bold('Resolved plan'));
  log.info(`  task         ${config.prompt.split('\n')[0] ?? ''}`);
  log.info(`  base         ${config.baseRef}`);
  log.info(`  candidates   ${config.candidates} (concurrency ${config.concurrency})`);
  for (const entry of config.roster) {
    const timeout =
      entry.agent.timeoutMs === undefined ? '' : ` ${style.gray(`[timeout ${Math.round(entry.agent.timeoutMs / 1000)}s]`)}`;
    log.info(
      `  agent        ${entry.agent.name} ×${entry.count} — ${[entry.agent.command, ...entry.agent.args].join(' ')}${timeout}`,
    );
  }
  for (const gate of config.setupGates) {
    log.info(`  setup        ${gate.name}: ${gate.run}`);
  }
  for (const gate of config.scoredGates) {
    const flags = [`weight ${gate.weight}`, gate.required ? 'required' : 'optional'].join(', ');
    log.info(`  gate         ${gate.name}: ${gate.run} (${flags})`);
  }
  if (config.judge !== null) {
    log.info(`  judge        ${config.judge.run} (weight ${config.judge.weight})`);
  }
  if (config.seed.link.length > 0) log.info(`  seed link    ${config.seed.link.join(', ')}`);
  if (config.seed.copy.length > 0) log.info(`  seed copy    ${config.seed.copy.join(', ')}`);
  log.info(`  promote      ${config.promote.mode} (prefix ${config.promote.branchPrefix})`);
  log.info(`  keep         ${config.keep}`);
  log.info(`  min score    ${config.minScore}`);
}

/**
 * Warn when uncommitted work exists.
 *
 * Candidates branch from a committed revision, so anything uncommitted is
 * invisible to every agent. Silently excluding a user's work in progress would
 * be the most confusing possible behaviour.
 */
async function warnIfWorkingTreeDirty(repoRoot: string, baseRef: string): Promise<void> {
  const lines = await git.statusLines(repoRoot);
  if (lines.length === 0) return;
  log.warn(
    `Working tree has ${lines.length} uncommitted change${lines.length === 1 ? '' : 's'}. ` +
      `Candidates start from ${baseRef} (committed state), so those changes will not be visible to the agents.`,
  );
  log.info(style.gray('  Commit or stash first if the agents need them.'));
}

/* ----------------------------------------------------------------- init --- */

async function commandInit(cli: ParsedCli): Promise<number> {
  const cwd = currentDir();
  const repoRoot = await git.findRepoRoot(cwd);
  const target = join(repoRoot, 'flashover.yaml');

  if (existsSync(target) && cli.values['force'] !== true) {
    log.error(`${target} already exists.`);
    log.info(`  Pass ${style.bold('--force')} to overwrite it, or edit it directly.`);
    return EXIT_USAGE;
  }

  const detected = await detectProjectGates(repoRoot);
  await writeFile(target, renderStarterConfig(detected), 'utf8');

  log.success(`Wrote ${target}`);
  if (detected.gates.length > 0) {
    log.info(`  Detected gates: ${detected.gates.map((gate) => gate.name).join(', ')}`);
  } else {
    log.warn('  No build tooling detected. Edit gates.scored before your first run.');
  }
  log.info(`  Then run: ${style.bold('flashover "your task here"')}`);
  return EXIT_OK;
}

interface DetectedGate {
  name: string;
  run: string;
  weight: number;
  required: boolean;
}

interface DetectedProject {
  setup: DetectedGate[];
  gates: DetectedGate[];
  seedLink: string[];
}

/**
 * Guess sensible gates from the files present in the repository.
 *
 * A wrong guess is cheap: the config is written for the user to edit, and
 * `flashover --dry-run` shows exactly what would execute.
 */
async function detectProjectGates(repoRoot: string): Promise<DetectedProject> {
  const setup: DetectedGate[] = [];
  const gates: DetectedGate[] = [];
  const seedLink: string[] = [];

  const packageJsonPath = join(repoRoot, 'package.json');
  if (existsSync(packageJsonPath)) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { scripts?: Record<string, unknown> };
      scripts = parsed.scripts ?? {};
    } catch {
      log.debug('package.json could not be parsed; skipping script detection.');
    }

    setup.push({ name: 'install', run: 'npm ci --no-audit --no-fund', weight: 0, required: true });
    seedLink.push('node_modules');

    if ('typecheck' in scripts) gates.push({ name: 'typecheck', run: 'npm run typecheck', weight: 2, required: false });
    if ('lint' in scripts) gates.push({ name: 'lint', run: 'npm run lint', weight: 1, required: false });
    if ('build' in scripts) gates.push({ name: 'build', run: 'npm run build', weight: 3, required: false });
    if ('test' in scripts) gates.push({ name: 'test', run: 'npm test', weight: 5, required: true });
  } else if (existsSync(join(repoRoot, 'Cargo.toml'))) {
    gates.push({ name: 'check', run: 'cargo check', weight: 2, required: false });
    gates.push({ name: 'clippy', run: 'cargo clippy -- -D warnings', weight: 1, required: false });
    gates.push({ name: 'test', run: 'cargo test', weight: 5, required: true });
    seedLink.push('target');
  } else if (existsSync(join(repoRoot, 'go.mod'))) {
    gates.push({ name: 'vet', run: 'go vet ./...', weight: 2, required: false });
    gates.push({ name: 'build', run: 'go build ./...', weight: 2, required: false });
    gates.push({ name: 'test', run: 'go test ./...', weight: 5, required: true });
  } else if (existsSync(join(repoRoot, 'pyproject.toml')) || existsSync(join(repoRoot, 'requirements.txt'))) {
    gates.push({ name: 'lint', run: 'ruff check .', weight: 1, required: false });
    gates.push({ name: 'typecheck', run: 'mypy .', weight: 2, required: false });
    gates.push({ name: 'test', run: 'pytest -q', weight: 5, required: true });
  }

  return { setup, gates, seedLink };
}

function renderStarterConfig(detected: DetectedProject): string {
  const lines: string[] = [
    '# flashover configuration',
    '# Docs: https://github.com/idugeni/flashover',
    'version: 1',
    '',
    '# Which agent runs, and how many copies. Repeat entries to mix agents.',
    'agents:',
    '  - preset: claude',
    `    count: 3`,
    '',
    '# Uncomment to pit different agents against each other instead:',
    '# agents:',
    '#   - preset: claude',
    '#     count: 2',
    '#   - preset: codex',
    '#   - preset: cursor-agent',
    '',
    '# Run agents in parallel, but cap it if your machine or rate limits complain.',
    '# concurrency: 3',
    '',
  ];

  if (detected.seedLink.length > 0) {
    lines.push(
      '# Speed optimization, opt-in on purpose.',
      '#',
      '# Fresh worktrees contain only tracked files, so gitignored build inputs are',
      '# absent and the setup gate below has to install them once per candidate.',
      '# Symlinking is far faster, but the directory is then SHARED by every',
      '# candidate: an install command would write through the link into your own',
      '# working copy, from several candidates at once.',
      '#',
      '# If you enable this, delete the "install" setup gate below.',
      '# seed:',
      '#   link:',
      ...detected.seedLink.map((path) => `#     - ${path}`),
      '',
    );
  }

  lines.push('gates:');

  if (detected.setup.length > 0) {
    lines.push('  # Preconditions. A failure here means the candidate cannot be evaluated.', '  setup:');
    for (const gate of detected.setup) {
      lines.push(`    - name: ${gate.name}`, `      run: ${gate.run}`);
    }
    lines.push('');
  }

  lines.push(
    '  # Scored gates. "required: true" eliminates a candidate outright.',
    '  # "weight" sets how much a gate contributes to the 0-100 score.',
    '  scored:',
  );

  if (detected.gates.length === 0) {
    lines.push(
      '    - name: test',
      '      run: echo "replace me with your test command" && false',
      '      weight: 5',
      '      required: true',
    );
  } else {
    for (const gate of detected.gates) {
      lines.push(
        `    - name: ${gate.name}`,
        `      run: ${gate.run}`,
        `      weight: ${gate.weight}`,
        `      required: ${gate.required}`,
      );
    }
  }

  lines.push(
    '',
    '# Optional subjective scorer. Receives the unified diff on stdin and must',
    '# print a score from 0-100. Any command works: an LLM call, a script, a linter.',
    '# judge:',
    '#   run: my-review-script',
    '#   weight: 3',
    '',
    '# What happens to the winning diff: branch | patch | none',
    'promote:',
    '  mode: branch',
    '  branchPrefix: flashover/',
    '',
    '# Which candidate worktrees survive the run: all | winner | none',
    'keep: winner',
    '',
    '# Refuse to promote anything scoring below this.',
    '# minScore: 60',
    '',
  );

  return lines.join('\n');
}

/* --------------------------------------------------------------- doctor --- */

async function commandDoctor(cli: ParsedCli): Promise<number> {
  let problems = 0;
  const cwd = currentDir();

  // Opt-in because it invokes real agents and spends real money. Runs first so a
  // long verification is not preceded by output the user has to scroll past.
  if (cli.values['verify-presets'] === true) {
    const only = cli.positionals.length > 0 ? cli.positionals : undefined;
    const results = await verifyPresets(only === undefined ? {} : { only });
    const failures = reportPresetVerification(results);
    log.blank();
    return failures === 0 ? EXIT_OK : EXIT_USAGE;
  }

  log.info(style.bold('environment'));
  log.info(`  flashover    ${await readVersion()}`);
  log.info(`  node         ${process.version}`);

  const hasGit = await commandExists('git');
  log.info(`  git          ${hasGit ? style.green('found') : style.red('missing')}`);
  if (!hasGit) problems += 1;

  // Gates and judges are shell command lines run through `sh -c`, so without a
  // POSIX shell nothing can be scored and every run ends with no winner. Worth
  // its own line rather than surfacing later as a pile of failed gates.
  const hasShell = await posixShellAvailable();
  log.info(`  sh           ${hasShell ? style.green('found') : style.red('missing')}`);
  if (!hasShell) {
    problems += 1;
    log.info(
      `               ${style.gray('gates and judges run via `sh -c`; without it no candidate can be scored')}`,
    );
    log.info(`               ${style.gray('flashover targets Linux and macOS; Windows is not supported')}`);
  }

  let repoRoot: string | null = null;
  try {
    repoRoot = await git.findRepoRoot(cwd);
    const branch = await git.currentBranch(repoRoot);
    const dirty = (await git.statusLines(repoRoot)).length;
    log.info(`  repository   ${repoRoot}`);
    log.info(`  branch       ${branch ?? '(detached)'}${dirty > 0 ? style.yellow(` · ${dirty} uncommitted`) : ''}`);
  } catch (err) {
    log.info(`  repository   ${style.red(err instanceof FlashoverError ? err.message : String(err))}`);
    problems += 1;
  }

  log.blank();
  log.info(style.bold('agent presets on PATH'));
  const installedPresets: string[] = [];
  for (const name of presetNames()) {
    const preset = PRESETS[name];
    if (preset === undefined) continue;
    const found = await commandExists(preset.command);
    if (found) installedPresets.push(name);
    log.info(`  ${name.padEnd(14)} ${found ? style.green('found') : style.gray('not found')}`);
  }

  log.blank();
  log.info(style.bold('configuration'));
  const configPath = resolveConfigPath(cli, cwd, repoRoot ?? cwd);

  if (configPath === null) {
    log.info(`  ${style.yellow('none found')} — run ${style.bold('flashover init')} to create one`);
    log.info(`  ${style.gray(`looked for: ${CONFIG_FILENAMES.join(', ')}`)}`);
    // Without a config, the presets are the only agents available.
    if (installedPresets.length === 0) {
      log.blank();
      log.warn('No agent CLI found and no config to define one.');
      log.info(style.gray('  Install a supported agent, or define a custom command in flashover.yaml.'));
      problems += 1;
    }
  } else {
    log.info(`  file         ${configPath}`);
    try {
      const raw = loadConfigFile(configPath);
      // A placeholder prompt lets validation run without requiring a real task.
      const config = resolveConfig(raw, { prompt: 'doctor check' }, {
        repoRoot: repoRoot ?? cwd,
        configDir: dirname(configPath),
      });
      log.info(`  candidates   ${config.candidates}`);
      log.info(`  gates        ${config.scoredGates.map((gate) => gate.name).join(', ') || '(none)'}`);
      log.info(`  judge        ${config.judge === null ? '(none)' : config.judge.run}`);
      log.info(`  status       ${style.green('valid')}`);

      // What actually matters is whether the *configured* roster can run, which
      // may well be custom commands rather than any known preset.
      log.blank();
      log.info(style.bold('configured agents'));
      for (const entry of config.roster) {
        const found = await commandExists(entry.agent.command);
        log.info(
          `  ${entry.agent.name.padEnd(14)} ${found ? style.green('found') : style.red('missing')}` +
            ` ${style.gray(entry.agent.command)}`,
        );
        if (!found) problems += 1;
      }
    } catch (err) {
      log.info(`  status       ${style.red('invalid')}`);
      reportError(err);
      problems += 1;
    }
  }

  log.blank();
  if (problems === 0) {
    log.success('Ready to run.');
    return EXIT_OK;
  }
  log.error(`${problems} problem${problems === 1 ? '' : 's'} found.`);
  return EXIT_USAGE;
}

/* --------------------------------------------------------------- report --- */

/**
 * Resolve which report to read: an explicit path or directory, else the newest
 * run. Shared by `report` and `rescore`, which address runs the same way.
 */
async function resolveReportPath(cli: ParsedCli, cwd: string, repoRoot: string): Promise<string> {
  const explicit = cli.positionals[0];
  if (explicit !== undefined) {
    const candidate = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    return candidate.endsWith('.json') ? candidate : join(candidate, REPORT_FILENAME);
  }

  const latest = await findLatestRunDir(join(repoRoot, '.flashover'));
  if (latest === null) {
    throw new FlashoverError('No previous runs found.', 'Run flashover first.');
  }
  return join(latest, REPORT_FILENAME);
}

async function commandReport(cli: ParsedCli): Promise<number> {
  const cwd = currentDir();
  const repoRoot = await git.findRepoRoot(cwd);
  const reportPath = await resolveReportPath(cli, cwd, repoRoot);

  const report = await readReport(reportPath);

  if (cli.values['json'] === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (cli.values['markdown'] === true) {
    process.stdout.write(`${renderMarkdownReport(report)}\n`);
  } else {
    log.info(`${style.bold('run')} ${report.runId} · ${report.prompt.split('\n')[0] ?? ''}`);
    log.blank();
    log.raw(renderLeaderboard(report));
    log.blank();
    const failures = renderFailureDetails(report);
    if (failures !== '') {
      log.raw(failures);
      log.blank();
    }
    if (report.promotedBranch !== null) log.info(`branch: ${report.promotedBranch}`);
    if (report.promotedPatch !== null) log.info(`patch:  ${report.promotedPatch}`);
  }

  return report.winnerId === null ? EXIT_NO_WINNER : EXIT_OK;
}

/* -------------------------------------------------------------- rescore --- */

/**
 * Re-verify a previous run's stored patches against the current gates.
 *
 * The task comes from the source report rather than the command line: no agent
 * runs, so asking the user to restate the task would invite a mismatch between
 * the prompt in the report and the diffs it describes.
 */
async function commandRescore(cli: ParsedCli): Promise<number> {
  const cwd = currentDir();
  const repoRoot = await git.findRepoRoot(cwd);

  const source = await readReport(await resolveReportPath(cli, cwd, repoRoot));

  const configPath = resolveConfigPath(cli, cwd, repoRoot);
  const rawConfig = configPath === null ? {} : loadConfigFile(configPath);
  if (configPath !== null) log.debug(`Using config ${configPath}`);

  const overrides = buildOverrides(cli);
  // Inherited, never overridden: the diffs under test were produced for this task.
  overrides.prompt = source.prompt;

  const config = resolveConfig(rawConfig, overrides, {
    repoRoot,
    configDir: configPath === null ? repoRoot : dirname(configPath),
  });

  if (cli.values['dry-run'] === true) {
    log.info(style.bold(`Would rescore run ${source.runId}`));
    log.info(`  base         ${source.baseSha.slice(0, 12)}`);
    log.info(`  patches      ${source.candidates.filter((c) => c.patchPath !== null).length}`);
    printPlan(config);
    return EXIT_OK;
  }

  const controller = new AbortController();
  const onSigint = (): void => {
    log.blank();
    log.warn('Interrupted. Stopping gates...');
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  const view = createLiveView(cli.values['no-live'] === true);

  let report: RunReport;
  try {
    report = await rescoreRun({
      config,
      source,
      runId: makeRunId(),
      onEvent: (event) => view.handle(event),
      signal: controller.signal,
    });
  } finally {
    view.stop();
    process.off('SIGINT', onSigint);
  }

  if (cli.values['json'] === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (cli.values['markdown'] === true) {
    process.stdout.write(`${renderMarkdownReport(report)}\n`);
  } else {
    log.blank();
    log.info(style.gray(`rescored from run ${source.runId} — no agents were invoked`));
    printRunSummary(report, config.minScore);
  }

  return report.winnerId === null ? EXIT_NO_WINNER : EXIT_OK;
}

/* ---------------------------------------------------------------- clean --- */

async function commandClean(cli: ParsedCli): Promise<number> {
  const cwd = currentDir();
  const repoRoot = await git.findRepoRoot(cwd);
  const workDir = join(repoRoot, '.flashover');
  const dryRun = cli.values['dry-run'] === true;

  const worktrees = (await git.listWorktrees(repoRoot)).filter((path) => path.startsWith(resolve(workDir)));

  if (worktrees.length === 0 && !existsSync(workDir)) {
    log.success('Nothing to clean.');
    return EXIT_OK;
  }

  for (const path of worktrees) {
    if (dryRun) {
      log.info(`would remove worktree ${path}`);
      continue;
    }
    await git.removeWorktree(repoRoot, path);
    log.debug(`removed worktree ${path}`);
  }

  if (dryRun) {
    log.info(`would delete ${workDir}`);
    return EXIT_OK;
  }

  await git.pruneWorktrees(repoRoot);
  await rm(workDir, { recursive: true, force: true });

  log.success(`Removed ${worktrees.length} worktree${worktrees.length === 1 ? '' : 's'} and deleted ${workDir}`);
  return EXIT_OK;
}

/* ---------------------------------------------------------------- utils --- */

function resolveConfigPath(cli: ParsedCli, cwd: string, repoRoot: string): string | null {
  const explicit = cli.values['config'];
  if (typeof explicit === 'string') {
    const path = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!existsSync(path)) throw new FlashoverError(`Config file not found: ${path}`);
    return path;
  }
  return findConfigFile(cwd, repoRoot);
}

function buildOverrides(cli: ParsedCli): ConfigOverrides {
  const overrides: ConfigOverrides = {};

  const agents = cli.values['agent'];
  if (Array.isArray(agents) && agents.length > 0) overrides.agents = agents as string[];

  const gates = cli.values['gate'];
  if (Array.isArray(gates) && gates.length > 0) overrides.gates = gates as string[];

  const seedLink = cli.values['seed-link'];
  if (Array.isArray(seedLink) && seedLink.length > 0) overrides.seedLink = seedLink as string[];

  const seedCopy = cli.values['seed-copy'];
  if (Array.isArray(seedCopy) && seedCopy.length > 0) overrides.seedCopy = seedCopy as string[];

  const candidates = numericOption(cli, 'candidates');
  if (candidates !== undefined) overrides.candidates = candidates;

  const concurrency = numericOption(cli, 'concurrency');
  if (concurrency !== undefined) overrides.concurrency = concurrency;

  const minScore = numericOption(cli, 'min-score');
  if (minScore !== undefined) overrides.minScore = minScore;

  const timeoutSeconds = numericOption(cli, 'timeout');
  if (timeoutSeconds !== undefined) overrides.agentTimeoutMs = timeoutSeconds * 1000;

  const judge = cli.values['judge'];
  if (typeof judge === 'string') overrides.judge = judge;

  const promptFile = cli.values['prompt-file'];
  if (typeof promptFile === 'string') overrides.promptFile = promptFile;

  const base = cli.values['base'];
  if (typeof base === 'string') overrides.baseRef = base;

  const promote = cli.values['promote'];
  if (typeof promote === 'string') overrides.promoteMode = promote as PromoteMode;

  const branchPrefix = cli.values['branch-prefix'];
  if (typeof branchPrefix === 'string') overrides.branchPrefix = branchPrefix;

  const keep = cli.values['keep'];
  if (typeof keep === 'string') overrides.keep = keep as KeepMode;

  return overrides;
}

function numericOption(cli: ParsedCli, name: string): number | undefined {
  const raw = cli.values[name];
  if (typeof raw !== 'string') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new FlashoverError(`--${name} expects a number, got "${raw}".`);
  }
  return parsed;
}

/** Read the version from the package manifest, tolerating unusual layouts. */
async function readVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const relative of ['../package.json', '../../package.json']) {
    try {
      const text = await readFile(resolve(here, relative), 'utf8');
      const parsed = JSON.parse(text) as { name?: string; version?: string };
      if (parsed.name === 'flashover' && typeof parsed.version === 'string') return parsed.version;
    } catch {
      // Try the next candidate path.
    }
  }
  return '0.0.0';
}

/**
 * The working directory with symlinks resolved.
 *
 * Every path flashover derives — the repository root, the artifact directory,
 * worktrees — ultimately comes from git, which reports real paths. Starting from
 * an unresolved cwd would make those comparisons fail wherever a directory sits
 * behind a symlink, which on macOS includes `/tmp` and `/var`.
 */
function currentDir(): string {
  try {
    return realpathSync(process.cwd());
  } catch {
    return process.cwd();
  }
}

function reportError(err: unknown): void {
  if (err instanceof FlashoverError) {
    log.error(err.message);
    if (err.hint !== undefined) log.info(`  ${style.gray(err.hint)}`);
    return;
  }
  log.error(err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack !== undefined) log.debug(err.stack);
}

const exitCode = await main(process.argv.slice(2)).catch((err: unknown) => {
  reportError(err);
  return EXIT_USAGE;
});

process.exitCode = exitCode;

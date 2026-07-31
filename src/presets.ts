/**
 * Built-in agent presets.
 *
 * These describe how to drive popular coding agents in non-interactive mode.
 * Agent CLIs change their flags frequently, so treat every preset as a starting
 * point: anything here can be overridden per-field in `flashover.yaml`, and
 * `flashover doctor` reports which presets are actually installed.
 */

import type { AgentDefinition, AgentConfigInput } from './types.js';
import { FlashoverError } from './types.js';

/**
 * Placeholders usable inside `args` entries.
 *
 * `{{prompt}}`      the task prompt (only for `promptMode: "arg"`)
 * `{{promptFile}}`  absolute path to a file holding the prompt
 * `{{worktree}}`    absolute path to this candidate's isolated worktree
 * `{{candidateId}}` short id such as `c3`
 * `{{index}}`       zero-based candidate index
 */
export const PLACEHOLDERS = ['prompt', 'promptFile', 'worktree', 'candidateId', 'index'] as const;

/**
 * The preset registry. Keys are the names accepted by `--agent`.
 *
 * Every preset must be non-interactive and must edit files in place inside its
 * working directory, because flashover measures results by diffing the worktree.
 */
export const PRESETS: Readonly<Record<string, AgentDefinition>> = Object.freeze({
  claude: {
    name: 'claude',
    command: 'claude',
    args: ['-p', '{{prompt}}', '--permission-mode', 'acceptEdits'],
    promptMode: 'arg',
    docs: 'https://docs.claude.com/en/docs/claude-code/cli-reference',
  },
  codex: {
    name: 'codex',
    command: 'codex',
    args: ['exec', '--sandbox', 'workspace-write', '{{prompt}}'],
    promptMode: 'arg',
    docs: 'https://github.com/openai/codex',
  },
  'cursor-agent': {
    name: 'cursor-agent',
    command: 'cursor-agent',
    args: ['-p', '{{prompt}}', '--force'],
    promptMode: 'arg',
    docs: 'https://cursor.com/docs/cli',
  },
  opencode: {
    name: 'opencode',
    command: 'opencode',
    args: ['run', '{{prompt}}'],
    promptMode: 'arg',
    docs: 'https://opencode.ai/docs/cli',
  },
  aider: {
    name: 'aider',
    command: 'aider',
    args: ['--message', '{{prompt}}', '--yes-always', '--no-auto-commits'],
    promptMode: 'arg',
    docs: 'https://aider.chat/docs/scripting.html',
  },
  gemini: {
    name: 'gemini',
    command: 'gemini',
    args: ['-p', '{{prompt}}', '--yolo'],
    promptMode: 'arg',
    docs: 'https://github.com/google-gemini/gemini-cli',
  },
  amp: {
    name: 'amp',
    command: 'amp',
    args: ['-x', '{{prompt}}'],
    promptMode: 'arg',
    docs: 'https://ampcode.com/manual',
  },
  crush: {
    name: 'crush',
    command: 'crush',
    args: ['run', '--yolo', '{{prompt}}'],
    promptMode: 'arg',
    docs: 'https://github.com/charmbracelet/crush',
  },
  goose: {
    name: 'goose',
    command: 'goose',
    args: ['run', '-t', '{{prompt}}'],
    promptMode: 'arg',
    docs: 'https://block.github.io/goose/docs/guides/goose-cli-commands',
  },
  /**
   * Reads the prompt from a file and does nothing else. Useful for smoke-testing
   * the orchestration pipeline without spending tokens.
   */
  noop: {
    name: 'noop',
    command: 'true',
    args: [],
    promptMode: 'stdin',
  },
});

/** Preset names, sorted, excluding internal helpers. */
export function presetNames(): string[] {
  return Object.keys(PRESETS)
    .filter((n) => n !== 'noop')
    .sort();
}

/**
 * Turn a config entry into a runnable {@link AgentDefinition}.
 *
 * A bare string is shorthand for `{ preset: "<string>" }`. Object form starts
 * from the named preset (defaulting to the `name` field when `preset` is
 * omitted) and overrides individual fields. When no preset matches, `command`
 * must be supplied explicitly.
 */
export function resolveAgent(input: string | AgentConfigInput): { agent: AgentDefinition; count: number } {
  const spec: AgentConfigInput = typeof input === 'string' ? { preset: input } : input;
  const presetKey = spec.preset ?? spec.name;
  const base = presetKey !== undefined ? PRESETS[presetKey] : undefined;

  if (base === undefined && spec.command === undefined) {
    const known = presetNames().join(', ');
    throw new FlashoverError(
      presetKey !== undefined
        ? `Unknown agent preset "${presetKey}" and no "command" was provided.`
        : 'Agent entry needs either a "preset" or a "command".',
      `Available presets: ${known}. Or define a custom agent with { command, args, promptMode }.`,
    );
  }

  const count = spec.count ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new FlashoverError(`Agent "${presetKey ?? spec.command}" has invalid count ${String(spec.count)}.`, 'count must be an integer >= 1.');
  }

  const command = spec.command ?? base?.command;
  if (command === undefined || command.trim() === '') {
    throw new FlashoverError(`Agent "${presetKey ?? 'custom'}" resolved to an empty command.`);
  }

  const args = spec.args ?? base?.args ?? [];
  const promptMode = spec.promptMode ?? base?.promptMode ?? 'arg';

  if (promptMode === 'arg' && !args.some((a) => a.includes('{{prompt}}'))) {
    throw new FlashoverError(
      `Agent "${spec.name ?? presetKey ?? command}" uses promptMode "arg" but no argument contains {{prompt}}.`,
      'Add {{prompt}} to args, or switch promptMode to "stdin" or "file".',
    );
  }
  if (promptMode === 'file' && !args.some((a) => a.includes('{{promptFile}}'))) {
    throw new FlashoverError(
      `Agent "${spec.name ?? presetKey ?? command}" uses promptMode "file" but no argument contains {{promptFile}}.`,
      'Add {{promptFile}} to args so the agent knows where to read the task from.',
    );
  }

  const env = { ...(base?.env ?? {}), ...(spec.env ?? {}) };
  const agent: AgentDefinition = {
    name: spec.name ?? presetKey ?? command,
    command,
    args: [...args],
    promptMode,
  };
  if (Object.keys(env).length > 0) agent.env = env;
  if (base?.docs !== undefined) agent.docs = base.docs;

  return { agent, count };
}

/**
 * Substitute `{{placeholder}}` tokens in an argument list.
 *
 * Unknown placeholders are left untouched rather than replaced with an empty
 * string, so typos surface as visible `{{typo}}` text in the agent invocation
 * instead of silently vanishing.
 */
export function substitutePlaceholders(args: readonly string[], values: Readonly<Record<string, string>>): string[] {
  return args.map((arg) =>
    arg.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      const value = values[key];
      return value === undefined ? match : value;
    }),
  );
}

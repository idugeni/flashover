# Configuration reference

flashover looks for the first of these files, walking up from the current directory to the repository root:

```
flashover.yaml   flashover.yml   flashover.json
.flashover.yaml  .flashover.yml  .flashover.json
```

Override with `--config <path>`. YAML and JSON are both parsed by the same loader, so either works. Unknown top-level keys produce a warning rather than an error, so a typo is visible instead of silent.

Every option can also be set from the command line, and **CLI flags win over the file** — except `seed`, which is additive.

---

## Full example

```yaml
version: 1

# The task. Usually passed as a CLI argument instead.
prompt: fix the flaky auth test
# promptFile: task.md          # relative to this config file

# Roster. Repeat entries or use `count` to run multiple copies.
agents:
  - preset: claude
    count: 2
  - preset: codex
  - name: my-harness
    command: ./scripts/agent.sh
    args: ['--task', '{{prompt}}']
    promptMode: arg
    env:
      MY_MODEL: fast

candidates: 4          # only scales a single-agent roster
concurrency: 2         # default: all at once
agentTimeoutMs: 1200000
baseRef: HEAD

seed:
  copy: ['.env']
  link: []             # see the warning below

gates:
  setup:
    - name: install
      run: npm ci --no-audit --no-fund
      timeoutMs: 600000
  scored:
    - name: typecheck
      run: npm run typecheck
      weight: 2
    - name: test
      run: npm test
      weight: 5
      required: true
      cwd: packages/core
      env:
        NODE_ENV: test

judge:
  run: ./scripts/judge.sh
  weight: 3
  timeoutMs: 300000

promote:
  mode: branch         # branch | patch | none
  branchPrefix: flashover/

keep: winner           # all | winner | none
minScore: 0
```

---

## Top level

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `version` | number | `1` | Config schema version. A higher value than the binary understands is an error. |
| `prompt` | string | — | The task. A CLI argument overrides it. |
| `promptFile` | string | — | Path to a file holding the task, resolved relative to the config file. |
| `candidates` | number | `3` | Target candidate count. Only scales a roster of one agent; see below. |
| `concurrency` | number | = `candidates` | Max agents in flight. Capped at `candidates`. |
| `agent` | string \| object | — | Shorthand for a single-entry roster. |
| `agents` | array | — | The roster. Takes precedence over `agent`. |
| `agentTimeoutMs` | number | `1200000` (20 min) | Per-agent limit. The whole process tree is killed on expiry. |
| `baseRef` | string | `HEAD` | Revision every candidate branches from. |
| `gates.setup` | array | `[]` | Preconditions. Always required, never weighted. |
| `gates.scored` | array | `[]` | The verification battery. |
| `judge` | object | — | Optional subjective scorer. |
| `seed` | object | `{}` | Gitignored paths to materialize per worktree. |
| `promote.mode` | enum | `branch` | `branch`, `patch`, or `none`. |
| `promote.branchPrefix` | string | `flashover/` | Prefix for the promoted branch name. |
| `keep` | enum | `winner` | Which worktrees survive: `all`, `winner`, `none`. |
| `minScore` | number | `0` | Refuse to promote below this. Range 0-100. |

A run needs at least one scored gate *or* a judge, otherwise candidates cannot be ranked and flashover refuses to start.

---

## Agents

An entry is either a preset name or an object:

| Field | Type | Notes |
| --- | --- | --- |
| `preset` | string | Base to inherit from. See `flashover doctor` for what's installed. |
| `name` | string | Display name. Defaults to the preset or command. |
| `command` | string | Executable. Required if no preset matches. Never run through a shell. |
| `args` | string[] | Argument list, with `{{placeholder}}` support. |
| `promptMode` | enum | `arg`, `stdin`, or `file`. |
| `env` | object | Extra environment variables. |
| `count` | number | Copies to run. Default `1`. |

### Placeholders

Usable inside `args`:

| Placeholder | Value |
| --- | --- |
| `{{prompt}}` | The task text. Required when `promptMode: arg`. |
| `{{promptFile}}` | Absolute path to a file holding the task. Required when `promptMode: file`. |
| `{{worktree}}` | Absolute path to this candidate's worktree. |
| `{{candidateId}}` | Short id, e.g. `c3`. |
| `{{index}}` | Zero-based candidate index. |

An unknown placeholder is left as literal `{{typo}}` text rather than replaced with an empty string, so mistakes are visible in the invocation.

### `candidates` vs roster counts

`candidates` scales a **single-agent** roster:

```yaml
agent: claude
candidates: 5      # → five Claude candidates
```

With an explicit multi-agent roster, the counts in the roster win and `candidates` is ignored with a warning. Rebalancing what you wrote by hand would be worse than telling you.

```yaml
agents:
  - { preset: claude, count: 2 }
  - { preset: codex }
# → three candidates, regardless of `candidates`
```

### Environment given to agents

| Variable | Value |
| --- | --- |
| `FLASHOVER` | `1` |
| `FLASHOVER_RUN_ID` | Run identifier |
| `FLASHOVER_CANDIDATE_ID` | e.g. `c2` |
| `FLASHOVER_CANDIDATE_INDEX` | Zero-based index |
| `FLASHOVER_WORKTREE` | Absolute worktree path |
| `FLASHOVER_PROMPT_FILE` | Path to the prompt file |
| `NO_COLOR` | `1` |

Gates additionally get `FLASHOVER_GATE` and `CI=1`.

---

## Gates

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | string | generated | Must be unique across setup and scored gates. |
| `run` | string | — | Shell command line, executed with `sh -c`. Required. |
| `weight` | number | `1` | Contribution to the score. Forced to `0` for setup gates. |
| `required` | boolean | `false` | A failure eliminates the candidate. Forced to `true` for setup gates. |
| `timeoutMs` | number | `600000` (10 min) | Process tree is killed on expiry. |
| `cwd` | string | worktree root | Relative path inside the worktree. Absolute paths are rejected. |
| `env` | object | — | Extra environment variables. |

Gates run **sequentially within a candidate** — they share one worktree, so concurrent builds would race on the same output directories. Parallelism happens across candidates.

Order your gates cheap to expensive. A required `typecheck` before `test` saves real minutes across five candidates.

### Inline syntax

`--gate "[!]name:command[*weight]"`

```bash
--gate "!test:npm test*5"      # required, weight 5
--gate "lint:npm run lint"     # optional, weight 1
--gate "npm test"              # name generated as gate1
--gate "check:sh -c 'a:b'"     # only the first colon splits
```

Passing any `--gate` replaces the file's scored gates entirely.

---

## Judge

| Field | Type | Default |
| --- | --- | --- |
| `run` | string | — |
| `weight` | number | `3` |
| `timeoutMs` | number | `300000` (5 min) |
| `env` | object | — |

Receives the unified diff on stdin, prints 0-100. Skipped for eliminated candidates, since it usually costs money and cannot change the outcome. See [judges.md](judges.md).

---

## Seed

Fresh worktrees contain only tracked files, so gitignored build inputs are absent and gates like `npm test` fail for reasons unrelated to the agent's work.

```yaml
seed:
  copy: ['.env']          # per candidate: safe, slower
  link: ['node_modules']  # symlinked: instant, SHARED across candidates
```

Paths are relative to the repository root. Absolute paths and `..` are rejected. A path cannot appear in both lists. CLI `--seed-copy` / `--seed-link` are **additive** to the file, because seeding is cumulative by nature.

Seeded paths are registered in `.git/info/exclude` so they never appear in a candidate's diff. This is not redundant with your `.gitignore`: a directory-only pattern like `node_modules/` does **not** match a symlink to a directory, so without the explicit exclude a linked seed would be staged as the agent's work.

> **Never combine `seed.link` with an install command.** `npm ci` deletes and recreates `node_modules`. Through a symlink, that rewrites your real dependency tree — from several candidates at once. Use `seed.copy`, or install per candidate with a setup gate. flashover warns when it detects this combination, but it cannot detect every form.

If a seeded path is tracked by git, flashover warns: the exclusion would discard genuine agent edits under it.

---

## Promotion and cleanup

`promote.mode`:

- `branch` — writes `git branch <prefix><slug> <sha>` at the winner's commit. Nothing is checked out. A name collision appends `-2`, `-3`, and so on.
- `patch` — no branch; the report points at the winner's `.patch` file.
- `none` — no branch. The commit becomes unreachable and may be garbage collected; the patch file remains.

`keep`:

- `all` — every worktree stays, for inspecting losers.
- `winner` — only the winner's worktree stays.
- `none` — all removed. Promoted branches are unaffected, because the commit lives in the shared object database.

---

## CLI flags

| Flag | Maps to |
| --- | --- |
| `-a, --agent <name[:count]>` | `agents`, repeatable |
| `-n, --candidates <n>` | `candidates` |
| `-j, --concurrency <n>` | `concurrency` |
| `-g, --gate <spec>` | `gates.scored`, repeatable, replaces the file's |
| `--judge <command>` | `judge.run` |
| `-f, --prompt-file <path>` | `promptFile` |
| `--base <ref>` | `baseRef` |
| `--timeout <seconds>` | `agentTimeoutMs` |
| `--min-score <0-100>` | `minScore` |
| `--promote <mode>` | `promote.mode` |
| `--branch-prefix <text>` | `promote.branchPrefix` |
| `--keep <mode>` | `keep` |
| `--seed-link <path>` | `seed.link`, repeatable, additive |
| `--seed-copy <path>` | `seed.copy`, repeatable, additive |
| `--dry-run` | print the resolved plan and exit |
| `-c, --config <path>` | config file to load |
| `--json` / `--markdown` | report format on stdout |
| `--no-live` | disable the in-place view |
| `-q, --quiet` / `-v, --verbose` | log level |

Passing both a task argument and `--prompt-file` is an error. Guessing which one you meant is worse than asking.

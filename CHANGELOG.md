# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

First release.

### Added

- **Parallel tournaments.** Run N coding agents concurrently, each in its own
  detached git worktree, then rank their diffs.
- **Verification gates.** Weighted shell commands scored per candidate, with
  `required: true` eliminating a candidate on failure. Setup gates run first as
  preconditions.
- **External judge contract.** Any command that reads a unified diff on stdin and
  prints 0-100 can act as a subjective scorer, so flashover needs no model
  integration or API keys.
- **Winner promotion.** The winning diff becomes a branch via a ref write, or a
  patch file. The user's working tree, index, and current branch are never
  touched.
- **`minScore`.** Refuse to promote anything below a threshold; the run exits `1`
  instead of handing back the least broken option.
- **Agent presets** for `claude`, `codex`, `cursor-agent`, `opencode`, `aider`,
  `gemini`, `amp`, `crush`, and `goose`, all overridable field by field, plus
  fully custom agent commands.
- **Worktree seeding.** `seed.copy` and `seed.link` materialize gitignored build
  inputs such as `node_modules` inside fresh worktrees.
- **Subcommands.** `run`, `init` (detects gates from `package.json`,
  `Cargo.toml`, `go.mod`, `pyproject.toml`), `doctor`, `report`, `rescore`,
  `clean`.
- **`rescore`.** Re-verify a previous run's stored patches against the current
  gates and judge, without invoking an agent. Agents are the only step that
  costs money, so retuning what ranks their output should be free. Inherits the
  task, base revision, and agent timings from the source run; records
  `rescoredFrom`.
- **Per-agent timeouts.** `agents[].timeoutMs` overrides the run-wide
  `agentTimeoutMs`, because one limit cannot serve both a hosted agent and a
  slow local harness.
- **`doctor --verify-presets`.** Runs each installed agent against a throwaway
  repository with a trivial task and reports which ones still work. Opt-in: it
  spends real tokens, and checking `--help` text instead would prove nothing.
- **Machine-readable reports.** `report.json` per run, plus `--json` and
  `--markdown` output for CI summaries. Logs go to stderr so stdout stays
  pipeable.
- **Live terminal view** on a TTY, degrading to append-only lines in CI.
- **Programmatic API** exported from the package root.

### Notes on behaviour

- `promote: patch` advertises the winner's patch file; `promote: none` advertises
  nothing at all. Both skip branch creation.
- `flashover clean` deletes `.flashover/`, which includes exported patches. Branch
  promotions survive it, patch promotions do not.

- Candidates branch from committed state; uncommitted work is invisible to agents
  and flashover warns about it.
- An agent that exits non-zero or times out is not evaluated at all. Its
  transcript and worktree are still kept.
- Timeouts kill the whole process tree, not just the direct child.
- Seeded paths are registered in `.git/info/exclude`, because a directory-only
  ignore pattern such as `node_modules/` does not match a symlink to a directory.
- Config discovery resolves symlinks before comparing against the repository
  root. git reports real paths, so an unresolved working directory would let the
  search escape the repository and pick up an unrelated config.
- Combining `seed.link` with an install command (`npm ci` and friends) would
  rewrite your real dependency tree from several candidates at once. flashover
  warns when it detects this.
- Patches are streamed from git straight to disk rather than buffered. Process
  output is capped and UTF-8 decoded, and a patch tolerates neither: the cap
  keeps the tail, which discards the `diff --git` header and produces a file
  `git apply` rejects. The same cap would drop numstat lines on a wide change and
  undercount the diff that ranking uses as a tie-breaker.
- Agent and gate binaries are resolved against PATH in-process. Asking a shell to
  do it meant that wherever the shell was absent, every binary looked absent too
  — including git, on the same `doctor` run that had already used git.
- Linux and macOS only. Gates, judges, timeout handling, and `seed.link` all
  depend on POSIX behaviour (`sh -c`, process-group signals, symlinks), so the
  package declares `"os": ["!win32"]` instead of installing and then failing.

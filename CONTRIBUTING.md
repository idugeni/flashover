# Contributing

## The most useful contribution

**Fixing an agent preset.** Agent CLIs change their flags constantly, and a stale preset means flashover appears broken for everyone using that agent. If `flashover doctor` finds your agent but a run fails immediately, the preset in `src/presets.ts` is probably wrong. Open an issue with the CLI name, its version, and the invocation that actually works non-interactively.

## Setup

```bash
git clone https://github.com/idugeni/flashover
cd flashover
npm install
npm run build
```

flashover is Linux and macOS only, and `package.json` declares `"os": ["!win32"]` so npm refuses to install it elsewhere rather than failing later at the first gate. On Windows, `npm install --force` gets you a working checkout for reading and typechecking, but the test suite will not pass: gates and judges need `sh`, and timeout handling needs POSIX process groups. See [issue tracker](https://github.com/idugeni/flashover/issues) for the state of Windows support.

## Checks

```bash
npm run typecheck    # tsc --noEmit over src and test
npm test             # unit + integration, ~4s
bash scripts/e2e.sh  # full pipeline with mock agents, no credentials needed
```

All three run in CI on Node 20, 22, and 24, across Linux and macOS. Run them locally before opening a PR.

Whether the built-in presets still match their agent CLIs is a separate question, and the only honest way to answer it is to run the agents:

```bash
flashover doctor --verify-presets
```

That points each installed agent at a throwaway repository with a trivial task and reports which ones edited a file and exited 0. It costs tokens, so it is not in CI. If you touch a preset, this is the check that matters — asserting on `--help` text would prove nothing, since a flag can survive while its behaviour changes.

Trying a change by hand:

```bash
npm run build
cd /some/other/repo
node /path/to/flashover/dist/cli.js "task" --dry-run
```

## Testing philosophy

Git and child processes are **not mocked**. `git.ts` runs against real repositories in temp directories and `exec.ts` against real commands, because the bugs worth catching live precisely in the gap between what the documentation says and what the tools actually do.

Two real bugs found this way, both of which a mock would have hidden:

- A directory-only ignore pattern (`node_modules/`) does not match a *symlink* to a directory, so symlinked seed paths leaked into every candidate's diff.
- Per-worktree exclude files (`.git/worktrees/<name>/info/exclude`) have no effect; linked worktrees read ignore rules from the common git directory.

If you are asserting something about git's behaviour, assert it against git.

## Adding an agent preset

In `src/presets.ts`:

```ts
myagent: {
  name: 'myagent',
  command: 'myagent',
  args: ['--non-interactive', '{{prompt}}'],
  promptMode: 'arg',
  docs: 'https://link-to-cli-reference',
},
```

Requirements:

1. **Non-interactive.** It must never prompt or wait on stdin.
2. **Edits files in place** in its working directory. Results are measured by diffing the worktree.
3. **Exits 0 on success.** A non-zero exit means the candidate is not evaluated at all.
4. **Does not commit.** flashover stages and commits itself; an agent that commits will confuse diff capture.

`presets.test.ts` asserts that every `promptMode: 'arg'` preset contains a `{{prompt}}` placeholder, so a preset that could never receive the task fails the build.

## Adding a feature

Read [docs/architecture.md](docs/architecture.md) first, specifically the **Invariants** section. Most of those are load-bearing for correctness. If a change needs to violate one, that is worth discussing in an issue before writing code.

Practical notes:

- New config options go through `resolveConfig`. Nothing downstream should ever see raw user input.
- `exec.ts` must keep never rejecting for process-level failures. A missing binary or non-zero exit is data in the result, not an exception.
- New `RunReport` fields are additive. Bump `REPORT_VERSION` in `types.ts` if the shape changes incompatibly.
- Diagnostics go to stderr via `log`. stdout is reserved for `--json` and `--markdown`, so piping stays safe.

## Style

Enforced by the compiler rather than a linter. `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and `isolatedModules` are all on, which means:

- `import type` for type-only imports
- indexing an array yields `T | undefined`, so handle it
- relative imports end in `.js`, because the output is ESM

For comments: explain *why*, not *what*. A comment that restates the code is noise; a comment recording a non-obvious constraint, a verified quirk of an external tool, or a rejected alternative earns its place.

## Pull requests

- One concern per PR.
- Say what you verified and how. "Added a test" is better than "should work".
- If behaviour changed, update the affected doc in the same PR.
- Do not bump the version; releases are cut separately.

## Reporting bugs

Include:

- `flashover doctor` output
- your `flashover.yaml`
- the failing command, and what you expected
- the relevant `report.json` and `logs/*.log` from `.flashover/`, with secrets removed

Transcripts are usually the fastest path to a diagnosis.

## License

Contributions are accepted under the MIT license.

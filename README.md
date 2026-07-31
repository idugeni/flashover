# flashover

**Ignite N coding agents at once. Ship the one that survives.**

A coding agent is a slot machine. Same prompt, same model, different answer — one run nails it, the next one reformats a file it was never asked to touch. The standard workaround is to run it again and read the diff yourself.

flashover runs the attempts *in parallel*, then decides between them with something more reliable than your patience: your test suite.

```bash
flashover "make add 2 3 return 5" -a claude -n 4 -g "!test:npm test"
```

Four agents wake up in four isolated git worktrees. Each produces a diff. Each diff runs the gauntlet — install, typecheck, lint, test, whatever you configure. They get scored, ranked, and the winner becomes a branch. The losers are deleted.

```
#  id  agent    status        score  gates  diff       agent time
-  --  -------  ------------  -----  -----  ---------  ----------
1  c1  fixer    WINNER         98.0  2/2    1f +1/-1   5ms
2  c2  sloppy   scored         63.5  1/2    1f +13/-1  6ms
-  c4  crasher  agent failed      -  -      -          5ms
-  c3  lazy     no changes        -  -      -          7ms

✓ c1 won with 98.0/100 (fixer)

  git diff flashover/make-add-2-3-return-5
  git switch flashover/make-add-2-3-return-5
```

Both `c1` and `c2` fixed the bug. `c2` also appended eleven lines of notes and left a `TODO`. flashover noticed, because the `no-todo` gate failed and the diff was thirteen times larger. That difference is the whole point.

---

## What makes this different

There are good tools for running many agents at once. flashover is about the step *after* that: deciding which output to trust.

|  | parallel runners | flashover |
| --- | --- | --- |
| Runs N agents concurrently | yes | yes |
| Isolates them from each other | yes | yes |
| **Verifies each result objectively** | no | yes — weighted gates |
| **Ranks and picks a winner** | no | yes |
| **Refuses to promote garbage** | no | yes — `minScore` |
| **Machine-readable verdict** | no | yes — `report.json` |

You are not asked to review five diffs. You are handed one, with a receipt.

---

## Install

```bash
npm install -g flashover
```

Or run it without installing:

```bash
npx flashover "fix the flaky auth test" -a claude -g "!test:npm test"
```

Requires Node 20.11+, git, and at least one agent CLI on your PATH. Check with:

```bash
flashover doctor
```

---

## Quickstart

```bash
cd your-repo
flashover init          # detects your test/lint/build commands, writes flashover.yaml
flashover doctor        # confirms git, config, and agents are ready
flashover "your task"   # runs the tournament
```

`flashover init` reads your `package.json`, `Cargo.toml`, `go.mod`, or `pyproject.toml` and proposes gates it can find. Review the file before your first real run — `flashover --dry-run "task"` prints exactly what would execute without spending a token.

---

## How a run works

Each candidate goes through the same pipeline, in this order:

```
git worktree add --detach     isolate: agents cannot see or clobber each other
seed                          materialize gitignored inputs (node_modules, .env)
run agent                     the only step that costs money
git add -A                    capture whatever the agent left behind
diff + patch                  record the result BEFORE any gate can pollute it
commit                        give the diff a sha, so promotion is just a ref write
setup gates                   install/prepare; failure means "cannot be evaluated"
scored gates                  the actual verification, cheap before expensive
judge                         optional subjective score over the diff
```

Two details in there matter more than they look:

**The diff is captured before gates run.** Gates create `node_modules`, `dist`, `coverage`. If you staged after running them, all of that would be attributed to the agent.

**Promotion never checks anything out.** The winner's commit already exists, so flashover just writes `git branch <name> <sha>`. Your working tree, your index, and your current branch are untouched — during the run and after it.

---

## Scoring

The score is a weighted pass rate, on purpose. You should be able to recompute it by hand, because a ranking nobody trusts is a ranking nobody ships from.

```
score = (weight of passed gates + judgeScore/100 × judgeWeight)
        ────────────────────────────────────────────────────────  × 100
        (weight of all configured gates + judgeWeight)
```

Worked example, from the run above:

```yaml
gates:
  scored:
    - { name: test,    run: sh ./test.sh,        weight: 5, required: true }
    - { name: no-todo, run: '! grep -q TODO *',  weight: 1 }
judge:
  run: ./judge.sh
  weight: 2
```

`c1` passed both gates (5 + 1 = 6) and the judge gave it 92. Total weight is 8.

```
(6 + 0.92 × 2) / 8 × 100 = 98.0
```

Rules worth knowing:

- **`required: true` eliminates.** A failed required gate stops that candidate immediately. No point running a four-minute test suite against a tree that does not compile.
- **Gates that never ran count as failures.** Their weight stays in the denominator, so an eliminated candidate is not flattered by having fewer gates counted against it.
- **A broken judge does not penalize the candidate.** If the judge command fails or prints garbage, its weight is dropped from *that* candidate's denominator. Infrastructure flakiness should not decide which patch ships.
- **Ties break toward the smaller diff**, then the faster agent, then candidate order. Equal verified behaviour plus less churn is strictly better to review.
- **`minScore` can refuse everything.** If the best candidate falls short, flashover promotes nothing and exits `1`. A run where every agent broke the build should not quietly hand you the least broken option.

---

## The judge is any command

flashover has no LLM integration, no API keys, no provider SDK. A judge is a command that reads a unified diff on stdin and prints a score from 0-100.

```bash
#!/bin/sh
# Penalize large diffs. That's a valid judge.
added=$(grep -c '^+[^+]')
score=$((100 - added * 8))
[ "$score" -lt 0 ] && score=0
echo "$score"
```

That means your judge can be an LLM call, a shell one-liner, a static analyzer, a complexity metric, or your own house style checker — without flashover knowing anything about it. Structured output works too: any `{"score": 87}` object in stdout is picked up.

See [docs/judges.md](docs/judges.md) for LLM judge examples.

---

## Supported agents

Presets ship for `claude`, `codex`, `cursor-agent`, `opencode`, `aider`, `gemini`, `amp`, `crush`, and `goose`.

Agent CLIs change their flags often, so treat every preset as a starting point. Any field can be overridden, and anything that edits files in its working directory can be an agent:

```yaml
agents:
  - preset: claude
    count: 2
  - preset: codex
  - name: my-harness
    command: ./scripts/my-agent.sh
    args: ['--task', '{{prompt}}']
    promptMode: arg
```

Mixing agents is where this gets interesting: run Claude against Codex against your own harness on the same task, and let the gates settle it.

---

## Common recipes

```bash
# Best of five from one agent
flashover "refactor the token parser" -a claude -n 5 -g "!test:npm test"

# Head-to-head across agents
flashover "add retry with backoff" -a claude -a codex -a cursor-agent

# Weighted gates: tests matter 5x more than lint
flashover "tidy the error paths" -g "!test:npm test*5" -g "lint:npm run lint"

# Only accept excellent work, otherwise promote nothing
flashover "harden the CSV importer" --min-score 90

# Long task from a file, patch instead of a branch
flashover -f task.md --promote patch --timeout 3600

# Keep every worktree to inspect the losers yourself
flashover "why is this slow" --keep all
```

Inline gate syntax: `[!]name:command[*weight]` — `!` marks it required, `*N` sets the weight.

---

## Use it in CI

Exit codes are part of the contract:

| code | meaning |
| --- | --- |
| `0` | a winner was promoted |
| `1` | the run completed, nothing acceptable |
| `2` | usage, config, or environment error |
| `130` | interrupted |

```yaml
- run: flashover -f task.md --min-score 85 --markdown >> "$GITHUB_STEP_SUMMARY"
```

`--json` emits the full report on stdout; all logs go to stderr, so piping is safe. See [docs/ci.md](docs/ci.md).

---

## Artifacts

Every run leaves a directory you can dig into:

```
.flashover/run-20260731-062332-338-9f3a/
├── report.json          the machine-readable verdict
├── logs/c1.log          full agent transcript, tail -f while it runs
├── patches/c1.patch     each candidate's diff, applies with git apply
└── c1/                  the worktree itself (kept per `keep` policy)
```

`.flashover/` is added to `.git/info/exclude` automatically, not to your `.gitignore` — flashover is borrowing your repo and shouldn't leave a tracked change behind.

`flashover clean` removes all of it. Promoted **branches** survive, because the commit lives in git's object database. Promoted **patches** do not — they are files inside `.flashover/`. If you used `--promote patch`, apply or copy the patch before cleaning.

If you run flashover often, alias it:

```bash
alias fo=flashover
```

---

## Things to know before you trust it

Honest limitations, not a feature list:

- **Candidates branch from committed state.** Uncommitted work in your tree is invisible to every agent. flashover warns you, but it will not silently include it. Commit, stash, or point `--base` somewhere else.
- **A failing agent is not evaluated.** Non-zero exit or timeout means no gates run, even if the agent produced useful work first. Strict on purpose; the transcript is kept either way.
- **Fresh worktrees have no `node_modules`.** Either install per candidate with a setup gate (correct, slower) or `seed.link` it (fast, but *shared* — never combine that with `npm ci`, which would rewrite your real dependency tree from several candidates at once). flashover warns if you do.
- **Gates are shell commands with your permissions.** They are not sandboxed. Same trust model as a `package.json` script.
- **Your gates are the ceiling.** flashover cannot tell you which diff is better than your tests can. Weak gates produce a confident ranking of nothing.

---

## Docs

- [Configuration reference](docs/configuration.md) — every option, every default
- [Writing judges](docs/judges.md) — the contract, plus LLM examples
- [CI recipes](docs/ci.md) — GitHub Actions, GitLab, exit code handling
- [Architecture](docs/architecture.md) — module map and the invariants that matter

## Programmatic use

```ts
import { findRepoRoot, resolveConfig, runTournament, makeRunId } from 'flashover';

const repoRoot = await findRepoRoot(process.cwd());
const config = resolveConfig(
  {
    agents: [{ preset: 'claude', count: 3 }],
    gates: { scored: [{ name: 'test', run: 'npm test', weight: 5, required: true }] },
  },
  { prompt: 'fix the flaky auth test' },
  { repoRoot, configDir: repoRoot },
);

const report = await runTournament({ config, runId: makeRunId() });
console.log(report.winnerId, report.promotedBranch);
```

## Contributing

Agent CLIs move fast and presets rot. If one is wrong, [open an issue](https://github.com/idugeni/flashover/issues) — that is the single most useful contribution to this project.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT

# Architecture

## Module map

```
cli.ts          argument parsing, subcommands, exit codes
  config.ts     discovery, validation, normalization → ResolvedConfig
  presets.ts    agent registry, placeholder substitution
  tournament.ts the orchestrator: the only module that knows the full pipeline
    git.ts      worktree isolation, diff capture, promotion
    agent.ts    agent invocation, transcript capture
    gates.ts    gate battery, judge invocation
    score.ts    weighted scoring, ranking, winner selection
  rescore.ts    re-verification of a previous run's stored patches
  verify.ts     behavioural probe of the built-in agent presets
  report.ts     report.json persistence, leaderboard rendering
  ui.ts         live terminal view
  exec.ts       process spawning: timeouts, process-group kills, output caps
  log.ts        stderr logging, ANSI styling
  util.ts       concurrency pool, formatting
index.ts        programmatic API
```

Dependencies point downward only. `tournament.ts` is the single place that understands candidate lifecycle; everything below it is independently testable.

`rescore.ts` sits beside `tournament.ts` rather than inside it. The two share everything after a diff exists — gates, judge, scoring, promotion, cleanup — and differ only in where the diff comes from: an agent, or a patch on disk. The orchestration skeleton is short enough that duplicating it costs less than an abstraction serving both. What it does not duplicate is `promoteWinner` and `cleanupWorktrees`, which are imported, because those encode user-visible policy and two copies would drift.

## Data flow

```
user config + CLI flags
        │
        ▼
   resolveConfig ──────────────► ResolvedConfig   (validated, defaults applied)
        │
        ▼
   runTournament
        │
        ├── per candidate ──► CandidateResult
        │
        ▼
   rankCandidates → pickWinner → promote
        │
        ▼
   RunReport ──────────────────► report.json
                                      │
                                      ▼
                          leaderboard / markdown / JSON
```

`ResolvedConfig` is the boundary: nothing downstream sees raw user input. `RunReport` is the other boundary: every renderer is a view over it, never a second source of truth.

---

## Invariants

These are the things that will break the tool if violated. Most are load-bearing for correctness, not style.

### 1. Nothing flashover writes may land inside a candidate worktree

Results are measured by diffing the worktree. A prompt file or log written there would be attributed to the agent. Prompt files go to `<runDir>/scratch/`, transcripts to `<runDir>/logs/`, patches to `<runDir>/patches/`.

### 2. The diff is captured before any gate runs

Gates create `node_modules`, `dist`, `coverage`. Staging after them would attribute all of it to the agent. Order is fixed: `git add -A` → `diff` → `patch` → `commit` → gates.

### 3. Promotion never checks anything out

The candidate's changes are committed inside its own worktree, producing a sha in the shared object database. Promotion is `git branch <name> <sha>`. The user's working tree, index, and current branch are never touched — which is also why removing the winner's worktree afterwards is safe.

### 4. Timeouts kill the whole process tree

Agents spawn language servers, test runners, package managers. Killing only the direct child leaves orphans holding the worktree open, which makes `git worktree remove` fail. Children are spawned `detached: true` and signalled as a process group (`process.kill(-pid)`), SIGTERM then SIGKILL.

### 5. Seeded paths must be explicitly excluded

A directory-only ignore pattern (`node_modules/`) does **not** match a symlink to a directory. Verified behaviour. So `seedWorktree` registers every seeded path in `.git/info/exclude` without a trailing slash. Per-worktree exclude files (`.git/worktrees/<name>/info/exclude`) do **not** work — linked worktrees read ignore rules from the common git directory.

Updates to that file are serialized and written through a rename. Candidates seed concurrently, so an unsynchronized read-modify-write interleaves destructively: one call reads the file while another has truncated it, concludes it is empty, and writes back only its own pattern — discarding `.flashover/`, every earlier exclusion, and any line the user put there themselves. That is data loss in a file flashover only borrowed. Reproduced in roughly one of fifteen four-candidate seeded runs before the queue existed, and zero of thirty after.

### 6. Gates run sequentially within a candidate, in parallel across candidates

Gates in one candidate share a worktree, so concurrent builds would race on the same output directories. Parallelism belongs at the candidate level.

### 7. A single candidate's failure never voids the tournament

`runCandidate` is wrapped: an infrastructure error marks that candidate `error` and the run continues. Likewise `exec` never rejects for process-level failures; a missing binary or non-zero exit is data in the result, not an exception.

### 8. Cleanup failures are not fatal

The run already produced its verdict. Leftover directories are recoverable with `flashover clean`.

### 9. A patch is byte-exact or it is worthless

`git diff --cached --binary` is streamed straight to the patch file via `exec`'s `stdoutPath`, never buffered. Buffering broke it twice over, silently: the retained-output cap keeps the *tail*, so a patch over 256 KB lost its leading `diff --git` header and `git apply` rejected it, and UTF-8 decoding corrupts diffs of files that are not valid UTF-8. The same file is what the judge scores and what `promote: patch` hands back, so a partial write is worse than a hard failure. For the same reason `stagedDiffStat` reads numstat uncapped: dropped lines are silently missing files, and the resulting undercount feeds the churn tie-breaker.

### 10. Binary lookup never depends on a shell

`commandExists` resolves PATH in-process. Delegating to `sh -c "command -v"` meant that on a machine without `sh`, every binary was reported missing — including git, on the same `doctor` run that had just used git to locate the repository. A diagnostic that contradicts itself is worse than no diagnostic.

### 11. A rescore never fabricates what only an agent could produce

`rescore` recomputes gates, judge, score, and diff, because those are functions of the current configuration. It inherits the task, the base revision, agent exit status, timings, and transcripts, because those are facts about a run that already happened. `agentDurationMs` is the sharp edge: it is a ranking tie-breaker, so substituting `git apply`'s runtime would make a rescored leaderboard break ties differently from the run it claims to re-examine. Reports produced this way carry `rescoredFrom` so the distinction survives into anything reading them.

---

## Scoring model

Deliberately simple, so a leaderboard can be recomputed by hand:

```
numerator   = Σ(weight of passed scored gates) + judgeScore/100 × judgeWeight
denominator = Σ(weight of all configured scored gates) + judgeWeight
score       = numerator / denominator × 100
```

Two asymmetries are intentional:

- **Gates that never ran count as failures.** Their weight stays in the denominator, so an eliminated candidate is not flattered by having fewer gates counted against it.
- **A judge that produced no score is dropped from the denominator.** A broken judge is flashover's problem, not the candidate's. Scoring it as zero would let infrastructure flakiness decide which patch ships.

Tie-breakers, in order: score, then total churn (`insertions + deletions`) ascending, then agent duration ascending, then candidate index. The churn tie-breaker is the one that earns its keep — it systematically punishes the common agent failure mode of reformatting files it was not asked to touch.

`CandidateStatus` values that are *rankable*: `scored`, `winner`. Everything else (`no-changes`, `agent-failed`, `eliminated`, `error`) sorts below all rankable candidates regardless of score.

---

## Artifact layout

```
.flashover/
└── run-20260731-062332-338-9f3a/
    ├── report.json
    ├── c1/ c2/ c3/            candidate worktrees (per `keep`)
    ├── logs/c1.log            agent transcripts, streamed live
    ├── patches/c1.patch       `git diff --cached --binary` output
    └── scratch/c1.prompt.txt  prompt files for promptMode: file
```

Run ids are `YYYYMMDD-HHMMSS-mmm-xxxx` (date, time, milliseconds, random). `findLatestRunDir` sorts them as strings, so both trailing segments matter: milliseconds keep that sort chronological for back-to-back runs, and the random suffix guarantees two runs never share a directory — a collision would be destructive, because creating a candidate worktree clears any leftover directory at its path.

---

## Testing strategy

- **Pure logic** — scoring, ranking, config validation, placeholder substitution, numstat parsing. Fast, exhaustive.
- **Process behaviour** — `exec.ts` is tested against real commands: timeouts, tree kills (a backgrounded grandchild that must not survive), output caps, abort signals, stdin.
- **Git behaviour** — `git.ts` runs against real repositories in temp dirs. The isolation guarantees are only meaningful if git actually behaves as assumed, so those assumptions are asserted rather than trusted.
- **Interruption** — the CLI is spawned as a child process and sent a real `SIGINT`, then checked for exit code `130`, a partial `report.json`, and a repository left clean enough for the next run to start. Skipped on Windows, which has no faithful equivalent of the signal. Mocking the abort here would test the plumbing rather than the promise, and the promise is the part users rely on.

```bash
npm run typecheck
npm test
```

No mocking of git or child processes. The bugs worth catching here live precisely in the gap between what the docs say and what the tools do.

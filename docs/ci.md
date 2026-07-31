# Running flashover in CI

flashover is designed to be a CI step: logs go to stderr, machine-readable output goes to stdout, and the exit code carries the verdict.

> **Not yet published to npm.** The recipes below use `npm install -g flashover`, which is where they will land once released. Until then, substitute a build from source:
>
> ```yaml
> - run: |
>     git clone --depth 1 https://github.com/idugeni/flashover /tmp/flashover
>     cd /tmp/flashover && npm ci && npm run build && npm link
> ```

## Exit codes

| Code | Meaning | Typical handling |
| --- | --- | --- |
| `0` | A winner was promoted | continue: push the branch, open a PR |
| `1` | Run completed, nothing acceptable | fail the job, or post the report and stop |
| `2` | Usage, config, or environment error | fail the job; this is a misconfiguration |
| `130` | Interrupted | job was cancelled |

`1` and `2` mean different things. `1` is a legitimate answer — the agents tried and none produced something that passed. `2` means flashover never got to run properly.

## Streams

- **stdout** — only `--json` or `--markdown` output. Safe to pipe.
- **stderr** — the live view, warnings, the leaderboard, everything else.

```bash
flashover -f task.md --json > report.json 2> flashover.log
```

The live view detects a non-TTY and switches to append-only line output, so CI logs stay readable.

---

## GitHub Actions

```yaml
name: agent tournament
on:
  workflow_dispatch:
    inputs:
      task:
        description: What should the agents do?
        required: true

jobs:
  tournament:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # worktrees need real history

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - run: npm ci
      - run: npm install -g flashover

      - name: Run the tournament
        id: tournament
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          flashover "${{ inputs.task }}" \
            --agent claude:3 \
            --gate '!test:npm test*5' \
            --gate 'lint:npm run lint' \
            --min-score 80 \
            --markdown >> "$GITHUB_STEP_SUMMARY"

      - name: Push the winning branch
        if: steps.tournament.outcome == 'success'
        run: |
          branch=$(node -e "
            const fs=require('fs');
            const dir=fs.readdirSync('.flashover').filter(d=>d.startsWith('run-')).sort().pop();
            process.stdout.write(JSON.parse(fs.readFileSync('.flashover/'+dir+'/report.json','utf8')).promotedBranch ?? '');
          ")
          [ -n "$branch" ] && git push origin "$branch"
```

`fetch-depth: 0` matters. A shallow clone can still create worktrees, but `--base` against anything other than `HEAD` will fail.

### Posting the report as a PR comment

```yaml
      - name: Comment the leaderboard
        if: always()
        run: flashover report --markdown | gh pr comment "${{ github.event.pull_request.number }}" --body-file -
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## GitLab CI

```yaml
agent-tournament:
  image: node:22
  variables:
    GIT_DEPTH: 0
  script:
    - npm ci
    - npm install -g flashover
    - flashover -f task.md --min-score 80 --json > report.json
  artifacts:
    when: always
    paths:
      - report.json
      - .flashover/*/logs/
    expire_in: 1 week
```

---

## Keeping artifacts

Transcripts and patches are the reason to run this in CI at all — they explain *why* four of five agents failed.

```yaml
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: flashover-run
          path: |
            .flashover/*/report.json
            .flashover/*/logs/
            .flashover/*/patches/
```

Use `--keep none` in CI. Worktrees are large and worthless once the patch is exported.

---

## Cost control

Every candidate is a full agent invocation. Five candidates is five times the spend.

```bash
# Cap parallelism to stay under provider rate limits
flashover "task" -a claude -n 5 -j 2

# Cap runtime per agent
flashover "task" --timeout 600

# Fail fast on cheap gates before expensive ones
flashover "task" -g '!typecheck:npm run typecheck' -g '!test:npm test*5'
```

That last one matters more than it looks: a required `typecheck` eliminates broken candidates before the test suite runs, which is where the wall-clock time goes.

---

## Reading the report programmatically

```js
const report = JSON.parse(fs.readFileSync('.flashover/run-X/report.json', 'utf8'));

report.winnerId;         // 'c1' or null
report.promotedBranch;   // 'flashover/fix-auth' or null
report.candidates;       // every candidate, including failures

for (const c of report.candidates) {
  console.log(c.id, c.agentName, c.status, c.score, c.diff);
  for (const g of c.gates) if (!g.passed) console.log(' failed:', g.name, g.stderrTail);
}
```

`report.version` is the schema version; check it if you build tooling on top.

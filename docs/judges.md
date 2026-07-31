# Writing judges

Gates answer "does it work". A judge answers "is it any good" — readability, approach, whether the fix addresses the cause or the symptom. Things a test suite cannot see.

## The contract

A judge is **any command** that:

1. reads a unified diff on **stdin**
2. prints a score from **0 to 100** on **stdout**
3. exits **0**

That is the entire interface. flashover has no model integration, no API keys, and no provider SDK, which means your judge can be anything you can execute.

### Accepted output

Checked in this order:

```
{"score": 87, "reason": "clean, minimal, handles the null case"}
```

```
The approach is sound but the error handling is duplicated.
87
```

Also accepted: `87.5`, `87/100`, `score: 87`.

Values outside 0-100 are clamped — a judge answering `120` clearly means "excellent". When several JSON objects appear, the last one wins, so a judge that narrates before deciding still works.

### Failure is safe

If the judge exits non-zero or prints nothing parseable, the candidate gets `judgeScore: null` and the judge's weight is dropped from **that candidate's** denominator. It is not scored as zero.

This matters: scoring a failed judge as zero would let a flaky API decide which patch ships. The failure is recorded in the report and warned about on stderr.

### Environment

`FLASHOVER`, `FLASHOVER_RUN_ID`, `FLASHOVER_CANDIDATE_ID`, `FLASHOVER_WORKTREE`, `NO_COLOR`. The working directory is the candidate's worktree, so you can inspect the full post-change tree, not just the diff.

---

## Example: diff size

No LLM, no cost, surprisingly effective at catching agents that reformat whole files.

```bash
#!/bin/sh
# judge/size.sh
added=$(grep -c '^+[^+]')
score=$((100 - added * 2))
[ "$score" -lt 0 ] && score=0
echo "$score"
```

```yaml
judge:
  run: ./judge/size.sh
  weight: 2
```

## Example: Claude as the judge

```bash
#!/bin/sh
# judge/claude.sh
diff=$(cat)

claude -p "You are reviewing one candidate patch. Rate it 0-100 on correctness,
minimality, and whether it fixes the cause rather than the symptom.
Reply with ONLY a JSON object: {\"score\": <number>, \"reason\": \"<one line>\"}

$diff"
```

```yaml
judge:
  run: ./judge/claude.sh
  weight: 3
  timeoutMs: 120000
```

Weight it modestly. Gates are objective; a judge is an opinion, and an opinion should not outvote a failing test suite.

## Example: reject forbidden patterns

```bash
#!/bin/sh
# judge/house-style.sh
diff=$(cat)
score=100

echo "$diff" | grep -q '^+.*console\.log'   && score=$((score - 30))
echo "$diff" | grep -q '^+.*@ts-ignore'     && score=$((score - 40))
echo "$diff" | grep -q '^+.*eslint-disable' && score=$((score - 25))
echo "$diff" | grep -qi '^+.*TODO'          && score=$((score - 15))

[ "$score" -lt 0 ] && score=0
echo "$score"
```

For hard rules, prefer a `required: true` gate — elimination is clearer than a deduction. Use a judge when the signal is a matter of degree.

## Example: existing tooling

```yaml
# Complexity delta as a score
judge:
  run: "cat > /tmp/p.diff && npx complexity-report-cli --score src/"
  weight: 2
```

---

## Choosing a weight

Total weight decides how much influence anything has. With gates at 5 and 1:

| judge weight | judge's max share |
| --- | --- |
| `1` | 12.5% |
| `3` | 33% |
| `10` | 62.5% |

A judge heavy enough to overrule a required gate is pointless — required gates eliminate before the judge ever runs.

## Debugging a judge

Feed it a real patch from a previous run:

```bash
cat .flashover/run-*/patches/c1.patch | ./judge/claude.sh
```

Then confirm flashover agrees with you:

```bash
flashover report --json | node -e "
  const r = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  for (const c of r.candidates) console.log(c.id, c.judgeScore, c.score.toFixed(1));
"
```

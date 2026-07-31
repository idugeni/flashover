#!/usr/bin/env bash
#
# End-to-end verification with mock agents.
#
# Exercises the full pipeline — worktree isolation, diff capture, gate battery,
# judging, ranking, promotion, cleanup — without any provider credentials, so it
# can run on every commit.
#
# Usage: bash scripts/e2e.sh
set -euo pipefail

CLI="$(pwd)/dist/cli.js"
if [ ! -f "$CLI" ]; then
  echo "dist/cli.js not found. Run 'npm run build' first." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

AGENTS="$WORK/agents"
REPO="$WORK/repo"
mkdir -p "$AGENTS" "$REPO"

pass=0
fail=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  ok   %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$label" "$expected" "$actual" >&2
    fail=$((fail + 1))
  fi
}

# ---------------------------------------------------------------- mock agents

# Correct, minimal fix.
cat > "$AGENTS/fixer.sh" <<'EOF'
#!/bin/sh
echo "fixer: $1"
sed -i.bak 's|echo \$((a - b))|echo $((a + b))|' calc.sh && rm -f calc.sh.bak
EOF

# Correct fix buried in unrelated churn, and leaves a TODO behind.
cat > "$AGENTS/sloppy.sh" <<'EOF'
#!/bin/sh
echo "sloppy: $1"
sed -i.bak 's|echo \$((a - b))|echo $((a + b)) # TODO clean up|' calc.sh && rm -f calc.sh.bak
{
  echo ""
  echo "# ---- notes ----"
  for i in 1 2 3 4 5 6 7 8 9 10; do echo "# note $i"; done
} >> calc.sh
EOF

# Exits 0 but changes nothing.
cat > "$AGENTS/lazy.sh" <<'EOF'
#!/bin/sh
echo "lazy: $1"
echo "looks fine to me"
EOF

# Fails outright, the way a rate-limited agent would.
cat > "$AGENTS/crasher.sh" <<'EOF'
#!/bin/sh
echo "crasher: $1"
echo "rate limit exceeded" >&2
exit 1
EOF

# Judge: penalize large diffs. Demonstrates the stdin/stdout contract.
cat > "$AGENTS/judge.sh" <<'EOF'
#!/bin/sh
added=$(grep -c '^+[^+]' || true)
score=$((100 - added * 8))
[ "$score" -lt 0 ] && score=0
echo "$score"
EOF

chmod +x "$AGENTS"/*.sh

# ------------------------------------------------------------------ demo repo

cd "$REPO"
git init -q -b main
git config user.name "e2e"
git config user.email "e2e@example.com"

# A real bug: add() subtracts.
cat > calc.sh <<'EOF'
#!/bin/sh
add() {
  a=$1
  b=$2
  echo $((a - b))
}
add "$@"
EOF

cat > test.sh <<'EOF'
#!/bin/sh
result=$(sh calc.sh 2 3)
[ "$result" = "5" ] && { echo "PASS"; exit 0; }
echo "FAIL: got $result, want 5"
exit 1
EOF

cat > flashover.yaml <<EOF
version: 1
agents:
  - name: fixer
    command: $AGENTS/fixer.sh
    args: ['{{prompt}}']
  - name: sloppy
    command: $AGENTS/sloppy.sh
    args: ['{{prompt}}']
  - name: lazy
    command: $AGENTS/lazy.sh
    args: ['{{prompt}}']
  - name: crasher
    command: $AGENTS/crasher.sh
    args: ['{{prompt}}']
gates:
  scored:
    - name: test
      run: sh ./test.sh
      weight: 5
      required: true
    - name: no-todo
      run: '! grep -q TODO calc.sh'
      weight: 1
judge:
  run: $AGENTS/judge.sh
  weight: 2
promote:
  mode: branch
keep: all
EOF

git add -A
git commit -qm "initial: calculator with a broken add"
BASE_SHA="$(git rev-parse HEAD)"

echo "the bug is real:"
if sh test.sh > /dev/null 2>&1; then
  echo "  FAIL baseline test unexpectedly passed" >&2
  exit 1
fi
echo "  ok   baseline test fails as expected"

# ------------------------------------------------------------------- dry run

echo
echo "dry run:"
DRY="$(node "$CLI" "make add 2 3 return 5" --dry-run 2>&1)"
check "reports 4 candidates" "yes" "$(echo "$DRY" | grep -q 'candidates   4' && echo yes || echo no)"
check "does not create artifacts" "no" "$([ -d .flashover ] && echo yes || echo no)"

# ------------------------------------------------------------------ real run

echo
echo "tournament:"
set +e
node "$CLI" "make add 2 3 return 5" --no-live > /dev/null 2>&1
RUN_EXIT=$?
set -e
check "exit code 0 (winner promoted)" "0" "$RUN_EXIT"

# Run ids sort chronologically, so the last path is the newest run.
latest_report() {
  find "$REPO/.flashover" -name report.json | sort | tail -1
}

# Read one top-level report field. The field name is passed as argv rather than
# interpolated into JS, so no shell quoting can leak into code.
report_field() {
  node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const v = r[process.argv[2]];
    process.stdout.write(v === null || v === undefined ? "null" : String(v));
  ' "$1" "$2"
}

REPORT="$(latest_report)"
check "report.json written" "yes" "$([ -n "$REPORT" ] && echo yes || echo no)"

# Extract everything in one pass into shell variables. Building JS expressions
# from shell strings needs too many layers of quoting to stay readable.
node - "$REPORT" > "$WORK/report.env" <<'NODE'
const { readFileSync } = require('node:fs');
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const byId = (id) => report.candidates.find((c) => c.id === id) ?? {};
const gate = (id, name) => (byId(id).gates ?? []).find((g) => g.name === name) ?? {};

const values = {
  WINNER: report.winnerId ?? '',
  BASE: report.baseSha ?? '',
  BRANCH: report.promotedBranch ?? '',
  C1_STATUS: byId('c1').status ?? '',
  C2_STATUS: byId('c2').status ?? '',
  C3_STATUS: byId('c3').status ?? '',
  C4_STATUS: byId('c4').status ?? '',
  C1_BEATS_C2: String(byId('c1').score > byId('c2').score),
  C2_NO_TODO_FAILED: String(gate('c2', 'no-todo').passed === false),
  C1_JUDGED: String(byId('c1').judgeScore !== null && byId('c1').judgeScore !== undefined),
  C1_FILES: String(byId('c1').diff?.filesChanged ?? ''),
  C2_CHURN: String((byId('c2').diff?.insertions ?? 0) + (byId('c2').diff?.deletions ?? 0)),
  C1_CHURN: String((byId('c1').diff?.insertions ?? 0) + (byId('c1').diff?.deletions ?? 0)),
};

for (const [key, value] of Object.entries(values)) {
  process.stdout.write(`R_${key}=${JSON.stringify(String(value))}\n`);
}
NODE
# shellcheck disable=SC1091
. "$WORK/report.env"

check "winner is c1 (the minimal fix)" "c1"           "$R_WINNER"
check "c1 status"                      "winner"       "$R_C1_STATUS"
check "c2 status"                      "scored"       "$R_C2_STATUS"
check "c3 status"                      "no-changes"   "$R_C3_STATUS"
check "c4 status"                      "agent-failed" "$R_C4_STATUS"
check "c1 outscores c2"                "true"         "$R_C1_BEATS_C2"
check "c2 failed the no-todo gate"     "true"         "$R_C2_NO_TODO_FAILED"
check "judge scored c1"                "true"         "$R_C1_JUDGED"
check "c1 touched one file"            "1"            "$R_C1_FILES"
check "base sha recorded"              "$BASE_SHA"    "$R_BASE"

BRANCH="$R_BRANCH"
check "branch was promoted" "yes" "$([ -n "$BRANCH" ] && echo yes || echo no)"
check "sloppy churned more than fixer" "true" \
  "$([ "$R_C2_CHURN" -gt "$R_C1_CHURN" ] && echo true || echo false)"
check "branch exists in git" "yes" \
  "$(git rev-parse --verify --quiet "$BRANCH" > /dev/null && echo yes || echo no)"

echo
echo "isolation guarantees:"
check "still on main"            "main"    "$(git rev-parse --abbrev-ref HEAD)"
check "working tree unchanged"   "1"       "$(grep -c 'a - b' calc.sh)"
check "working tree clean"       ""        "$(git status --porcelain)"
check "artifacts excluded"       "yes"     "$(grep -q '^\.flashover/$' .git/info/exclude && echo yes || echo no)"

echo
echo "the winning branch actually fixes the bug:"
git worktree add -q --detach "$WORK/verify" "$BRANCH"
check "test passes on the winner" "0" "$(cd "$WORK/verify" && sh test.sh > /dev/null 2>&1; echo $?)"
git worktree remove --force "$WORK/verify"

# --------------------------------------------------------------- no winner

echo
echo "refuses to promote below minScore:"
BRANCHES_BEFORE="$(git branch --list | wc -l | tr -d ' ')"
set +e
node "$CLI" "make add 2 3 return 5" --no-live --min-score 99 --keep none > /dev/null 2>&1
STRICT_EXIT=$?
set -e
check "exit code 1 (no winner)" "1" "$STRICT_EXIT"
check "no extra branch created" "$BRANCHES_BEFORE" "$(git branch --list | wc -l | tr -d ' ')"

# -------------------------------------------------------------------- clean

echo
echo "clean:"
node "$CLI" clean > /dev/null 2>&1
check "artifacts removed"  "no"  "$([ -d .flashover ] && echo yes || echo no)"
check "only main worktree" "1"   "$(git worktree list | wc -l | tr -d ' ')"
check "promoted branch survives" "yes" \
  "$(git rev-parse --verify --quiet "$BRANCH" > /dev/null && echo yes || echo no)"

# ---------------------------------------------------------- promote modes

# `none` and `patch` both skip branch creation, so it would be easy for them to
# quietly collapse into the same behaviour. They must stay distinguishable:
# `patch` advertises an artifact, `none` advertises nothing.
#
# Runs last, and each run starts from an empty artifact directory, so the report
# under test is unambiguous rather than "whichever sorts last".
echo
echo "promote modes:"
BRANCHES_BEFORE="$(git branch --list | wc -l | tr -d ' ')"

rm -rf "$REPO/.flashover"
node "$CLI" "make add 2 3 return 5" --no-live --promote patch --keep none > /dev/null 2>&1
PATCH_REPORT="$(latest_report)"
check "promote patch: one report"        "1"    "$(find "$REPO/.flashover" -name report.json | wc -l | tr -d ' ')"
check "promote patch: no branch"         "null" "$(report_field "$PATCH_REPORT" promotedBranch)"
check "promote patch: patch advertised"  "yes" \
  "$([ "$(report_field "$PATCH_REPORT" promotedPatch)" != "null" ] && echo yes || echo no)"
check "promote patch: creates no branch" "$BRANCHES_BEFORE" "$(git branch --list | wc -l | tr -d ' ')"

rm -rf "$REPO/.flashover"
node "$CLI" "make add 2 3 return 5" --no-live --promote none --keep none > /dev/null 2>&1
NONE_REPORT="$(latest_report)"
check "promote none: no branch"            "null" "$(report_field "$NONE_REPORT" promotedBranch)"
check "promote none: nothing advertised"   "null" "$(report_field "$NONE_REPORT" promotedPatch)"
check "promote none: still names a winner" "c1"   "$(report_field "$NONE_REPORT" winnerId)"
check "promote none: creates no branch" "$BRANCHES_BEFORE" "$(git branch --list | wc -l | tr -d ' ')"

# ------------------------------------------------------------------- verdict

echo
if [ "$fail" -eq 0 ]; then
  echo "e2e: $pass checks passed"
  exit 0
fi
echo "e2e: $fail of $((pass + fail)) checks FAILED" >&2
exit 1

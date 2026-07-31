# Security

## Reporting a vulnerability

Report privately through [GitHub's advisory form](https://github.com/idugeni/flashover/security/advisories/new). Please do not open a public issue for anything exploitable.

Include what an attacker can achieve, and the smallest configuration that demonstrates it. Expect an initial reply within a week.

## What flashover assumes about trust

Some of what follows might read like vulnerabilities. They are deliberate, documented properties of the design, so knowing them is the difference between using this tool safely and being surprised by it.

**Gates and judges are arbitrary shell commands with your permissions.** They run through `sh -c`, unsandboxed, exactly like a `package.json` script. A `flashover.yaml` is therefore as dangerous as a `Makefile`: do not run one you have not read. This is not incidental — the entire premise is that verification is whatever command you already trust to tell you your code works.

**Agent presets deliberately disable confirmation prompts.** Every preset passes the flag that stops the agent asking permission — `--permission-mode acceptEdits`, `--yolo`, `--force`, `--yes-always`. A tournament cannot be interactive, so this is required for the tool to function at all. The consequence is real: running flashover means running N agents that will edit files without asking.

**Agents are confined to a worktree, not sandboxed.** Each candidate gets its own `git worktree` under `.flashover/`, which is what stops agents clobbering each other and what keeps your working tree untouched. It is not a security boundary. An agent can reach the rest of the filesystem, and `seed.link` deliberately points into your real repository.

**Transcripts can contain secrets.** Agent output is captured verbatim to `.flashover/*/logs/`, and agents read your source, your environment, and sometimes your credentials. Those logs are excluded from git via `.git/info/exclude`, not `.gitignore`, so a fresh clone does not carry the exclusion. Scrub before attaching them to an issue.

**Gates receive your environment.** Beyond the `FLASHOVER_*` variables and `CI=1`, gate and judge processes inherit the environment flashover was started with, including API keys.

## Supported versions

Until 1.0, only the latest release receives fixes.

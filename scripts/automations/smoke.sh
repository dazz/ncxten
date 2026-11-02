#!/usr/bin/env bash
# smoke — proof-of-life automation: append one line, commit, run the gate,
# report usage. Also the documented example of a claude-based run: worktree,
# branch, explicit permission rules, result file (ncxten-spec, 002
# contracts/run.md). The factory starts this script as a marked process
# group with cwd = the checkout; exit 0 means succeeded.
set -euo pipefail

# ── where: one worktree per run (the project's choice, not the factory's) ──
branch="ncxten/smoke"                         # deterministic: same automation, same branch
ws="${TMPDIR:-/tmp}/smoke-${NCXTEN_SESSION}"  # session id is unique; outside the checkout
git() { command git -c core.hooksPath=/var/empty -c core.fsmonitor=false "$@"; }
git worktree prune                            # tolerate a killed predecessor (run contract)
git worktree add -B "$branch" "$ws"
trap 'git worktree remove --force "$ws" 2>/dev/null; git worktree prune' EXIT
cd "$ws"

# ── conventions: the session's commit identity (container has no gitconfig) ──
export GIT_AUTHOR_NAME="ncxten"  GIT_AUTHOR_EMAIL="bot@ncxten.local"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

# ── how: claude -p with the repo skill and explicit rules ──
out="$(claude -p "/smoke ${NCXTEN_SUBJECT}" \
  --output-format json \
  --model claude-haiku-5-5 \
  --max-turns "${NCXTEN_TURNS:-10}" \
  --session-id "${NCXTEN_SESSION}" \
  --strict-mcp-config \
  --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Skill" \
    "Bash(git status:*)" "Bash(git add:*)" "Bash(git commit:*)" \
    "Bash(git diff:*)" "Bash(git log:*)" "Bash(git rm:*)" "Bash(git mv:*)" \
    "Bash(make ci)" \
  | tail -n 1)"

# ── report: map claude's result JSON into the factory's result file ──
printf '%s' "$out" | jq '{
  model:   (.modelUsage | keys[0]?),
  costUsd: .total_cost_usd,
  turns:   .num_turns,
  tokens:  { input: .usage.input_tokens, output: .usage.output_tokens,
             cacheRead: .usage.cache_read_input_tokens,
             cacheCreated: .usage.cache_creation_input_tokens },
  detail:  (.result // .subtype)
}' > "$NCXTEN_RESULT"

# ── verified means: succeed only when claude succeeded ──
[ "$(printf '%s' "$out" | jq -r '.is_error')" = "false" ]

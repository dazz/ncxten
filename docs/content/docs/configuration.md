---
title: Configuration
weight: 3
---

One policy file per project: `<config-dir>/<owner>/<repo>.yaml`. The policy is
the owner's side of the contract — it **allows**; the repository's
`automations.yml` proposes. It is read at start and on resume, never mid-tick.

The schema is **strict**: an unknown key makes the whole file invalid, and the
project starts (or keeps running) **paused**, with the failing path in
`ncxten status`. A typo must not silently remove a limit.

```yaml {filename="<config-dir>/dazz/foo.yaml"}
repo:
  repository: dazz/foo                 # required — the project ID
  forge: github                        # default github
  tracker: github-issues               # default github-issues
  paths:
    checkout: /absolute/path/to/foo    # required — a local git checkout

policy:
  tick: PT15M                          # default PT15M; bounds PT1M–PT24H
  harness: claude                      # claude | codex | pi | fake
  models:
    cheap: claude-sonnet
    default: claude-sonnet
    strong: claude-sonnet
  session-model: per-step
  workspace: worktree                  # worktree | clone | container
  gate-source: local                   # local | container | forge-pipeline
  limits:
    turns: 50                          # required, per session
    time: PT20M                        # required, per session
    tokens: 1000000                    # optional
    same-error-class: 3                # default 3
    sessions-per-day: 20               # optional
    rounds-per-pr: 5                   # optional
  merge-policy: approved-is-approved   # approved-is-approved | path-lax | patch-id | strict
  sensitive-paths: ["automations.yml"] # default
  trusted-authors: []
  # credentials: dazz/foo              # optional reference, never a secret value — omit, or set a string; null fails the strict schema
```

{{< callout type="info" >}}
Every field is declared and validated from the first release on, so a complete
policy passes unchanged — but today ncxten only *acts* on `repository`,
`forge`, `paths.checkout`, `tick` and `limits.turns`/`limits.time`. The rest
takes effect as the features behind it ship.
{{< /callout >}}

## The two roots

| root | default | flag | environment |
|---|---|---|---|
| config | `~/.config/ncxten` | `--config-dir` | `NCXTEN_CONFIG_DIR` |
| state | `~/.local/state/ncxten` | `--state-dir` | `NCXTEN_STATE_DIR` |

Flag beats environment beats the XDG default. No other path is configurable:
everything below the roots derives from the project ID, so a typo can never
split a project across two locks or two logs.

## Invalid policy ≠ dead project

An unreadable or invalid policy **pauses** the project instead of stopping it:
the process keeps running, skips its ticks, and `ncxten status` names the
reason. Fix the file, then `ncxten resume <project>` — the policy is re-read
and re-validated only then.

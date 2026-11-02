---
title: Automations
weight: 4
---

`automations.yml` at the root of your repository declares what the repo
proposes to automate. The factory reads it from the **head of the default
branch** every tick — changes take effect when they merge, not when a working
tree changes.

```yaml {filename="automations.yml"}
automations:
  - name: pull-request-reactor   # kebab-case, unique
    skill: react                 # which skill the session runs
  - name: board-walker
    skill: implement
    gate: make ci                # optional — declared now, gates run in a later slice
```

**List order is priority.** Each tick drains pass by pass: every pass asks the
tracker for findings per automation, takes the **first** automation with new
input, runs exactly one session, then starts the next pass — until a pass
finds nothing. Reacting to reviews beats starting new work because it is
listed first.

**An input is consumed when a session starts**, whatever the outcome. A failed
session does not retry on the same input revision — only new input (a new
revision of the subject) starts a new session. No retry loops.

## When the file is invalid

The schema is strict, like the policy's. But an invalid `automations.yml`
never stops the factory:

- **It was valid before** — the last valid version stays in effect, every tick
  records the problem (`automations/invalid`, with the commit that broke it
  and the commit that is kept), and the project keeps working.
- **It was never valid** — the project idles and records the problem per tick
  (`automations/never-valid`).
- Either way, the **next valid commit heals** it: the new version loads, the
  recorded error clears.

Nothing to do on your side except fix and merge.

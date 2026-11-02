---
title: Glossary
weight: 7
---

One word per meaning, one meaning per word. These are the words the docs use;
the docs never rotate synonyms.

| term | meaning |
|---|---|
| **factory** | the whole system: one durable runner that builds repositories by executing policies, tick by tick |
| **project** | one repository under the factory's care — and the one long-running process that cares for it (`ncxten start <owner>/<repo>`) |
| **policy** | your side of the contract: one YAML file per project under the config root. It allows — tick interval, limits, harness. See [Policy](../policy) |
| **automation** | one entry in the repository's `automations.yml` — the repo's side: what it proposes to automate. See [Automations](../automations) |
| **tick** | the schedule beat. Each tick checks for new input and drains: pass by pass, until a pass finds nothing |
| **pass** | one round within a tick: ask for findings, take the first automation with new input, run exactly one session |
| **session** | one agent run for one input: own worktree, own limits, outcome and cost recorded as events |
| **harness** | the agent CLI a session runs through — Claude Code first. The **fake harness** is a shipped stand-in with the same contract: deterministic, zero network, zero cost |
| **event log** | one JSONL file per project, append-only, **schema v1** — written before the factory acts, replayed at start. The source of truth. See [Event log](../events) |
| **config root / state root** | the two directories everything lives under (`~/.config/ncxten`, `~/.local/state/ncxten`); every path below them derives from the project ID |
| **checkout** | the local git clone of your repository that the factory reads `automations.yml` from and branches worktrees off |
| **worktree** | a git feature: one extra working directory sharing the clone's `.git`. The factory gives every session its own, and removes it after |
| **s6 / s6-overlay** | [s6](https://skarnet.org/software/s6/) is a small Unix process supervisor: it starts services, restarts them when they die, delivers signals. [s6-overlay](https://github.com/just-containers/s6-overlay) packages it as PID 1 for containers. Inside the factory container, s6 supervises one `ncxten` process per project |
| **Vector** | [Vector](https://vector.dev) ships logs: a separate container reads the events directory read-only and forwards every event to Better Stack |
| **Better Stack** | the hosted observability service the bundled setup ships events to: log search, an alert on `level: error`, and an uptime check fed by the factory's heartbeat |
| **managed settings** | Claude Code's highest-priority settings file. The factory bakes it into the image as the permission ceiling no session can change |

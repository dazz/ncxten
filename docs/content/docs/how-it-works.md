---
title: How it works
weight: 2
---

Six views of the same machine: where it runs, what runs inside, what one tick
does, who owns which file, what a session may do, and how a session ends.
Solid parts match the shipped code; dashed parts are **planned** and labeled
so. Unfamiliar words are in the [glossary](../glossary).

## Deployment

```mermaid
flowchart TB
  subgraph host["Host VM (rootless Docker)"]
    subgraph fc["factory container"]
      ncx["ncxten process<br/>deterministic, no model"]
      agent["claude -p (agent)<br/>only during a session"]
      ncx -.-> agent
    end
    vector["Vector container<br/>reads events"]
    subgraph vols["volumes (host paths)"]
      pol["policy"]
      wt["worktrees<br/>one per session"]
      login["Claude Code<br/>login"]
      ev["event log<br/>JSONL"]
    end
  end
  bs["Better Stack<br/>logs, alert"]
  anthropic["Anthropic<br/>the model"]
  ncx --> pol
  ncx --> ev
  agent -.-> wt
  agent -.-> login
  agent -.-> anthropic
  vector --> ev
  vector --> bs
  classDef planned stroke-dasharray: 5 5
  class agent,wt,login,anthropic planned
```

The `ncxten` process reads the policy and writes the event log; the agent
works only inside its worktree; Vector reads the events read-only and ships
them to Better Stack. The permission ceiling (managed settings) is baked into
the image, not on a volume — no session can edit it. Planned and not drawn:
GitHub as the source of work, and gate containers beside the factory
container.

## The process tree

```mermaid
flowchart TB
  s6["s6 supervisor (PID 1)"]
  p1["ncxten start dazz/foo<br/>one process per project"]
  grp["process group — one endable unit"]
  claude["claude -p"]
  tools["its tools: sh, git, make ci"]
  s6 --> p1
  p1 -.->|"planned — only during a session"| grp
  grp -.-> claude
  claude -.-> tools
  classDef planned stroke-dasharray: 5 5
  class grp,claude,tools planned
```

The `ncxten` process is deterministic and has no model: it schedules, decides
and records. The agent exists only while a session runs, as leader of its own
process group, so the time limit can end the agent *and* everything it
spawned. The model itself computes at Anthropic — nothing in the container
holds weights.

## One tick

```mermaid
sequenceDiagram
  participant T as timer
  participant N as ncxten process
  participant L as event log
  participant A as claude -p
  T->>N: tick due
  N->>N: read automations.yml, check for new input
  alt new input found
    N->>L: session started
    rect rgba(128,128,128,0.12)
      Note over N,A: planned — today a fake harness stands in
      N->>N: create worktree
      N->>A: launch: skill, input, model, limits
      A-->>N: result: outcome + usage
      N->>L: session succeeded / failed / limit
      N->>N: remove worktree
      N->>L: workspace removed
    end
    N->>N: next pass
  else pass is empty
    N->>L: tick idle
  end
```

Every event is appended and fsynced **before** the action it announces: the
log can claim more than happened, never less. The drain runs pass by pass —
one session per pass, first automation with new input wins — until a pass
finds nothing.

## Files and ownership

| file | where | written by | read by |
|---|---|---|---|
| policy | `<config-dir>/<owner>/<repo>.yaml` | you | `ncxten` at start and resume |
| `automations.yml` | default branch of the repository | you (via merge) | `ncxten`, every tick |
| event log | `<state-root>/events/<owner>/<repo>.jsonl` | `ncxten` only | `ncxten` (replay), Vector, you |
| pidfile + lock | `<state-root>/projects/<owner>/<repo>/ncxten.pid` | `ncxten` | the kernel (flock) |
| worktrees *(planned)* | under the project's state directory | the session | nobody else — removed after the session |
| session branches *(planned)* | the checkout's `.git` | the session (commits) | you; later also GitHub |
| Claude Code login *(planned)* | a volume, `CLAUDE_CONFIG_DIR` | Claude Code | Claude Code |
| managed settings *(planned)* | `/etc/claude-code/managed-settings.json`, in the image | the image build | Claude Code, every session |

One writer per file is the rule everywhere: the event log has exactly one
writer (the lock holder), the policy is yours alone, and the managed settings
can only change with an image rebuild.

## What a session may do *(planned)*

```mermaid
flowchart TB
  ms["managed settings — in the image<br/>hooks off, config dir denied<br/><b>the ceiling</b>"]
  at["--allowedTools — per launch<br/>the adapter's explicit rules"]
  repo["repo .claude/settings.json<br/>loaded, but cannot widen"]
  ms --> at --> repo
  classDef planned stroke-dasharray: 5 5
  class ms,at,repo planned
```

Three layers, outermost wins: the image's managed settings disable all hooks
and deny the config dir; the adapter passes the explicit allow rules for this
launch; whatever the repository's own settings add on top has no effect — a
blanket permission bypass does not exist, Claude Code refuses it as root. The
allow list guards against accidents; it is **not a security boundary**: an
allowed gate such as `make ci` runs whatever the worktree's Makefile says,
and the session can edit that Makefile — the managed deny covers the file
tools, not commands the gate starts. The boundary in v1 is the container and
its VM, which hold only expendable access: the session runs as root in the
container, reads what the factory reads, and reaches the network through the
harness. Isolation beyond the worktree comes later; the docs will not
pretend otherwise.

## A session's life *(planned)*

```mermaid
stateDiagram-v2
  [*] --> started: event written first
  started --> running: worktree + launch
  running --> succeeded
  running --> failed: incl. "could not start"
  running --> limit: turns or time
  running --> aborted: factory crashed, closed at next start
  succeeded --> removed: worktree removed
  failed --> removed
  limit --> removed
  aborted --> removed: at next start, group ended first
  removed --> [*]: commits survive on the session branch
```

Every exit path ends at the same place: the worktree is removed, forced if
dirty, and the removal is an event. What survives is on the session branch in
the checkout — and in the log: outcome, usage, cost. Today the lifecycle runs
with the fake harness and without worktrees; `limit` arrives with the real
one.

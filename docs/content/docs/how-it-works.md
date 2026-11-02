---
title: How it works
weight: 2
---

Six views of the same machine: where it runs, what runs inside, what one tick
does, who owns which file, what a session may do, and how a session ends.
Dashed parts are not shipped yet — each carries a *from 002* or *from 003*
label. Everything solid matches the code on `main`.

## Deployment

```mermaid
flowchart TB
  subgraph host["Host VM (rootless Docker)"]
    subgraph fc["factory container"]
      ncx["ncxten process<br/>deterministic, no model"]
      agent["claude -p (agent)<br/>only during a session"]
      ncx -.->|"starts, from 002"| agent
    end
    vector["Vector container"]
    subgraph vols["volumes (host paths)"]
      pol["policy<br/><code>~/.config/ncxten</code>"]
      state["event log + lock + state<br/><code>~/.local/state/ncxten</code>"]
      wt["worktrees<br/>one per session"]
      login["Claude config dir<br/>login"]
    end
    co["checkout<br/>a local git clone"]
  end
  bs["Better Stack<br/>logs, alert, uptime"]
  anthropic["Anthropic<br/>the model"]
  gh["GitHub<br/>issues, PRs"]
  ncx -->|reads| pol
  ncx -->|writes| state
  ncx -.->|"adds/removes, from 002"| wt
  ncx -->|"reads automations.yml"| co
  agent -.->|"works in, from 002"| wt
  agent -.->|"from 002"| login
  agent -.->|"API calls, from 002"| anthropic
  vector -->|"reads events, read-only"| state
  vector --> bs
  ncx -.->|"from 003"| gh
  classDef future stroke-dasharray: 5 5
  class agent,wt,login,anthropic,gh future
```

The factory container and Vector share nothing but the events directory, and
Vector mounts it read-only. The permission ceiling (managed settings) is baked
into the image, not on a volume — no session can edit it. From 003, gate/CI
containers start beside the factory container; they are not drawn yet.

## The process tree

```mermaid
flowchart TB
  s6["s6 supervisor (PID 1)"]
  p1["ncxten start dazz/foo<br/>one process per project"]
  grp["process group — one endable unit"]
  claude["claude -p"]
  tools["its tools: sh, git, make ci"]
  s6 --> p1
  p1 -.->|"only during a session, from 002"| grp
  grp -.-> claude
  claude -.-> tools
  classDef future stroke-dasharray: 5 5
  class grp,claude,tools future
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
  participant C as checkout
  participant L as event log
  participant W as worktree
  participant A as claude -p
  T->>N: tick due
  N->>C: read automations.yml (default branch head)
  N->>N: precheck: findings vs consumed inputs
  alt new input found
    N->>L: session started (consumes the input)
    rect rgba(128,128,128,0.12)
      Note over N,A: from 002 — today a fake harness stands in
      N->>W: git worktree add (session branch)
      N->>A: launch: skill, input, model, limits
      A-->>N: result: outcome + usage
      N->>L: session succeeded / failed / limit
      N->>W: remove — forced, commits survive on the branch
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
| worktrees *(from 002)* | under the project's state directory | the session | nobody else — removed after the session |
| session branches *(from 002)* | the checkout's `.git` | the session (commits) | you; from 003 the forge |
| Claude config dir *(from 002)* | a volume, `CLAUDE_CONFIG_DIR` | Claude Code (login, state) | Claude Code |
| managed settings *(from 002)* | `/etc/claude-code/managed-settings.json`, in the image | the image build | Claude Code, every session |

One writer per file is the rule everywhere: the event log has exactly one
writer (the lock holder), the policy is yours alone, and the managed settings
can only change with an image rebuild.

## What a session may do *(from 002)*

```mermaid
flowchart TB
  ms["managed settings — in the image<br/>hooks off, config dir denied<br/><b>the ceiling</b>"]
  at["--allowedTools — per launch<br/>the adapter's explicit rules"]
  repo["repo .claude/settings.json<br/>loaded, but cannot widen"]
  ms --> at --> repo
  classDef future stroke-dasharray: 5 5
  class ms,at,repo future
```

Three layers, outermost wins: the image's managed settings disable all hooks
and deny the config dir; the adapter passes the explicit allow rules for this
launch; whatever the repository's own settings add on top has no effect — a
blanket permission bypass does not exist, Claude Code refuses it as root. What
a session *can* still do in v1: it runs as root in the container, reads what
the factory reads, and reaches the network through the harness. Isolation
beyond the worktree is a later slice; the docs will not pretend otherwise.

## A session's life *(from 002)*

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
the checkout — and in the log: outcome, usage, cost. Today (001) the
lifecycle runs with the fake harness and without worktrees; `limit` arrives
with 002.

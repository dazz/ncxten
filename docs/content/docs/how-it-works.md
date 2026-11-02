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
      run["the automation's run command<br/>(for example claude -p)<br/>only during a session"]
      ncx -.-> run
    end
    vector["Vector container<br/>reads events"]
    subgraph vols["volumes (host paths)"]
      pol["policy"]
      co["repo checkout"]
      login["Claude Code<br/>login"]
      ev["event log<br/>JSONL"]
    end
  end
  bs["Better Stack<br/>logs, alert"]
  anthropic["Anthropic<br/>the model"]
  ncx --> pol
  ncx --> co
  ncx --> ev
  run -.-> co
  run -.-> login
  run -.-> anthropic
  vector --> ev
  vector --> bs
  classDef planned stroke-dasharray: 5 5
  class run,login,anthropic planned
```

The `ncxten` process reads the policy, reads `automations.yml` from the
checkout and writes the event log. A session is the automation's own run
command, started in the checkout; what the command does there — project
zero's command makes a worktree and calls `claude -p` — is the repository's
own script, not the factory's business. Vector reads the events read-only
and ships them to Better Stack. The permission ceiling for agent runs
(managed settings) is baked into the image, not on a volume — no session can
edit it. Planned and not drawn: GitHub as the source of work.

## The process tree

```mermaid
flowchart TB
  s6["s6 supervisor (PID 1)"]
  p1["ncxten start dazz/foo<br/>one process per project"]
  grp["process group — one endable unit"]
  cmd["the run command (shell)"]
  tools["what it starts: claude -p, git, make ci"]
  s6 --> p1
  p1 -.->|"planned — only during a session"| grp
  grp -.-> cmd
  cmd -.-> tools
  classDef planned stroke-dasharray: 5 5
  class grp,cmd,tools planned
```

The `ncxten` process is deterministic and has no model: it schedules, decides
and records. The session exists only while its run command runs, as leader of
its own process group, so the time limit can end the command *and* everything
it started. The model itself computes at Anthropic — nothing in the container
holds weights.

## One tick

```mermaid
sequenceDiagram
  participant T as timer
  participant N as ncxten process
  participant L as event log
  participant A as run command
  T->>N: tick due
  N->>N: read automations.yml, check for new input
  alt new input found
    N->>L: session started
    rect rgba(128,128,128,0.12)
      Note over N,A: planned — today a fake stands in
      N->>A: start in the checkout — input and limits as environment
      A-->>N: exit code + optional result file (usage)
      N->>L: session succeeded / failed / limit
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
| session output *(planned)* | `<state-root>/projects/<owner>/<repo>/sessions/<id>.out` | `ncxten` (live copy of the command's output) | you — kill cases included |
| result file *(planned)* | a path handed to the run command | the run command (optional: usage, cost) | `ncxten`, into the event |
| Claude Code login *(planned)* | a volume, `CLAUDE_CONFIG_DIR` | Claude Code | Claude Code |
| managed settings *(planned)* | `/etc/claude-code/managed-settings.json`, in the image | the image build | Claude Code, every run |

One writer per file is the rule everywhere: the event log has exactly one
writer (the lock holder), the policy is yours alone, and the managed settings
can only change with an image rebuild.

## What a session may do *(planned)*

```mermaid
flowchart TB
  box["container and VM — <b>the boundary</b><br/>holds only expendable access"]
  ms["managed settings — in the image<br/>hooks off, config dir denied<br/>the ceiling for every claude run"]
  sc["the run script's own rules<br/>for example --allowedTools per claude call"]
  box --> ms --> sc
  classDef planned stroke-dasharray: 5 5
  class box,ms,sc planned
```

The factory sets no rules for the run command itself — a command is a
command. What bounds a session, outermost first: the **container and its
VM**, which hold only expendable access — that is the v1 security boundary;
the image's **managed settings**, which every `claude` call in the container
loads and no flag can exclude (hooks off, config directory denied) — a
blanket permission bypass does not exist, Claude Code refuses it as root;
and the **run script's own rules**, such as an explicit allow list per
`claude` call. An allow list guards against accidents; it is **not a
security boundary**: an allowed gate such as `make ci` runs whatever the
Makefile says, and the session can edit that Makefile. What the factory
does enforce, for every command alike: the time limit ends the whole
process group, and the per-drain and per-day caps bound how often anything
runs. Isolation beyond the container comes later; the docs will not pretend
otherwise.

## A session's life *(planned)*

```mermaid
stateDiagram-v2
  [*] --> started: event written first
  started --> running: the run command starts, marked
  running --> succeeded: exit 0
  running --> failed: non-zero exit, or could not start
  running --> limit: time limit — the whole group ends
  running --> aborted: factory crashed, closed at next start
  succeeded --> [*]
  failed --> [*]
  limit --> [*]
  aborted --> [*]: marked processes ended first
```

Every process a session starts carries the session's mark, so ending it —
at the time limit, or after a factory crash at the next start — is complete
only when nothing marked remains. What survives a session is whatever its
command committed to the repository, the full output on disk, and the log:
outcome, usage, cost. Today the lifecycle runs with a fake stand-in;
`limit` arrives with the real one.

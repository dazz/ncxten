---
title: CLI
weight: 5
---

`ncxten <command> <project>` — the project ID is always `owner/repo`, the same
string you see in every event line. All commands take `--config-dir` and
`--state-dir` (see [Configuration](../configuration)).

{{< callout type="warning" >}}
`tick` and `resume` nudge a running process with a signal, so run them **in
the same PID namespace** as the factory — in a container setup that means
`docker exec`, not the host shell.
{{< /callout >}}

## `ncxten start <project>`

Runs the project process in the foreground (what s6 or systemd want). Start
sequence, every time: acquire the instance lock → replay the event log → abort
any orphaned session from a crash → read the policy → schedule ticks. `SIGTERM`
shuts down cleanly. Exactly **one process per project**: a second start while
the lock is held refuses with exit 75.

An invalid policy does not stop the start — the project runs **paused** until
you fix the file and resume.

## `ncxten tick <project>`

Tick now instead of waiting for the schedule.

- Project **running** → sends `SIGUSR1` to it; the outcome lands in the event
  log. A nudge during a running session is skipped, never queued.
- Project **stopped** → a one-shot process generation: full start sequence,
  one tick, exit.

## `ncxten resume <project>`

Lifts a pause after you fixed the cause. The policy is re-read and
re-validated; the result is printed (`resumed`, `still paused: <reason>`, or
`not paused`). A pause **survives restarts** — only an explicit resume lifts it.

## `ncxten status <project>`

Read-only — replays the log, probes the lock, never signals:

```
project:       dazz/foo
state:         paused — policy.limits.turns: expected number, got string
process:       not running (open session will be aborted at next start)
last tick:     2026-10-31T12:00:00Z (skipped — paused)
last session:  board-walker → failed (2026-10-31T09:15:02Z)
last error:    policy.limits.turns: expected number, got string
```

A crashed process never shows as `running`: the dead session is reported and
aborted at the next start.

## Exit codes

| code | meaning |
|---|---|
| 0 | success — including "status printed" and "nudge sent" |
| 1 | unexpected error |
| 2 | usage error |
| 69 | project unknown: no policy file **and** no event log — refuses instead of creating ghost state for a typo'd ID |
| 74 | event log unwritable: an append or fsync failed — the factory never acts without a record; the supervisor restarts it and the replay catches up |
| 75 | already running: the lock is held |

## Signals

| signal | effect |
|---|---|
| `SIGTERM` / `SIGINT` | clean shutdown |
| `SIGUSR1` | tick now (what `ncxten tick` sends) |
| `SIGHUP` | resume (what `ncxten resume` sends) |

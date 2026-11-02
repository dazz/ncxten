---
title: Event log
weight: 6
---

One JSONL file per project: `<state-root>/events/<owner>/<repo>.jsonl`. Every
line is one event, appended and fsynced **before** the factory acts on it — if
the log cannot be written, the factory stops (exit 74) rather than act
unrecorded.

```json
{"schema":1,"time":"2026-11-01T11:53:05.415Z","kind":"tick","repository":"dazz/foo","forge":"github.com","outcome":"idle","level":"info"}
```

Every line carries `schema`, `time`, `kind`, `outcome`, `repository` and
`level`; fields without a value are omitted. The identity of an event is
`kind` + `outcome` — some combinations you will see:

| kind / outcome | meaning | level |
|---|---|---|
| `project` / `started` | a process generation began | info |
| `policy` / `loaded` | the policy is in effect (carries `tick`, `limits`) | info |
| `project` / `paused` | policy unreadable or invalid — reason in `detail` | error |
| `automations` / `loaded` | `automations.yml` valid at `commit` | info |
| `automations` / `invalid` | invalid at `commit`; `keptCommit` stays in effect | error |
| `session` / `started` → `succeeded` \| `failed` \| `aborted` | one agent session | info / warn |
| `tick` / `idle` | a tick drained and found nothing more | info |
| `tick` / `skipped` | tick during pause or running session (`detail`) | info |
| `project` / `resumed` | pause lifted | info |
| `resume` / `failed` \| `ignored` | resume did not lift the pause (`detail`) | error / info |
| `project` / `heartbeat` | liveness only, every 5 minutes — changes nothing | info |

## The contract

The log is **append-only, schema v1**: fields are never renamed or removed,
and a changed meaning is a new `kind`/`outcome` combination. Readers skip
combinations they do not know — an old binary replays a newer log without
breaking, and your own tooling can rely on existing lines staying as they are.

The log is also the **source of truth**: everything else under the state root
is a reconstructible cache. A restarted process replays the log and continues
where it was — pauses survive, consumed inputs stay consumed, a session that
died with a crash is reported and aborted.

## Shipping the events

The `events/` directory is the integration point for observability — the
bundled compose file mounts it read-only into a [Vector](https://vector.dev)
container that ships every event to Better Stack and drives an Uptime
heartbeat per repository. Point your own tooling at the same files: tail them,
ship them, grep them.

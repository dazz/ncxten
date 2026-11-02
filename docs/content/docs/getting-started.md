---
title: Getting started
weight: 1
---

The factory runs as a container image with an [s6](../glossary) supervisor
inside; the CLI is a single binary. The image is not on a registry yet:
`docker compose up` builds it from the repository's
[`docker/ncxten/Dockerfile`](https://github.com/dazz/ncxten/blob/main/docker/ncxten/Dockerfile).
Everything lives under two roots on your machine, mounted into the container
at the same paths:

```
~/.config/ncxten/<owner>/<repo>.yaml      # policies — one file per project
~/.local/state/ncxten/                    # state root
├── events/<owner>/<repo>.jsonl            # the event log (schema v1)
└── projects/<owner>/<repo>/ncxten.pid    # pidfile — the instance lock lives on it
```

## 1. Write a policy

```yaml {filename="~/.config/ncxten/dazz/foo.yaml"}
repo:
  repository: dazz/foo
  paths:
    checkout: /home/you/checkouts/foo   # a local git checkout on its default branch
policy:
  tick: PT15M          # ISO 8601 duration, PT1M–PT24H
  limits:
    turns: 50
    time: PT20M
```

See [The policy](../policy) for every field.

## 2. Declare automations in the repo

```yaml {filename="automations.yml"}
automations:
  - name: pull-request-reactor
    skill: react
  - name: board-walker
    skill: implement
    gate: make ci
```

Committed to the default branch — the factory reads it at the branch head
every tick. See [Automations](../automations).

## 3. Start it

```sh
cd infra/compose
docker compose up -d
docker compose logs -f ncxten
```

The service starts `ncxten start <project>` under s6. Check on it from the
same PID namespace (signals must reach the right process):

```sh
docker exec ncxten-infra-ncxten-1 ncxten status dazz/foo
docker exec ncxten-infra-ncxten-1 ncxten tick dazz/foo     # tick now, don't wait
```

## 4. Watch the event log

```sh
tail -f ~/.local/state/ncxten/events/dazz/foo.jsonl
```

Every line is one event: `{"schema":1,"time":…,"kind":"tick","outcome":"idle",…}`.
The log is the source of truth — delete everything else and the factory
rebuilds its state from it.

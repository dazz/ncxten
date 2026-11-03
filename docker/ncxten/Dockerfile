# The factory container (STACK Deployment, from 001). Build context: the repo root.
# Build stage: Bun exists only here — the runtime gets a single binary (bun build --compile).
FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY ncxten/package.json ncxten/bun.lock ncxten/.npmrc ./
RUN bun install --frozen-lockfile
COPY ncxten/ ./
RUN bun build --compile src/main.ts --outfile /ncxten-bin

# Runtime: Debian slim, not Alpine — Claude Code under musl needs extra libraries (STACK).
# Image contents since 002: the factory binary, git, the claude CLI (FR-095) with its
# managed settings, bun + make (project zero's gate `make ci`, FR-096) and jq (the example
# run script maps claude's result JSON with it; doubles as the event log's debugging tool).
# The Docker client joins with 003.
FROM debian:bookworm-slim
ARG S6_OVERLAY_VERSION=3.2.0.2
ARG CLAUDE_CODE_VERSION=2.1.316
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates xz-utils curl make jq \
  && rm -rf /var/lib/apt/lists/*
# Claude Code via the native installer (STACK Harness), pinned; the install lands under
# $HOME of the build (= /root), the symlink keeps it on PATH for any runtime HOME.
# Autoupdate stays off: the image pins the version (compose sets DISABLE_AUTOUPDATER=1).
RUN curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION} \
  && ln -s /root/.local/bin/claude /usr/local/bin/claude \
  && claude --version
# The managed settings are the ceiling for every claude run in the container — loaded from
# /etc/claude-code on every invocation, excludable by no flag (verified, spike 2026-11-02):
# hooks off, the factory-owned config home denied to agent tools. Baked into the image,
# not on a volume: no session can edit it; changing it means a rebuild (FR-065).
COPY docker/ncxten/managed-settings.json /etc/claude-code/managed-settings.json
# Bun for project zero's toolchain (FR-096) — same pinned version as the build stage.
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
# Checksums pin the release artifacts (verified against the published .sha256 files);
# bumping S6_OVERLAY_VERSION means updating both.
ADD --checksum=sha256:6dbcde158a3e78b9bb141d7bcb5ccb421e563523babbe2c64470e76f4fd02dae \
  https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/
ADD --checksum=sha256:59289456ab1761e277bd456a95e737c06b03ede99158beb24f12b165a904f478 \
  https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp/
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz \
  && tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz \
  && rm /tmp/s6-overlay-*.tar.xz

COPY --from=build /ncxten-bin /usr/local/bin/ncxten
# One s6 service per project; service names are the flattened project ID (s6 allows no slash).
COPY docker/ncxten/s6-rc.d/ /etc/s6-overlay/s6-rc.d/

# Deliberately no USER: this box runs rootless Docker, where root in the container IS the
# host user — files on the volumes then belong to the host user. A dedicated USER would
# write them under a foreign UID. A rootful daemon needs `user:` in compose instead
# (infra/README.md).
ENTRYPOINT ["/init"]

# Paperclip with this plugin baked in at /opt/paperclip-plugins/paperclip-linear,
# and the SSH sandbox provider at /opt/paperclip-plugins/sandbox-ssh.
# Pinned to the Paperclip release the plugin is tested against; upgrade the
# base image, the SDK pin in package.json, and PAPERCLIP_VERSION together.

# The build stage runs on the build machine's own architecture: its output is
# plain JavaScript, so the final multi-arch image needs no emulation.
FROM --platform=$BUILDPLATFORM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack prepare --activate && pnpm install --frozen-lockfile
COPY esbuild.config.mjs tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM ghcr.io/paperclipai/paperclip:2026.1117.0@sha256:bdf38d10544dc6c831e16dc027f23ad586353ef3be1a1b2c6979e63b956aceb1
LABEL org.opencontainers.image.source="https://github.com/ryanjdillon/paperclip-linear" \
      org.opencontainers.image.description="Paperclip 2026.1117.0 with the paperclip-linear and sandbox-ssh plugins" \
      org.opencontainers.image.licenses="MIT"
# The worker bundle is self-contained, so the plugin needs only its manifest
# package and dist/. Root-owned and read-only to the runtime user.
COPY package.json /opt/paperclip-plugins/paperclip-linear/package.json
COPY --from=build /src/dist /opt/paperclip-plugins/paperclip-linear/dist
# The SSH sandbox provider (github.com/ryanjdillon/paperclip-image, sandbox-ssh/):
# the environment driver that runs sandbox agents, such as gemini_local over
# ACP, on an SSH server. Its image holds only /package.json and /dist.
COPY --from=ghcr.io/ryanjdillon/paperclip-sandbox-ssh@sha256:e08b88c85c4ff3d5fb940068df6f87ea7c502e2813c8767e628da9d33f628d64 / /opt/paperclip-plugins/sandbox-ssh/

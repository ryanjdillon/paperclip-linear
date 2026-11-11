# Paperclip with this plugin baked in at /opt/paperclip-plugins/paperclip-linear.
# Pinned to the Paperclip release the plugin is tested against; upgrade the
# base image, the SDK pin in package.json, and PAPERCLIP_VERSION together.

# The build stage runs on the build machine's own architecture: its output is
# plain JavaScript, so the final multi-arch image needs no emulation.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:0998f9a7af5bba96fb32e2aeafde650a625012cb194a57e7f3939bf3e592721f AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack prepare --activate && pnpm install --frozen-lockfile
COPY esbuild.config.mjs tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM ghcr.io/paperclipai/paperclip:2026.1106.0@sha256:d6584f05cf57a4b26c117eb083725f18c1fe69ddafa7d16c9f8cce83f6fa17da
LABEL org.opencontainers.image.source="https://github.com/ryanjdillon/paperclip-linear" \
      org.opencontainers.image.description="Paperclip 2026.1106.0 with the paperclip-linear plugin" \
      org.opencontainers.image.licenses="MIT"
# The worker bundle is self-contained, so the plugin needs only its manifest
# package and dist/. Root-owned and read-only to the runtime user.
COPY package.json /opt/paperclip-plugins/paperclip-linear/package.json
COPY --from=build /src/dist /opt/paperclip-plugins/paperclip-linear/dist

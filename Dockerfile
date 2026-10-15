# Base image ships Chromium + all system libs; tag MUST match the installed
# playwright version (see packages/core/package.json). Confirm the tag exists at build time.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app

# Enable corepack so pnpm is available at the version declared in packageManager.
RUN corepack enable

# better-sqlite3 has no prebuilt binary for this image's Node version, so it is
# compiled from source via node-gyp — which needs a C++ toolchain (the base
# image ships python3 but not make/g++).
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json ./packages/api/package.json
COPY packages/bot/package.json ./packages/bot/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/db/package.json ./packages/db/package.json
RUN pnpm install --frozen-lockfile

# App source.
COPY . .

ENV NODE_ENV=production
EXPOSE 8787

# Default: run the API server. Override CMD in docker-compose for other services.
CMD ["pnpm", "--filter", "@arhip/api", "start"]

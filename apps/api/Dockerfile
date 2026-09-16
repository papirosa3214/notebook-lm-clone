# --- Build stage ---
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare [email protected] --activate

# copy everything; .dockerignore will trim node_modules
COPY . .

# install all deps for the whole monorepo
RUN pnpm install --frozen-lockfile

# build only the api package and its workspace deps (shared is type-only, no build step needed)
RUN pnpm --filter @notebook/shared build --if-present || true
RUN pnpm --filter @notebook/api build

# prune dev deps for runtime
RUN pnpm deploy --filter @notebook/api --prod /app

# --- Runtime stage ---
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# better-sqlite3 needs libstdc++ at runtime on alpine
RUN apk add --no-cache libstdc++

# copy prod-only node_modules + package files from build
COPY --from=build /app/ ./

EXPOSE 4001
USER node
CMD ["node", "dist/index.js"]

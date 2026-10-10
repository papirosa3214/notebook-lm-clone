# --- Build stage ---
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @notebook/web build

# --- Runtime stage: nginx serves the static bundle ---
FROM nginx:alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

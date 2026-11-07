# Anywhere web app. Build context: repository root.
FROM node:22-slim AS deps
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY spacetime/bindings/package.json spacetime/bindings/
COPY spacetime/module/package.json spacetime/module/
COPY services/messaging/package.json services/messaging/
RUN pnpm install --frozen-lockfile --filter web...

FROM deps AS build
COPY spacetime/bindings spacetime/bindings
COPY apps/web apps/web
# Public values are inlined at build time.
ARG NEXT_PUBLIC_SPACETIME_HOST
ARG NEXT_PUBLIC_SPACETIME_DATABASE=anywhere
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_SPACETIME_HOST=$NEXT_PUBLIC_SPACETIME_HOST \
    NEXT_PUBLIC_SPACETIME_DATABASE=$NEXT_PUBLIC_SPACETIME_DATABASE \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

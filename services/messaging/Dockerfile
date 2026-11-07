# Photon iMessage bridge. Build context: repository root.
FROM node:22-slim
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY spacetime/bindings/package.json spacetime/bindings/
COPY spacetime/module/package.json spacetime/module/
COPY services/messaging/package.json services/messaging/
# Full install: the bindings resolve their `spacetimedb` peer from their own dev link.
RUN pnpm install --frozen-lockfile --filter @anywhere/messaging...
COPY spacetime/bindings spacetime/bindings
COPY services/messaging services/messaging
WORKDIR /repo/services/messaging
USER node
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["node_modules/.bin/tsx", "src/index.ts"]

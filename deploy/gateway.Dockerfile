FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY database ./database
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @axiom/realtime-gateway... build
RUN pnpm --filter @axiom/realtime-gateway deploy --prod --legacy /out
RUN pnpm --filter @axiom/persistence deploy --prod --legacy /migration

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S axiom && adduser -S axiom -G axiom
COPY --from=build --chown=axiom:axiom /out ./
COPY --from=build --chown=axiom:axiom /migration ./packages/persistence
COPY --from=build --chown=axiom:axiom /workspace/packages/persistence/dist ./packages/persistence/dist
COPY --from=build --chown=axiom:axiom /workspace/database ./database
USER axiom
EXPOSE 8787
CMD ["node", "dist/server.js"]

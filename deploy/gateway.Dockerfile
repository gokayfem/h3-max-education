FROM node:26-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3 AS build
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

FROM node:26-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3 AS runtime
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

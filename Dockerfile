# syntax=docker/dockerfile:1
FROM node:22.23.0-bookworm-slim AS build
WORKDIR /app
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/voice-agent/package.json apps/voice-agent/
COPY apps/gateway/package.json apps/gateway/
COPY apps/radio/package.json apps/radio/
COPY apps/web-demo/package.json apps/web-demo/
COPY packages/shared-contracts/package.json packages/shared-contracts/
COPY packages/speech/package.json packages/speech/
COPY packages/verification-adapters/package.json packages/verification-adapters/
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
RUN pnpm -r build

FROM node:22.23.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY --chmod=755 scripts/container-start.sh /usr/local/bin/communications-start
ENV NODE_ENV=production SERVICE=voice-agent
USER node
ENTRYPOINT ["communications-start"]
CMD ["start"]

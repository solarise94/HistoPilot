FROM docker.io/library/node:22-bookworm-slim AS builder

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev

FROM docker.io/library/node:22-bookworm-slim
WORKDIR /app
COPY --from=builder /build/package.json ./
COPY --from=builder /build/node_modules/ node_modules/
COPY --from=builder /build/dist/ dist/

ENV HISTOPILOT_HOST=0.0.0.0 \
    HISTOPILOT_PORT=8055 \
    HISTOPILOT_SESSIONS_DIR=/data/sessions \
    HISTOPILOT_CONFIG_DIR=/data/config

VOLUME ["/data/sessions", "/data/config"]
EXPOSE 8055
CMD ["node", "dist/index.js"]

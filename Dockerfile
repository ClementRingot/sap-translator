# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine

RUN apk add --no-cache tini ca-certificates \
    && rm -rf /usr/lib/node_modules/npm

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/package.json ./package.json

# Non-root user
RUN addgroup -S translator && adduser -S translator -G translator
USER translator

EXPOSE 8080

ENV MCP_TRANSPORT=http-streamable \
    PORT=8080 \
    LOG_FORMAT=json \
    LOG_LEVEL=info \
    SAP_I18N_SERVICE_PATH=/sap/bc/rest/zcl_i18n_service \
    SAP_CLIENT=000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

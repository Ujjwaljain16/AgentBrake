# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Final stage
FROM node:20-alpine
WORKDIR /app

# Run as non-root for security
RUN addgroup -S agentbrake && adduser -S agentbrake -G agentbrake

# Copy production dependencies and built files
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
# Copy examples (including config and tools) for demos
COPY --from=builder /app/examples ./examples

# Create volume mount points
VOLUME ["/app/config"]
RUN mkdir -p /app/logs && chown -R agentbrake:agentbrake /app

USER agentbrake

# Default to running the proxy
CMD ["node", "dist/src/proxy/index.js"]

# No health check: the proxy is a stdio process with no port to probe, and requiring its
# entry point would just run it without a command and exit 1 (always "unhealthy").
HEALTHCHECK NONE

LABEL org.opencontainers.image.source="https://github.com/Ujjwaljain16/AgentBrake"
LABEL org.opencontainers.image.description="Safety proxy for MCP-based AI agents"
LABEL org.opencontainers.image.licenses="MIT"

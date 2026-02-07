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

# Copy production dependencies and built files
COPY --from=builder /app/package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist
# Copy examples (including config and tools) for demos
COPY --from=builder /app/examples ./examples

# Create volume mount point for config
VOLUME ["/app/config"]

# Default to running the proxy
CMD ["node", "dist/proxy/index.js"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

LABEL org.opencontainers.image.source="https://github.com/Ujjwaljain16/AgentBrake"
LABEL org.opencontainers.image.description="Safety proxy for MCP-based AI agents"

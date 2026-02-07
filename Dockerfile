FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy built files
COPY dist/ ./dist/
COPY agent-brake.yml ./

# Create volume mount point for config
VOLUME ["/app/config"]

# Default command
CMD ["node", "dist/proxy/index.js"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

LABEL org.opencontainers.image.source="https://github.com/Ujjwaljain16/AgentBrake"
LABEL org.opencontainers.image.description="Safety proxy for MCP-based AI agents"

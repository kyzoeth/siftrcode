# SiftrCode Railway Production Dockerfile
FROM node:22-slim

# Install Python 3 for Python AST skeletonizer and git for build stamping
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source, scripts and web assets
COPY tsconfig.json ./
COPY src/ ./src/
COPY web/ ./web/
COPY scripts/ ./scripts/
COPY README.md LICENSE ./

# Build TypeScript and prepare distribution
RUN npm run build

# Expose default port
EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV SIFTR_JEV_REMOTE_PROCESSING=true

# Start web server
CMD ["node", "dist/server/web.js"]

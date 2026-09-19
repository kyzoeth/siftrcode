# SiftrCode Railway Production Dockerfile
FROM node:20-slim

# Install Python 3 for Python AST skeletonizer
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and web assets
COPY tsconfig.json ./
COPY src/ ./src/
COPY web/ ./web/
COPY README.md LICENSE ./

# Build TypeScript and prepare distribution
RUN npm run build

# Expose default port
EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production

# Start web server
CMD ["node", "dist/server/web.js"]

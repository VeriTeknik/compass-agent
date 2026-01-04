# Compass Agent - AI Jury/Oracle
# PAP-RFC-001 Compliant Container with Chat UI

# ===========================================
# Stage 1: Build backend (TypeScript)
# ===========================================
FROM node:22-alpine AS backend-builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# ===========================================
# Stage 2: Build frontend (React + Vite)
# ===========================================
FROM node:22-alpine AS frontend-builder

WORKDIR /app/frontend

# Copy frontend package files
COPY frontend/package*.json ./

# Install dependencies
RUN npm ci

# Copy frontend source
COPY frontend/ ./

# Build frontend (outputs to ../dist/public)
RUN npm run build

# ===========================================
# Stage 3: Production image
# ===========================================
FROM node:22-alpine AS production

# OCI Labels for GitHub Container Registry
LABEL org.opencontainers.image.source="https://github.com/veriteknik/compass-agent"
LABEL org.opencontainers.image.description="Compass - AI Jury/Oracle agent for multi-model consensus"
LABEL org.opencontainers.image.licenses="MIT"

# Security: Run as non-root user
RUN addgroup -g 1001 -S compass && \
    adduser -u 1001 -S compass -G compass

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built backend
COPY --from=backend-builder /app/dist ./dist

# Copy built frontend
COPY --from=frontend-builder /app/dist/public ./dist/public

# Copy ADL manifest
COPY src/config/agent.yaml ./config/

# Set ownership
RUN chown -R compass:compass /app

# Switch to non-root user
USER compass

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Health check (PAP compliant)
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start agent
CMD ["node", "dist/index.js"]

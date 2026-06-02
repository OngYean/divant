# Stage 1: Build the application
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package configuration
COPY package*.json ./

# Install dependencies (including devDependencies for building)
RUN npm ci

# Copy the rest of the application code
COPY . .

# Build the Next.js app
RUN npm run build

# Stage 2: Runner stage
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install only production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy built assets and files needed for running
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/server ./server
COPY --from=builder /app/lib ./lib
# Copy env and configurations
COPY --from=builder /app/next.config.ts ./
COPY --from=builder /app/tsconfig.json ./

# Expose Next.js app port and WebSocket port
EXPOSE 3000
EXPOSE 3001

# Command to run both the next server and websocket server
CMD ["node", "server/run-prod.js"]

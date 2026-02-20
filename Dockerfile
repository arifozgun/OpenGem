# Stage 1: compile TypeScript
# better-sqlite3 requires native compilation (node-gyp) in both stages
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json .
COPY src/ ./src/
RUN npm run build

# Stage 2: production image
# Re-install prod-only deps so node_modules stays lean (~no typescript/jest/etc)
FROM node:22-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY public/ ./public/
COPY app.js ./
VOLUME ["/app/data"]
ENV SQLITE_PATH=/app/data/opengem.db \
    DB_PROVIDER=sqlite \
    NODE_ENV=production \
    PORT=3050
EXPOSE 3050
CMD ["node", "app.js"]

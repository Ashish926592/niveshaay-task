# Niveshaay image-service — TypeScript + Node + system Chromium for Puppeteer.
# Renders the standardized P&L JSON into the styled green PNG used by the
# WhatsApp delivery branch (POST /generate-image -> { base64 }).

# ── Stage 1: compile TypeScript -> dist/ ─────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install                      # incl. devDeps (typescript, @types/*)
COPY src ./src
RUN npm run build                    # tsc -> /app/dist

# ── Stage 2: lean runtime (prod deps + compiled JS + Chromium) ───────────────
FROM node:20-bookworm-slim
# Chromium + the fonts Puppeteer needs (DejaVu carries the ₹ glyph).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-dejavu-core \
      ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Use the system Chromium; puppeteer-core never downloads its own.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev           # express + puppeteer-core only
COPY --from=build /app/dist ./dist

EXPOSE 3001
CMD ["node", "dist/server.js"]

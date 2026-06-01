# Niveshaay image-service — Node + system Chromium for Puppeteer.
# Renders the standardized P&L JSON into the styled green PNG used by the
# WhatsApp delivery branch (POST /generate-image -> { base64 }).
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
RUN npm install --omit=dev
COPY server.js ./

EXPOSE 3001
CMD ["node", "server.js"]

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Cron script: calls /api/cron/followup every 5 minutes
RUN printf '#!/bin/sh\nsleep 60\nwhile true; do\n  wget -q -O /dev/null "http://localhost:3000/api/cron/followup" -T 30 || true\n  sleep 300\ndone\n' > /app/cron.sh && chmod +x /app/cron.sh

EXPOSE 3000
CMD ["sh", "-c", "/app/cron.sh & node server.js"]

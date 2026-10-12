# syntax=docker/dockerfile:1.7
# One image, three roles: API (default), worker (`node dist/worker.js`) and migrations (`npm run db:migrate`).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Match the npm major that wrote package-lock.json.
RUN npm install -g npm@12 >/dev/null
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# ffmpeg is required by the worker for sermon media and branded clips; fonts back the branded
# image and caption rendering (without any, text renders blank); tini reaps child processes
# and forwards signals.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
     fontconfig fonts-dejavu-core fonts-liberation2 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# Heap limit ≈ 75% of the container memory limit, so a leak ends in a heap-out-of-memory error
# with a stack trace instead of a silent kernel kill (exit 137). The default fits a 512 MB
# container; change it by passing a different command (see docs/DEPLOYMENT.md):
#   API (512 MB):    node --enable-source-maps --max-old-space-size=384  --import ./dist/instrument.js dist/main.js
#   worker (2 GB):   node --enable-source-maps --max-old-space-size=1536 --import ./dist/instrument.js dist/worker.js
CMD ["node", "--enable-source-maps", "--max-old-space-size=384", "--import", "./dist/instrument.js", "dist/main.js"]

# Migration runner: includes the Prisma CLI (dev dependency) and migrations.
FROM deps AS migrate
WORKDIR /app
COPY prisma ./prisma
COPY prisma.config.ts ./
# Full install so the allow-listed Prisma install scripts fetch the schema engine.
RUN npm ci
CMD ["npx", "prisma", "migrate", "deploy"]

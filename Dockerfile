# ============================================================================
# W FLOW — self-hosted Docker image
# Stage 1: build the frontend   Stage 2: run the Node backend (serves UI + API)
# ============================================================================

# ---- build stage -----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage ---------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
# public/ holds the landing page + SEO files and the logo/favicon the admin
# panel (server/admin.js) serves at runtime — the vite build copies the first
# three into dist/, but the admin server reads logo.png / favicon.png straight
# from public/, so the image needs it too.
COPY public ./public
# Operational scripts, so the SQLite → PostgreSQL migration can run inside a
# running container that cannot reach the database from the host:
#   docker compose exec wflow npm run db:migrate -- --url postgres://…
COPY scripts ./scripts
# docs/guide.md is read from disk at runtime by GET /api/docs and
# GET /api/docs/pdf (Settings → Documentation / Download PDF), so the guide has
# to be inside the image — it is not part of the vite bundle.
COPY docs ./docs
# Root metadata the Pro “Run it self-hosted” download packs into its ZIP
# (server/selfhost.js SHIP_FILES) and the deployed instance's own docs links
# point at. Without them the bundle still builds, it just ships fewer files.
COPY README.md ERRORS.md .env.example docker-compose.yml Dockerfile ./
COPY start.sh start.bat admin.sh admin.bat ./
RUN chmod +x start.sh admin.sh

# workflows, agents and API keys live here (mount a volume to persist)
VOLUME ["/app/data"]
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/nodes >/dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]

#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# One-command setup for the Niveshaay Financial Results pipeline.
#
#   ./setup.sh              # core app (UI + PDF→Gemini→JSON + cache)
#   ./setup.sh whatsapp     # core app PLUS WhatsApp image delivery
#
# Starts n8n, waits for it, IMPORTS *and ACTIVATES* the workflow, restarts so
# the webhooks register, and prints the URL. Idempotent — re-run any time
# (e.g. after editing prompt.md / ui.html + `node tools/build-workflow.js`).
#
# `whatsapp` mode additionally brings up — Compose-free, via plain `docker run`
# on a shared Docker network so the names resolve — evolution + postgres + redis
# + the image-service, and connects n8n to that network. The new Evolution's admin is
# on http://localhost:8081 (host :8080 is left for any existing Evolution).
#
# Prereqs: Docker + curl, and a GEMINI_API_KEY in .env. Uses `docker compose` if
# the v2 plugin is present; otherwise falls back to a plain `docker run`.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

CONTAINER=niveshaay_n8n
WF_ID=niveshaayfinres1
N8N_URL=http://localhost:5678
NET=niveshaay
EVO_ADMIN=http://localhost:8081      # host port for the containerized Evolution (8080 inside)

WANT_WHATSAPP=0
case "${1:-}" in whatsapp | --whatsapp) WANT_WHATSAPP=1 ;; esac

have() { docker ps -a --format '{{.Names}}' | grep -qx "$1"; }
envval() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

# 1. .env + key check ────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  echo "→ created .env from .env.example"
fi
KEY=$(envval GEMINI_API_KEY)
if [ -z "${KEY:-}" ] || [ "$KEY" = "your_gemini_api_key_here" ]; then
  echo "✗ Set GEMINI_API_KEY in .env first → https://aistudio.google.com/apikey"
  exit 1
fi

# n8n stores everything in SQLite inside its volume; the CLI import/activate
# CANNOT run while the main n8n process holds that DB (it dies with SQLITE_BUSY).
# So we import + activate via a ONE-SHOT container with n8n stopped, then start
# the long-running n8n — which registers the webhooks for the active workflow.
IMAGE=n8nio/n8n:latest
if docker compose version >/dev/null 2>&1; then ENGINE=compose; else ENGINE=run; fi

# 2. import + ACTIVATE the workflow (one-shot; nothing else touching the DB) ──
echo "→ importing + activating workflow (n8n stopped during import to free its DB)…"
if [ "$ENGINE" = compose ]; then
  docker compose stop n8n >/dev/null 2>&1 || true
  docker compose run --rm --no-deps -v "$PWD/workflow.json":/tmp/workflow.json:ro \
    n8n import:workflow --input=/tmp/workflow.json
  docker compose run --rm --no-deps n8n update:workflow --id="$WF_ID" --active=true
else
  echo "  (no 'docker compose' plugin — using plain 'docker run')"
  if have "$CONTAINER"; then docker stop "$CONTAINER" >/dev/null 2>&1 || true; fi
  docker run --rm -v n8n_data:/home/node/.n8n \
    -v "$PWD/workflow.json":/tmp/workflow.json:ro \
    "$IMAGE" import:workflow --input=/tmp/workflow.json
  docker run --rm -v n8n_data:/home/node/.n8n \
    "$IMAGE" update:workflow --id="$WF_ID" --active=true
fi

# 3. start the long-running n8n (registers the webhooks on boot) ──────────────
echo "→ starting n8n…"
if [ "$ENGINE" = compose ]; then
  docker compose up -d n8n
elif have "$CONTAINER"; then
  docker start "$CONTAINER" >/dev/null            # reuse the existing container + its n8n_data volume
else
  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    -p 5678:5678 \
    --env-file .env \
    -e N8N_HOST=localhost \
    -e N8N_PORT=5678 \
    -e N8N_PROTOCOL=http \
    -e WEBHOOK_URL=http://localhost:5678/ \
    -e N8N_RUNNERS_ENABLED=true \
    -e GENERIC_TIMEZONE=Asia/Kolkata \
    -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
    -v n8n_data:/home/node/.n8n \
    "$IMAGE" >/dev/null
fi

# 4. wait until the public UI webhook responds ────────────────────────────────
printf "→ waiting for the UI webhook"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "$N8N_URL/webhook/ui" 2>/dev/null; then break; fi
  printf "."; sleep 2
done
echo " ready."

# 7. OPTIONAL: WhatsApp delivery stack (compose-free, shared docker network) ──
if [ "$WANT_WHATSAPP" = "1" ]; then
  EVO_KEY=$(envval EVOLUTION_API_KEY); EVO_KEY=${EVO_KEY:-change-me}
  EVO_INST=$(envval EVOLUTION_INSTANCE); EVO_INST=${EVO_INST:-niveshaay}

  echo ""
  echo "── WhatsApp: bringing up postgres + evolution + image-service on net '$NET' ──"
  docker network inspect "$NET" >/dev/null 2>&1 || { echo "→ creating network $NET"; docker network create "$NET" >/dev/null; }

  # postgres (datastore for Evolution; session/link persist here) ──────────────
  if have niveshaay_postgres; then docker start niveshaay_postgres >/dev/null; else
    echo "→ starting postgres…"
    docker run -d --name niveshaay_postgres --network "$NET" --network-alias postgres \
      --restart unless-stopped \
      -e POSTGRES_USER=evolution -e POSTGRES_PASSWORD=evolution123 -e POSTGRES_DB=evolution \
      -v evolution_pgdata:/var/lib/postgresql/data \
      postgres:15-alpine >/dev/null
  fi
  printf "→ waiting for postgres"
  for _ in $(seq 1 30); do docker exec niveshaay_postgres pg_isready -U evolution >/dev/null 2>&1 && break; printf "."; sleep 2; done
  echo " ok."

  # redis (Evolution v2 REQUIRES a cache backend — without it Evolution crash-loops
  # on "redis disconnected" and exits). n8n reaches it as redis:6379. ───────────
  if have niveshaay_redis; then docker start niveshaay_redis >/dev/null; else
    echo "→ starting redis…"
    docker run -d --name niveshaay_redis --network "$NET" --network-alias redis \
      --restart unless-stopped -v evolution_redis:/data redis:7-alpine >/dev/null
  fi

  # evolution (n8n reaches it as evolution:8080; humans via $EVO_ADMIN) ─────────
  if have niveshaay_evolution; then docker start niveshaay_evolution >/dev/null; else
    echo "→ starting evolution (admin: $EVO_ADMIN)…"
    docker run -d --name niveshaay_evolution --network "$NET" --network-alias evolution \
      --restart unless-stopped -p 8081:8080 \
      -e SERVER_URL=http://localhost:8081 \
      -e AUTHENTICATION_API_KEY="$EVO_KEY" \
      -e DATABASE_ENABLED=true -e DATABASE_PROVIDER=postgresql \
      -e DATABASE_CONNECTION_URI=postgresql://evolution:evolution123@postgres:5432/evolution \
      -e DATABASE_CONNECTION_CLIENT_NAME=evolution \
      -e CACHE_REDIS_ENABLED=true \
      -e CACHE_REDIS_URI=redis://redis:6379/8 \
      -e CACHE_REDIS_PREFIX_KEY=evolution \
      -e CACHE_REDIS_SAVE_INSTANCES=false \
      -e CACHE_LOCAL_ENABLED=true \
      -e CONFIG_SESSION_PHONE_VERSION=2.3000.1040549582 \
      atendai/evolution-api:latest >/dev/null
  fi

  # image-service (build then run; stateless → recreate to pick up rebuilds) ────
  echo "→ building image-service (first build pulls chromium — a few min)…"
  # --network=host: the legacy builder's DNS can be flaky (npm EAI_AGAIN); use host DNS.
  docker build --network=host -t niveshaay-image-service ./image-service >/dev/null
  have niveshaay_image_service && docker rm -f niveshaay_image_service >/dev/null
  docker run -d --name niveshaay_image_service --network "$NET" --network-alias image-service \
    --restart unless-stopped -p 3001:3001 niveshaay-image-service >/dev/null

  # connect n8n to the network so http://evolution:8080 / http://image-service:3001 resolve
  docker network connect "$NET" "$CONTAINER" 2>/dev/null || true

  printf "→ waiting for evolution"
  for _ in $(seq 1 45); do curl -fsS -m 3 "$EVO_ADMIN/" >/dev/null 2>&1 && break; printf "."; sleep 2; done
  echo " up."

  echo "→ creating instance '$EVO_INST' (ignored if it already exists)…"
  curl -s -m 10 -X POST "$EVO_ADMIN/instance/create" -H "apikey: $EVO_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"instanceName\":\"$EVO_INST\",\"integration\":\"WHATSAPP-BAILEYS\",\"qrcode\":true}" >/dev/null 2>&1 || true
fi

# ── done ──────────────────────────────────────────────────────────────────────
echo ""
echo "✓ Done. Open:  $N8N_URL/webhook/ui"
echo "  API:         curl -X POST $N8N_URL/webhook/process-pdf -H 'Content-Type: application/json' -d '{\"pdfUrl\":\"https://…​.pdf\"}'"

if [ "$WANT_WHATSAPP" = "1" ]; then
  EVO_KEY=$(envval EVOLUTION_API_KEY); EVO_KEY=${EVO_KEY:-change-me}
  EVO_INST=$(envval EVOLUTION_INSTANCE); EVO_INST=${EVO_INST:-niveshaay}
  cat <<EOF

── WhatsApp: ONE manual step left (link your phone) ──
  1. Open  $EVO_ADMIN/manager   (apikey: $EVO_KEY)
       → open instance "$EVO_INST" → scan the QR in WhatsApp ▸ Linked devices ▸ Link a device
  2. Confirm it linked ("open" = linked):
       curl $EVO_ADMIN/instance/connectionState/$EVO_INST -H "apikey: $EVO_KEY"
  3. .env already has WHATSAPP_GROUP_JID. If you link a DIFFERENT phone, refetch it:
       curl -H "apikey: $EVO_KEY" "$EVO_ADMIN/group/fetchAllGroups/$EVO_INST?getParticipants=false"

  Then submit a FRESH PDF in the UI → the P&L image posts to your group.
  (Cache hits don't re-send — only new extractions do.)
  If linking fails on a WhatsApp-version error, bump CONFIG_SESSION_PHONE_VERSION
  in setup.sh (and the evolution image tag) and re-run.
EOF
fi

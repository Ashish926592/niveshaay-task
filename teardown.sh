#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# teardown.sh — stop & remove the ENTIRE Niveshaay pipeline (counterpart to
# setup.sh). Kills every container the app starts, removes its private network,
# and OPTIONALLY wipes its data volumes and the locally-built image.
#
#   ./teardown.sh                # stop + remove containers + network (KEEPS data)
#   ./teardown.sh --volumes      # ALSO delete data volumes (workflow + WhatsApp
#                                 #   session are lost; needs re-import + re-scan)
#   ./teardown.sh --images       # ALSO remove the built image-service image
#   ./teardown.sh --all          # containers + network + volumes + images
#   ./teardown.sh --all --yes    # …and skip the confirmation prompt
#
# Idempotent — safe to run repeatedly. setup.sh starts most services as plain
# `docker run` on a shared 'niveshaay' network, so `docker compose down` alone is
# NOT enough; this force-removes the named containers too. Both paths handled.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

NET=niveshaay
CONTAINERS=(niveshaay_n8n niveshaay_evolution niveshaay_redis niveshaay_postgres niveshaay_image_service)
VOLUMES=(n8n_data evolution_pgdata evolution_redis)
IMAGES=(niveshaay-image-service)

PURGE_VOLUMES=0
PURGE_IMAGES=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
teardown.sh — stop & remove the entire Niveshaay pipeline (counterpart to setup.sh).

  ./teardown.sh             stop + remove containers + network (KEEPS data volumes)
  ./teardown.sh --volumes   ALSO delete data volumes (workflow + WhatsApp session lost)
  ./teardown.sh --images    ALSO remove the built image-service image
  ./teardown.sh --all       containers + network + volumes + images
  ./teardown.sh --all --yes …and skip the confirmation prompt
  ./teardown.sh --help      show this help

Idempotent. Handles both the `docker compose` path and the plain `docker run` path.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -v|--volumes|--purge) PURGE_VOLUMES=1 ;;
    -i|--images)          PURGE_IMAGES=1 ;;
    --all)                PURGE_VOLUMES=1; PURGE_IMAGES=1 ;;
    -y|--yes)             ASSUME_YES=1 ;;
    -h|--help)            usage; exit 0 ;;
    *) echo "✗ unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

command -v docker >/dev/null 2>&1 || { echo "✗ docker not found in PATH" >&2; exit 1; }

c_exists() { docker ps -a    --format '{{.Names}}' | grep -qx "$1"; }
v_exists() { docker volume ls --format '{{.Name}}' | grep -qx "$1"; }
i_exists() { docker image inspect "$1" >/dev/null 2>&1; }
n_exists() { docker network inspect "$1" >/dev/null 2>&1; }

# Confirm the irreversible volume wipe (unless --yes).
if [ "$PURGE_VOLUMES" = 1 ] && [ "$ASSUME_YES" = 0 ]; then
  echo "⚠  --volumes will PERMANENTLY DELETE these data volumes:"
  for v in "${VOLUMES[@]}"; do
    if v_exists "$v"; then echo "     - $v"; fi
  done
  echo "   (n8n workflow state + Evolution WhatsApp session — gone for good)"
  printf "   Type 'yes' to confirm: "
  read -r reply || reply=""
  if [ "$reply" != "yes" ]; then echo "→ keeping volumes."; PURGE_VOLUMES=0; fi
fi

echo "── Niveshaay teardown ─────────────────────────────────────────────"

# 1. compose path — a no-op if the app was started via plain `docker run`.
# NOTE: --profile whatsapp intentionally omitted: setup.sh always starts the WhatsApp
# services via plain `docker run`, so compose never manages them and the --profile flag
# has no effect. The explicit `docker rm` loop below is the authoritative removal path.
if [ -f docker-compose.yml ] && docker compose version >/dev/null 2>&1; then
  if [ "$PURGE_VOLUMES" = 1 ]; then
    echo "→ docker compose down --remove-orphans --volumes"
    docker compose down --remove-orphans --volumes 2>&1 || true
  else
    echo "→ docker compose down --remove-orphans"
    docker compose down --remove-orphans 2>&1 || true
  fi
fi

# 2. plain docker-run path — force-remove the named containers.
echo "→ removing containers…"
for c in "${CONTAINERS[@]}"; do
  if c_exists "$c"; then
    if docker rm -f "$c" >/dev/null 2>&1; then echo "     ✓ $c"; else echo "     ✗ $c (failed)"; fi
  fi
done

# 3. private network.
if n_exists "$NET"; then
  echo "→ removing network '$NET'…"
  if docker network rm "$NET" >/dev/null 2>&1; then echo "     ✓ $NET"; else echo "     ✗ $NET (still in use?)"; fi
fi

# 4. data volumes — only with --volumes/--all, after confirmation.
if [ "$PURGE_VOLUMES" = 1 ]; then
  echo "→ removing data volumes…"
  for v in "${VOLUMES[@]}"; do
    if v_exists "$v"; then
      if docker volume rm "$v" >/dev/null 2>&1; then echo "     ✓ $v"; else echo "     ✗ $v (in use)"; fi
    fi
  done
else
  echo "→ keeping data volumes: ${VOLUMES[*]}"
fi

# 5. built image(s) — only with --images/--all.
if [ "$PURGE_IMAGES" = 1 ]; then
  echo "→ removing built image(s)…"
  for i in "${IMAGES[@]}"; do
    if i_exists "$i"; then
      if docker rmi "$i" >/dev/null 2>&1; then echo "     ✓ $i"; else echo "     ✗ $i (in use)"; fi
    fi
  done
fi

echo "───────────────────────────────────────────────────────────────────"
left=$(docker ps -a --format '{{.Names}}' | grep -E '^(niveshaay_n8n|niveshaay_evolution|niveshaay_redis|niveshaay_postgres|niveshaay_image_service)$' || true)
if [ -n "$left" ]; then
  echo "⚠  still present: $left"
else
  echo "✓ all app containers removed."
fi
echo "  Bring it back with:  ./setup.sh whatsapp"

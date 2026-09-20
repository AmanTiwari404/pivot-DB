#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "🚀  MongoDB Visualizer — Dev Launcher"
echo "══════════════════════════════════════"

# ── 1. Kill any leftover dev processes ───────────────────────────────────────
echo ""
echo "🧹  Killing any leftover processes…"
pkill -f "tsx watch\|pnpm dev\|vite" 2>/dev/null || true
lsof -ti:3001,5173 | xargs kill -9 2>/dev/null || true
sleep 1

# ── 2. Start Docker Desktop if not running ───────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  echo ""
  echo "🐳  Starting Docker Desktop…"
  open -a Docker
  echo "   Waiting for Docker daemon"
  until docker info >/dev/null 2>&1; do
    printf "."
    sleep 2
  done
  echo " ready!"
fi

# ── 3. Start infrastructure containers (postgres, redis, prometheus, grafana) ─
echo ""
echo "📦  Starting infrastructure containers…"
docker compose -f "$ROOT/docker-compose.yml" up -d postgres redis prometheus grafana 2>&1 \
  | grep -v "^time=\|obsolete\|attribute"

# ── 4. Wait for postgres + redis ─────────────────────────────────────────────
echo ""
echo "⏳  Waiting for postgres…"
until nc -z localhost 5432 2>/dev/null; do printf "."; sleep 1; done
echo " up!"

echo "⏳  Waiting for redis…"
until nc -z localhost 6379 2>/dev/null; do printf "."; sleep 1; done
echo " up!"

# ── 5. Run DB migrations (safe — skips if already applied) ───────────────────
echo ""
echo "🗄️   Running DB migrations…"
cd "$ROOT/apps/api"
npx prisma migrate deploy 2>&1 | tail -3
cd "$ROOT"

# ── 6. Start API + Web with concurrently ─────────────────────────────────────
echo ""
echo "✅  All systems go!"
echo ""
echo "   Web  →  http://localhost:5173"
echo "   API  →  http://localhost:3001"
echo "   Grafana  →  http://localhost:3003  (admin / admin)"
echo "   Prometheus  →  http://localhost:9090"
echo ""
echo "   First run? The web UI will walk you through creating the admin account."
echo ""
echo "══════════════════════════════════════"
echo ""

cd "$ROOT"
exec pnpm dev

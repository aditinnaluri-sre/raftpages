#!/bin/bash
# start.sh — stop any old instance and (re)start the Runbook Portal backend.
# Nginx serves the frontend and doesn't need restarting unless you changed
# its config — this script leaves it alone.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
LOG_DIR="$SCRIPT_DIR/logs"
DATA_DIR="$SCRIPT_DIR/data"
PORT="${PORT:-4001}"

# 0. Load .env if present
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    . "$SCRIPT_DIR/.env"
    set +a
fi

# 1. Persistent Database directory (outside source updates)
mkdir -p "$DATA_DIR"
if [ ! -L "$BACKEND_DIR/runbook.db" ] && [ -f "$BACKEND_DIR/runbook.db" ] && [ ! -f "$DATA_DIR/runbook.db" ]; then
    echo "▶ Moving initial database to persistent directory..."
    mv "$BACKEND_DIR/runbook.db" "$DATA_DIR/runbook.db"
fi
# Ensure backend/runbook.db is a symlink pointing directly to data/runbook.db
if [ ! -L "$BACKEND_DIR/runbook.db" ]; then
    rm -f "$BACKEND_DIR/runbook.db" "$BACKEND_DIR/runbook.db-wal" "$BACKEND_DIR/runbook.db-shm" 2>/dev/null || true
    ln -sf "$DATA_DIR/runbook.db" "$BACKEND_DIR/runbook.db"
fi
export DB_PATH="${DB_PATH:-$DATA_DIR/runbook.db}"

# Seed dummy users and sample runbooks if database is new/empty
if [ -f "$BACKEND_DIR/seed-dev-data.js" ]; then
    echo "▶ Seeding database dummy accounts & sample runbooks..."
    node "$BACKEND_DIR/seed-dev-data.js" || true
fi

# Point this at your Firebase service account JSON. Defaults to your actual
# key file — override by exporting GOOGLE_APPLICATION_CREDENTIALS before
# running this script if it ever moves or changes.
export GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-$BACKEND_DIR/runbook-86573-firebase-adminsdk-fbsvc-ee08443a08.json}"
export GCS_PROJECT_ID="${GCS_PROJECT_ID:-runbook-86573}"
export STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-}"
export STRIPE_PUBLISHABLE_KEY="${STRIPE_PUBLISHABLE_KEY:-}"

# Storage quotas (free tier). Change the numbers here and rerun ./start.sh
# to adjust — no code changes needed.
export USER_QUOTA_MB="${USER_QUOTA_MB:-1024}"     # individual users: 1GB
export TEAM_QUOTA_MB="${TEAM_QUOTA_MB:-5120}"     # teams: 5GB pooled
export TEAM_MEMBER_LIMIT="${TEAM_MEMBER_LIMIT:-5}" # max members per team

mkdir -p "$LOG_DIR"

echo "▶ Stopping old backend (if running)..."
if [ -f "$LOG_DIR/runbook-backend.pid" ]; then
    kill "$(cat "$LOG_DIR/runbook-backend.pid")" 2>/dev/null && echo "  Stopped: runbook backend (pid file)" || true
fi
pkill -f "node.*server\.js" 2>/dev/null && echo "  Stopped: runbook backend (fallback match)" || true
sleep 1

echo "▶ Checking service account key..."
if [ ! -f "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
    echo "⚠️  Service account key file not found: $GOOGLE_APPLICATION_CREDENTIALS"
    echo "   Backend will run in Local Dev Fallback Mode."
else
    echo "✅ Using: $GOOGLE_APPLICATION_CREDENTIALS"
fi

if [ -z "$GCS_PROJECT_ID" ]; then
    echo "⚠️  GCS_PROJECT_ID is not set — file/attachment uploads will be disabled."
    echo "   export GCS_PROJECT_ID=your-project-id   (see README)"
else
    echo "✅ Per-user buckets will use project: $GCS_PROJECT_ID"
fi

if [ -z "$STRIPE_SECRET_KEY" ]; then
    echo "⚠️  STRIPE_SECRET_KEY is not set — live checkout disabled. (export STRIPE_SECRET_KEY=rk_live_... or set in .env)"
else
    echo "✅ Stripe Live Gateway configured"
fi

echo "▶ Starting backend on :$PORT..."
cd "$BACKEND_DIR"
PORT="$PORT" DB_PATH="$DB_PATH" STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" STRIPE_PUBLISHABLE_KEY="$STRIPE_PUBLISHABLE_KEY" nohup node server.js > "$LOG_DIR/runbook-backend.log" 2>&1 &
echo $! > "$LOG_DIR/runbook-backend.pid"
echo "✅ Backend PID $(cat "$LOG_DIR/runbook-backend.pid")"

echo "▶ Waiting for backend..."
for i in {1..15}; do
    # 401 is expected (no auth token sent) — it just means the server answered.
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/auth/me" | grep -qE "^(200|401)$"; then
        echo "✅ Backend is up"
        break
    fi
    if [ "$i" -eq 15 ]; then
        echo "❌ Backend didn't respond in time — check $LOG_DIR/runbook-backend.log"
        exit 1
    fi
    echo "  ... ($i/15)"; sleep 2
done

echo "▶ Nginx status (frontend)..."
if systemctl is-active --quiet nginx; then
    echo "✅ Nginx already running — no action needed"
else
    echo "⚠️  Nginx is not running. Starting it..."
    sudo systemctl start nginx
    systemctl is-active --quiet nginx && echo "✅ Nginx started" || echo "❌ Nginx failed to start — check: sudo journalctl -u nginx"
fi

echo ""
echo "Done. Visit: https://raftpages.com"
echo "Logs: tail -f $LOG_DIR/runbook-backend.log"

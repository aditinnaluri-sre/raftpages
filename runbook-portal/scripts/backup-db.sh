#!/bin/bash
# backup-db.sh — Automated SQLite & Config Backup for Runbook Portal
# Usage: Run manually or via crontab every 6 hours

set -e

APP_DIR="/home/adi.tinnaluri/runbook/runbook-portal"
DB_PATH="$APP_DIR/data/runbook.db"
BACKUP_DIR="/home/adi.tinnaluri/runbook/backups"
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
BACKUP_FILE="$BACKUP_DIR/runbook-$TIMESTAMP.db"
RETENTION_DAYS=14

mkdir -p "$BACKUP_DIR"

if [ -f "$DB_PATH" ]; then
    echo "▶ Creating hot SQLite backup of $DB_PATH..."
    # Use node better-sqlite3 or sqlite3 online backup to avoid locking
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"
    else
        node -e "const DB = require('$APP_DIR/backend/node_modules/better-sqlite3'); const db = new DB('$DB_PATH'); db.backup('$BACKUP_FILE');"
    fi
    echo "✅ Backup saved to: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
else
    echo "⚠️ Database file $DB_PATH not found!"
    exit 1
fi

# Purge local backups older than RETENTION_DAYS (14 days)
echo "▶ Cleaning up backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -type f -name "runbook-*.db" -mtime +$RETENTION_DAYS -delete

echo "✅ Backup process complete!"

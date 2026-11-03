#!/bin/bash
# setup-production-raftpages.sh
# Production Provisioning Script for raftpages.com
# Run with sudo privileges: sudo bash setup-production-raftpages.sh

set -e

DOMAIN="raftpages.com"
APP_USER="raftpages"
PROD_DIR="/home/$APP_USER/app"
DATA_DIR="/home/$APP_USER/data"
LOG_DIR="/home/$APP_USER/logs"
SOURCE_DIR="/home/adi.tinnaluri/runbook/runbook-portal"

echo "======================================================"
echo "🚀 Provisioning Production Environment for $DOMAIN"
echo "======================================================"

# 1. Create Dedicated Service User
if ! id "$APP_USER" &>/dev/null; then
    echo "▶ Creating dedicated system user '$APP_USER'..."
    useradd -m -s /bin/bash "$APP_USER"
fi

# 2. Prepare Directory Hierarchy
echo "▶ Setting up production directory structure..."
mkdir -p "$PROD_DIR" "$DATA_DIR" "$LOG_DIR"

# 3. Copy Application Artifacts & Initial Database
echo "▶ Copying application files to production..."
cp -r "$SOURCE_DIR/dist" "$PROD_DIR/"
cp -r "$SOURCE_DIR/backend" "$PROD_DIR/"
cp -r "$SOURCE_DIR/package.json" "$PROD_DIR/"
cp -r "$SOURCE_DIR/scripts" "$PROD_DIR/"

# Copy database if not already present
if [ ! -f "$DATA_DIR/runbook.db" ] && [ -f "$SOURCE_DIR/data/runbook.db" ]; then
    echo "▶ Migrating existing database to production data folder..."
    cp "$SOURCE_DIR/data/runbook.db"* "$DATA_DIR/"
fi

# Fix Permissions
chown -R "$APP_USER:$APP_USER" "/home/$APP_USER"

# 4. Create Systemd Service for Auto-Restart
echo "▶ Installing systemd service 'raftpages.service'..."
cat <<EOF > /etc/systemd/system/raftpages.service
[Unit]
Description=RaftPages Production Service
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$PROD_DIR/backend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=4000
Environment=DB_PATH=$DATA_DIR/runbook.db
Environment=GCS_PROJECT_ID=runbook-86573
Environment=GCS_LOCATION=US
StandardOutput=append:$LOG_DIR/backend-out.log
StandardError=append:$LOG_DIR/backend-err.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable raftpages.service
systemctl restart raftpages.service

# 5. Create Nginx Site Configuration
echo "▶ Configuring Nginx for $DOMAIN..."
cat <<EOF > /etc/nginx/sites-available/$DOMAIN
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;

    client_max_body_size 200M;

    root $PROD_DIR/dist;
    index index.html;

    # Frontend Single Page App Router
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Backend API Proxy
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

echo "======================================================"
echo "✅ Production setup complete!"
echo "▶ Service Status: sudo systemctl status raftpages"
echo "▶ Next Step: Point DNS A-record to this VM and run:"
echo "   sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN"
echo "======================================================"

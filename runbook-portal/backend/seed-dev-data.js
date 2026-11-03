// seed-dev-data.js — Seed dummy users, folders, runbooks, and work logs for testing
const Database = require("better-sqlite3");
const path = require("path");

const dbPath = process.env.DB_PATH || path.join(__dirname, "../data/runbook.db");
console.log(`🌱 Seeding dummy data into database: ${dbPath}`);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Ensure Tables Exist
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firebase_uid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  bucket_name TEXT,
  team_name TEXT,
  sub_team TEXT,
  data_residency_region TEXT DEFAULT 'EU (europe-west1) - GDPR Compliant',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (key, owner_id, shared)
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

try { db.exec("ALTER TABLE users ADD COLUMN sub_team TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN data_residency_region TEXT DEFAULT 'EU (europe-west1) - GDPR Compliant'"); } catch {}

// 1. Insert Dummy Users
const insertUser = db.prepare(`
  INSERT INTO users (firebase_uid, name, email, role, team_name, sub_team, data_residency_region)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(email) DO UPDATE SET name=excluded.name, role=excluded.role, team_name=excluded.team_name, sub_team=excluded.sub_team, data_residency_region=excluded.data_residency_region
`);

insertUser.run("dev-admin-uid-101", "Alex Rivers (Admin)", "dev-admin@chorus.lan", "admin", "Chorus Engineering", "Platform Infrastructure", "EU (europe-west1) - GDPR Compliant");
insertUser.run("dev-engineer-uid-102", "Sarah Chen (Cloud Engineer)", "sarah.chen@chorus.lan", "editor", "Chorus Engineering", "Cloud & Site Reliability", "EU (europe-west1) - GDPR Compliant");
insertUser.run("dev-viewer-uid-103", "David Kim (DevOps Intern)", "david.kim@chorus.lan", "viewer", "Chorus Engineering", "Developer Experience", "EU (europe-west1) - GDPR Compliant");

const adminUser = db.prepare("SELECT id FROM users WHERE email = ?").get("dev-admin@chorus.lan");
const adminId = adminUser.id;

console.log("✅ Seeded 3 dummy users (Admin: Alex Rivers, Editor: Sarah Chen, Viewer: David Kim)");

// 2. Dummy Runbook Folders
const sampleFolders = [
  { id: "f-cloud", name: "Cloud & Infrastructure", color: "#6366F1" },
  { id: "f-incidents", name: "Incident Response", color: "#EF4444" },
  { id: "f-databases", name: "Databases & Storage", color: "#10B981" }
];

// 3. Dummy Runbook Pages
const samplePages = [
  {
    id: "p-k8s-autoscale",
    title: "Kubernetes Cluster Auto-Scaling & Node Recovery Runbook",
    folderId: "f-cloud",
    status: "reviewed",
    updatedAt: new Date(Date.now() - 3600000 * 2).toISOString(),
    content: `# Kubernetes Cluster Auto-Scaling & Node Recovery

> **Target Audience**: Cloud Engineers, SREs, On-Call Engineers  
> **Severity**: High (P2)

---

### 1. Verification Steps
When node utilization exceeds 85%, verify cluster autoscaler logs:

\`\`\`bash
kubectl get nodes -o wide
kubectl get pods -n kube-system -l app=cluster-autoscaler
kubectl logs -n kube-system -l app=cluster-autoscaler --tail=50
\`\`\`

### 2. Manual Node Group Drain & Failover
If a worker node enters \`NotReady\` state:

1. Cord mark the problematic node:
   \`\`\`bash
   kubectl cordon node-prod-worker-04
   \`\`\`

2. Drain existing workloads safely:
   \`\`\`bash
   kubectl drain node-prod-worker-04 --ignore-daemonsets --delete-emptydir-data --grace-period=30
   \`\`\`

3. Replace node in AWS / GCP Auto-Scaling Group:
   \`\`\`bash
   gcloud compute instance-groups managed recreate-instances ig-k8s-workers --instances=node-prod-worker-04
   \`\`\`
`
  },
  {
    id: "p-postgres-failover",
    title: "PostgreSQL High-Availability Failover & Backup Restoration",
    folderId: "f-databases",
    status: "reviewed",
    updatedAt: new Date(Date.now() - 3600000 * 24).toISOString(),
    content: `# PostgreSQL HA Failover & WAL Restoration

> **Primary Cluster**: \`pg-prod-db-01.chorus.lan\`  
> **Standby Cluster**: \`pg-prod-db-02.chorus.lan\`

---

### 1. Check Replication Lag
Execute on the standby node to verify replication status:

\`\`\`sql
SELECT 
    client_addr, 
    application_name, 
    state, 
    sync_state, 
    pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes
FROM pg_stat_replication;
\`\`\`

### 2. Trigger Manual Failover
In case of primary node failure, promote standby using Patroni / repmgr:

\`\`\`bash
# Promote standby to primary
sudo -u postgres patronictl -c /etc/patroni/postgres.yml switchover
\`\`\`
`
  },
  {
    id: "p-nginx-ssl",
    title: "Nginx Reverse Proxy Maintenance & Let's Encrypt SSL",
    folderId: "f-cloud",
    status: "draft",
    updatedAt: new Date(Date.now() - 3600000 * 48).toISOString(),
    content: `# Nginx SSL Maintenance & High Availability

---

### 1. Reload Nginx Configuration
Always run syntax check before reloading live traffic:

\`\`\`bash
sudo nginx -t && sudo systemctl reload nginx
\`\`\`

### 2. Certbot SSL Certificate Renewal
\`\`\`bash
sudo certbot renew --dry-run
\`\`\`
`
  }
];

// 4. Dummy Work Logs
const sampleWorkLogs = [
  {
    id: "wl-101",
    date: new Date().toISOString().split("T")[0],
    time: "10:30 AM",
    title: "Deployed RaftPages v1.2 to RHEL 8 Staging Server",
    category: "Deployment",
    details: "Successfully configured Nginx reverse proxy on port 8080 and enabled SELinux policy rules."
  },
  {
    id: "wl-102",
    date: new Date(Date.now() - 86400000).toISOString().split("T")[0],
    time: "02:15 PM",
    title: "Optimized SQLite WAL checkpoint settings",
    category: "Database",
    details: "Updated wal_autocheckpoint threshold to 256 pages (~1MB) for seamless concurrent read/writes."
  }
];

// Save into KV Table
const insertKV = db.prepare(`
  INSERT INTO kv (key, owner_id, shared, value, updated_at)
  VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key, owner_id, shared) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
`);

// Seed both personal (shared=0) and team (shared=1) keys
insertKV.run("runbook:folders", adminId, 0, JSON.stringify(sampleFolders));
insertKV.run("runbook:pages", adminId, 0, JSON.stringify(samplePages));
insertKV.run("worklog:entries", adminId, 0, JSON.stringify(sampleWorkLogs));

insertKV.run("team:Chorus Engineering:runbook:folders", 0, 1, JSON.stringify(sampleFolders));
insertKV.run("team:Chorus Engineering:runbook:pages", 0, 1, JSON.stringify(samplePages));

console.log("✅ Seeded 3 sample folders, 3 sample runbooks, and 2 work log entries!");
console.log("🎉 Database seeding complete!");

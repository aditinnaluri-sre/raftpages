const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const admin = require("firebase-admin");
const { Storage } = require("@google-cloud/storage");

// Auto-load .env configuration if present (Node.js v20+ process.loadEnvFile)
try {
  const rootEnv = path.resolve(__dirname, "../.env");
  const backendEnv = path.resolve(__dirname, ".env");
  if (fs.existsSync(rootEnv)) {
    process.loadEnvFile(rootEnv);
  } else if (fs.existsSync(backendEnv)) {
    process.loadEnvFile(backendEnv);
  }
} catch (e) {
  // process.loadEnvFile fallback ignore if file missing or parse error
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const PORT = process.env.PORT || 4000;
const SHARED_OWNER = 0; // sentinel owner_id used for team/shared rows
const MAX_FILE_MB = 200;

// Storage quotas (free tier): individual users get 1GB, teams share a 5GB
// pool across up to 5 members. Counted = uploaded files (GCS) + page/work
// log text (SQLite). Override via env without code changes if a specific
// deployment ever needs different limits.
const USER_QUOTA_MB = Number(process.env.USER_QUOTA_MB) || 1024;
const TEAM_QUOTA_MB = Number(process.env.TEAM_QUOTA_MB) || 5120;
const TEAM_MEMBER_LIMIT = Number(process.env.TEAM_MEMBER_LIMIT) || 5;
const QUOTA_WARN_RATIO = 0.8;

// Every user gets their own dedicated GCS bucket (created lazily, on their
// first upload). Bucket names must be globally unique across all of GCP, so
// we prefix with your project ID. See README for required setup + IAM.
const GCS_PROJECT_ID = process.env.GCS_PROJECT_ID; // e.g. runbook-86573
const GCS_LOCATION = process.env.GCS_LOCATION || "US";

// ---------- Firebase Admin ----------
// Requires GOOGLE_APPLICATION_CREDENTIALS env var pointing at your
// Firebase service account JSON (see README for how to get one).
try {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
} catch (err) {
  console.warn("⚠️ Firebase Admin initialization bypassed in dev mode:", err.message);
}

let gcs = null;
try {
  gcs = new Storage();
} catch (err) {
  console.warn("⚠️ GCS Storage initialization bypassed in dev mode:", err.message);
}

if (!GCS_PROJECT_ID) {
  console.warn("⚠️  GCS_PROJECT_ID not set — per-user file storage will be disabled until it is.");
}

function sanitizeBucketName(raw) {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

// Roadmap: when team spaces are added, this can grow a parallel
// ensureTeamBucket(teamId) using the same pattern — one bucket per team
// instead of per user, reusing sanitizeBucketName + the same create logic.
async function ensureUserBucket(user) {
  if (!gcs) {
    throw new Error("GCS Storage is not initialized on this dev server.");
  }
  if (!user.firebase_uid) {
    throw new Error(`ensureUserBucket called without firebase_uid for user id=${user.id} — refusing to create a misnamed bucket`);
  }
  const existing = db.prepare("SELECT bucket_name FROM users WHERE id = ?").get(user.id);
  if (existing?.bucket_name) return gcs.bucket(existing.bucket_name);

  const name = sanitizeBucketName(`${GCS_PROJECT_ID}-u-${user.firebase_uid}`);
  const bucket = gcs.bucket(name);
  const [exists] = await bucket.exists();
  if (!exists) {
    await gcs.createBucket(name, {
      location: GCS_LOCATION,
      storageClass: "STANDARD",
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
      publicAccessPrevention: "enforced",
    });
  }
  db.prepare("UPDATE users SET bucket_name = ? WHERE id = ?").run(name, user.id);
  return bucket;
}

// ---------- DB ----------
const dbPath = process.env.DB_PATH || path.join(__dirname, "runbook.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("wal_autocheckpoint = 256"); // Auto-checkpoint when WAL log hits ~1MB (256 pages * 4KB)

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firebase_uid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  bucket_name TEXT,
  team_name TEXT,
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
CREATE TABLE IF NOT EXISTS pending_invites (
  email TEXT PRIMARY KEY,
  team_name TEXT NOT NULL,
  invited_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

try { db.exec("ALTER TABLE users ADD COLUMN sub_team TEXT"); } catch { }
try { db.exec("ALTER TABLE users ADD COLUMN data_residency_region TEXT DEFAULT 'EU (europe-west1) - GDPR Compliant'"); } catch { }

// Migration: existing deployments' users table won't have these columns yet.
const userColumns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userColumns.includes("bucket_name")) {
  db.exec("ALTER TABLE users ADD COLUMN bucket_name TEXT");
}
if (!userColumns.includes("team_name")) {
  db.exec("ALTER TABLE users ADD COLUMN team_name TEXT");
}

// One-time cleanup: an earlier bug meant req.user.firebase_uid was undefined
// when naming buckets, so everyone got funneled into one shared
// "...-u-undefined" bucket. Reset that so each user gets a correctly-named,
// actually-isolated bucket next time they upload something.
db.prepare("UPDATE users SET bucket_name = NULL WHERE bucket_name LIKE '%-u-undefined'").run();

const getUserByUid = db.prepare("SELECT * FROM users WHERE firebase_uid = ?");
const getUserByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
const insertUser = db.prepare(
  "INSERT INTO users (firebase_uid, name, email, role, team_name) VALUES (?,?,?,?,?)"
);
const userCount = db.prepare("SELECT COUNT(*) as c FROM users");
const getPendingInvite = db.prepare("SELECT * FROM pending_invites WHERE email = ?");
const deletePendingInvite = db.prepare("DELETE FROM pending_invites WHERE email = ?");

// Verifies the Firebase ID token, then finds-or-creates the matching local
// user row. New accounts: consume a pending invite if one exists for this
// email (join that team as editor); otherwise the first person ever to sign
// in becomes admin, everyone else starts as an individual user (no team).
// Does NOT enforce email verification — callers decide whether that matters.
async function resolveUser(req) {
  const header = req.headers.authorization || "";
  const idToken = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!idToken) return { error: [401, "Missing token"] };

  // Dev Token fallback for local development without Firebase (disabled in production)
  if (process.env.NODE_ENV !== "production" && idToken.startsWith("dev-token:")) {
    const email = idToken.slice("dev-token:".length).toLowerCase().trim();
    if (!email) return { error: [401, "Invalid dev token email"] };

    let user = getUserByEmail.get(email);
    if (!user) {
      const invite = getPendingInvite.get(email);
      const role = invite ? "editor" : (userCount.get().c === 0 ? "admin" : "viewer");
      const team_name = invite ? invite.team_name : "Chorus Engineering";
      const name = email.split("@")[0].replace(/[._]/g, " ");
      const uid = "dev-uid-" + email.replace(/[^a-z0-9]/g, "-");
      const info = insertUser.run(uid, name, email, role, team_name);
      if (invite) deletePendingInvite.run(email);
      user = { id: info.lastInsertRowid, firebase_uid: uid, name, email, role, team_name };
    }
    const decoded = { email, email_verified: true, uid: user.firebase_uid, name: user.name };
    return {
      decoded,
      user: { id: user.id, firebase_uid: user.firebase_uid, name: user.name, email: user.email, role: user.role, team_name: user.team_name },
    };
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch {
    return { error: [401, "Invalid or expired token"] };
  }

  const email = (decoded.email || "").toLowerCase();
  if (!email) return { error: [401, "Account has no email"] };

  let user = getUserByUid.get(decoded.uid);
  if (!user) {
    // link by email in case they previously signed in with a different provider
    user = getUserByEmail.get(email);
    if (!user) {
      const invite = getPendingInvite.get(email);
      const role = invite ? "editor" : (userCount.get().c === 0 ? "admin" : "viewer");
      const team_name = invite ? invite.team_name : null;
      const name = decoded.name || email.split("@")[0];
      const info = insertUser.run(decoded.uid, name, email, role, team_name);
      if (invite) deletePendingInvite.run(email);
      user = { id: info.lastInsertRowid, firebase_uid: decoded.uid, name, email, role, team_name };
    }
  }

  return {
    decoded,
    user: { id: user.id, firebase_uid: user.firebase_uid, name: user.name, email: user.email, role: user.role, team_name: user.team_name },
  };
}

// Strict: requires a verified email. Use for everything that touches app data.
async function authMiddleware(req, res, next) {
  const { error, decoded, user } = await resolveUser(req);
  if (error) return res.status(error[0]).json({ error: error[1] });
  if (!decoded.email_verified) {
    return res.status(403).json({ error: "Email not verified", code: "EMAIL_NOT_VERIFIED" });
  }
  req.user = user;
  next();
}

// Lenient: allows unverified accounts through. Use ONLY for the profile-setup
// step right after sign-up, before the user has had a chance to verify yet.
async function authMiddlewareAllowUnverified(req, res, next) {
  const { error, user } = await resolveUser(req);
  if (error) return res.status(error[0]).json({ error: error[1] });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

// ---------- storage usage / quotas ----------
// Usage = uploaded file bytes (files table mirrors what's in GCS) + page and
// work-log text bytes (kv table). Team members draw from one pooled team
// quota; individual users have their own.
function computeUsage(user) {
  let ownerIds;
  let quotaBytes;
  if (user.team_name) {
    ownerIds = db.prepare("SELECT id FROM users WHERE team_name = ?").all(user.team_name).map((r) => r.id);
    quotaBytes = TEAM_QUOTA_MB * 1024 * 1024;
  } else {
    ownerIds = [user.id];
    quotaBytes = USER_QUOTA_MB * 1024 * 1024;
  }
  const marks = ownerIds.map(() => "?").join(",");
  const fileBytes = db.prepare(`SELECT COALESCE(SUM(size),0) AS s FROM files WHERE owner_id IN (${marks})`).get(...ownerIds).s;
  let textBytes = db.prepare(`SELECT COALESCE(SUM(LENGTH(value)),0) AS s FROM kv WHERE owner_id IN (${marks}) AND shared = 0`).get(...ownerIds).s;
  if (user.team_name) {
    // team-space pages/folders live under shared rows with a team prefix
    textBytes += db.prepare("SELECT COALESCE(SUM(LENGTH(value)),0) AS s FROM kv WHERE shared = 1 AND key LIKE ?").get(`team:${user.team_name}:%`).s;
  }
  return { usedBytes: fileBytes + textBytes, quotaBytes };
}

// ---------- current user ----------
app.get("/api/auth/me", authMiddleware, (req, res) => {
  // Quota tracking is silent until the 80% threshold. The warning is only
  // ever attached for the right audience: the team's admin (never plain
  // members), or an individual user about their own usage.
  let storage = null;
  const shouldSee = req.user.team_name ? req.user.role === "admin" : true;
  if (shouldSee) {
    const { usedBytes, quotaBytes } = computeUsage(req.user);
    if (usedBytes >= quotaBytes * QUOTA_WARN_RATIO) {
      storage = {
        usedBytes,
        quotaBytes,
        pct: Math.min(100, Math.round((usedBytes / quotaBytes) * 100)),
        scope: req.user.team_name ? "team" : "user",
      };
    }
  }
  res.json({ user: req.user, storage });
});

// Called right after password sign-up to save the name they typed and their
// company/team name. Google/magic-link users don't call this — they're
// auto-created with just a name derived from their account, no team_name yet.
//
// If someone provides a company name for the first time and isn't already
// admin, they become admin — they're the one establishing that team/company
// space, so they naturally own it. Leaving it blank keeps them a plain
// individual user.
app.post("/api/auth/complete-profile", authMiddlewareAllowUnverified, (req, res) => {
  const { name, teamName, subTeam, dataResidencyRegion } = req.body || {};
  const trimmedName = (name || "").trim();
  const trimmedTeam = (teamName || "").trim();
  const trimmedSubTeam = (subTeam || "").trim();
  const trimmedRegion = (dataResidencyRegion || "").trim();

  const before = db.prepare("SELECT role, team_name FROM users WHERE id = ?").get(req.user.id);

  if (trimmedName) db.prepare("UPDATE users SET name = ? WHERE id = ?").run(trimmedName, req.user.id);
  if (trimmedTeam) db.prepare("UPDATE users SET team_name = ? WHERE id = ?").run(trimmedTeam, req.user.id);
  if (trimmedSubTeam) db.prepare("UPDATE users SET sub_team = ? WHERE id = ?").run(trimmedSubTeam, req.user.id);
  if (trimmedRegion) {
    db.prepare("UPDATE users SET data_residency_region = ? WHERE id = ?").run(trimmedRegion, req.user.id);
    if (trimmedTeam) {
      db.prepare("UPDATE users SET data_residency_region = ? WHERE team_name = ?").run(trimmedRegion, trimmedTeam);
    }
  }

  if (trimmedTeam && !before.team_name && before.role !== "admin") {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(req.user.id);
  }

  const row = db.prepare("SELECT id, name, email, role, team_name, sub_team, data_residency_region FROM users WHERE id = ?").get(req.user.id);
  res.json({ user: row });
});

app.post("/api/auth/profile", authMiddleware, (req, res) => {
  const { subTeam, dataResidencyRegion } = req.body || {};
  const trimmedSubTeam = (subTeam || "").trim();
  const trimmedRegion = (dataResidencyRegion || "").trim();

  if (trimmedSubTeam) db.prepare("UPDATE users SET sub_team = ? WHERE id = ?").run(trimmedSubTeam, req.user.id);
  if (trimmedRegion && req.user.role === "admin" && req.user.team_name) {
    db.prepare("UPDATE users SET data_residency_region = ? WHERE team_name = ?").run(trimmedRegion, req.user.team_name);
  } else if (trimmedRegion) {
    db.prepare("UPDATE users SET data_residency_region = ? WHERE id = ?").run(trimmedRegion, req.user.id);
  }

  const row = db.prepare("SELECT id, name, email, role, team_name, sub_team, data_residency_region FROM users WHERE id = ?").get(req.user.id);
  res.json({ user: row });
});

// ---------- team management (admin only) ----------
// Everything here is scoped to the requesting admin's own team_name — an
// admin only ever sees, edits, or deletes members of their own team, never
// other teams, and never plain individual users who aren't on any team.
app.get("/api/users", authMiddleware, requireAdmin, (req, res) => {
  const rows = req.user.team_name
    ? db.prepare("SELECT id, name, email, role, team_name FROM users WHERE id = ? OR team_name = ? ORDER BY name")
      .all(req.user.id, req.user.team_name)
    : db.prepare("SELECT id, name, email, role, team_name FROM users WHERE id = ?").all(req.user.id);
  res.json({ users: rows });
});

// Team storage breakdown — admin only
app.get("/api/team/storage", authMiddleware, requireAdmin, (req, res) => {
  if (!req.user.team_name) return res.json({ error: "No team" });

  const members = db.prepare(
    "SELECT id, name, email, role, sub_team FROM users WHERE team_name = ? OR id = ?"
  ).all(req.user.team_name, req.user.id);

  const quotaBytes = TEAM_QUOTA_MB * 1024 * 1024;

  // Shared team assets (pages, folders stored in kv with shared=1)
  const sharedTextBytes = db.prepare(
    "SELECT COALESCE(SUM(LENGTH(value)),0) AS s FROM kv WHERE shared = 1 AND key LIKE ?"
  ).get(`team:${req.user.team_name}:%`).s;

  // Per-member breakdown
  const memberStats = members.map((m) => {
    const fileBytes = db.prepare(
      "SELECT COALESCE(SUM(size),0) AS s FROM files WHERE owner_id = ?"
    ).get(m.id).s;
    const textBytes = db.prepare(
      "SELECT COALESCE(SUM(LENGTH(value)),0) AS s FROM kv WHERE owner_id = ? AND shared = 0"
    ).get(m.id).s;
    return { ...m, usedBytes: fileBytes + textBytes };
  });

  // Sub-team grouping
  const subTeamMap = {};
  for (const m of memberStats) {
    const key = m.sub_team || "Unassigned";
    if (!subTeamMap[key]) subTeamMap[key] = { name: key, memberCount: 0, usedBytes: 0, members: [] };
    subTeamMap[key].memberCount++;
    subTeamMap[key].usedBytes += m.usedBytes;
    subTeamMap[key].members.push({ id: m.id, name: m.name, email: m.email, role: m.role, usedBytes: m.usedBytes });
  }

  const totalMemberBytes = memberStats.reduce((acc, m) => acc + m.usedBytes, 0);
  const totalUsedBytes = totalMemberBytes + sharedTextBytes;

  res.json({
    quotaBytes,
    totalUsedBytes,
    sharedTeamBytes: sharedTextBytes,
    memberCount: members.length,
    subTeams: Object.values(subTeamMap).sort((a, b) => b.usedBytes - a.usedBytes),
    members: memberStats.sort((a, b) => b.usedBytes - a.usedBytes),
  });
});

app.post("/api/invite", authMiddleware, requireAdmin, (req, res) => {
  if (!req.user.team_name) {
    return res.status(400).json({ error: "Set a company/team name for your own account before inviting others" });
  }
  const email = (req.body?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Email required" });
  const existing = getUserByEmail.get(email);
  if (existing) return res.status(409).json({ error: "That person already has an account" });

  // Free tier: up to TEAM_MEMBER_LIMIT people per team, counting both
  // current members and invites that haven't been accepted yet.
  const memberCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE team_name = ?").get(req.user.team_name).c;
  const pendingCount = db.prepare("SELECT COUNT(*) AS c FROM pending_invites WHERE team_name = ? AND email != ?").get(req.user.team_name, email).c;
  if (memberCount + pendingCount >= TEAM_MEMBER_LIMIT) {
    return res.status(400).json({ error: `The free plan supports up to ${TEAM_MEMBER_LIMIT} team members (including pending invites). Remove a member or cancel an invite first.` });
  }

  db.prepare(
    `INSERT INTO pending_invites (email, team_name, invited_by) VALUES (?,?,?)
     ON CONFLICT(email) DO UPDATE SET team_name = excluded.team_name, invited_by = excluded.invited_by`
  ).run(email, req.user.team_name, req.user.id);
  res.json({ ok: true });
});

app.patch("/api/users/:id", authMiddleware, requireAdmin, (req, res) => {
  const { role } = req.body || {};
  if (!["admin", "editor", "viewer"].includes(role)) {
    return res.status(400).json({ error: "Role must be admin, editor, or viewer" });
  }
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.id !== req.user.id && (!req.user.team_name || target.team_name !== req.user.team_name)) {
    return res.status(403).json({ error: "That person isn't on your team" });
  }
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/users/:id", authMiddleware, requireAdmin, async (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account from here" });
  }
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (!req.user.team_name || target.team_name !== req.user.team_name) {
    return res.status(403).json({ error: "That person isn't on your team" });
  }

  // 1. their private app data (pages, work log — kv rows scoped to them)
  db.prepare("DELETE FROM kv WHERE owner_id = ? AND shared = 0").run(targetId);
  db.prepare("DELETE FROM files WHERE owner_id = ?").run(targetId);

  // 2. their Cloud Storage bucket, if one was ever created
  let bucketWarning = null;
  if (target.bucket_name) {
    try {
      const bucket = gcs.bucket(target.bucket_name);
      const [exists] = await bucket.exists();
      if (exists) {
        await bucket.deleteFiles({ force: true });
        await bucket.delete();
      }
    } catch (err) {
      console.error("Bucket cleanup failed for", target.bucket_name, err.message);
      bucketWarning = "User removed, but their storage bucket couldn't be fully cleaned up — check GCS manually.";
    }
  }

  // 3. their Firebase Auth account, so they can't just sign back in
  try {
    await admin.auth().deleteUser(target.firebase_uid);
  } catch (err) {
    console.error("Firebase Auth delete failed for", target.email, err.message);
  }

  // 4. the user row itself
  db.prepare("DELETE FROM users WHERE id = ?").run(targetId);

  res.json({ ok: true, warning: bucketWarning });
});

// ---------- file attachments (stored in Cloud Storage, not local disk) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

const insertFile = db.prepare(
  "INSERT INTO files (id, owner_id, original_name, size, mime) VALUES (?,?,?,?,?)"
);
const getFile = db.prepare("SELECT * FROM files WHERE id = ?");
const gcsPathFor = (fileId) => `uploads/${fileId}`; // bucket itself is already per-user, no owner prefix needed

app.post("/api/upload", authMiddleware, upload.single("file"), async (req, res) => {
  if (!GCS_PROJECT_ID) return res.status(500).json({ error: "File storage isn't configured (GCS_PROJECT_ID missing on the server)" });
  if (!req.file) return res.status(400).json({ error: "No file received" });

  // Quota enforcement — the free tier is a hard cap: reject any upload that
  // would push total usage (files + page text) past the limit.
  const { usedBytes, quotaBytes } = computeUsage(req.user);
  if (usedBytes + req.file.size > quotaBytes) {
    const gb = (quotaBytes / (1024 * 1024 * 1024)).toFixed(0);
    const msg = req.user.team_name
      ? `Your team's ${gb}GB storage limit has been reached. Free up space by deleting old attachments, or contact your team admin.`
      : `Your ${gb}GB storage limit has been reached. Free up space by deleting old attachments.`;
    return res.status(413).json({ error: msg });
  }

  const id = crypto.randomUUID();
  try {
    const bucket = await ensureUserBucket(req.user);
    await bucket.file(gcsPathFor(id)).save(req.file.buffer, {
      contentType: req.file.mimetype || "application/octet-stream",
      resumable: false,
    });
  } catch (err) {
    console.error("GCS upload failed:", err.message);
    return res.status(502).json({ error: "Upload to cloud storage failed — check server logs (often an IAM permissions issue on first bucket creation)" });
  }

  insertFile.run(id, req.user.id, req.file.originalname, req.file.size, req.file.mimetype || "");
  res.json({ id, name: req.file.originalname, size: req.file.size, mime: req.file.mimetype });
});

app.get("/api/files/:id", authMiddleware, async (req, res) => {
  if (!GCS_PROJECT_ID) return res.status(500).json({ error: "File storage isn't configured (GCS_PROJECT_ID missing on the server)" });
  const file = getFile.get(req.params.id);
  if (!file) return res.status(404).json({ error: "Not found" });

  // Owner can always read their file. Teammates can too — attachments on
  // team-space pages live in the uploader's bucket, so the read has to go
  // through the OWNER's bucket, not the requester's. Deletion remains
  // owner-only.
  let bucketUser = req.user;
  if (file.owner_id !== req.user.id) {
    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(file.owner_id);
    const sameTeam = owner && owner.team_name && req.user.team_name && owner.team_name === req.user.team_name;
    if (!sameTeam) return res.status(403).json({ error: "Not yours" });
    bucketUser = owner;
  }

  const bucket = await ensureUserBucket(bucketUser);
  const gcsFile = bucket.file(gcsPathFor(file.id));
  const [exists] = await gcsFile.exists();
  if (!exists) return res.status(404).json({ error: "File missing in cloud storage" });

  res.setHeader("Content-Disposition", `attachment; filename="${file.original_name.replace(/"/g, "")}"`);
  if (file.mime) res.setHeader("Content-Type", file.mime);
  gcsFile.createReadStream()
    .on("error", (err) => {
      console.error("GCS download failed:", err.message);
      if (!res.headersSent) res.status(502).json({ error: "Download from cloud storage failed" });
    })
    .pipe(res);
});

app.delete("/api/files/:id", authMiddleware, async (req, res) => {
  if (!GCS_PROJECT_ID) return res.status(500).json({ error: "File storage isn't configured (GCS_PROJECT_ID missing on the server)" });
  const file = getFile.get(req.params.id);
  if (!file) return res.status(404).json({ error: "Not found" });
  if (file.owner_id !== req.user.id) return res.status(403).json({ error: "Not yours" });

  try {
    const bucket = await ensureUserBucket(req.user);
    await bucket.file(gcsPathFor(file.id)).delete({ ignoreNotFound: true });
  } catch (err) {
    console.error("GCS delete failed:", err.message);
    return res.status(502).json({ error: "Couldn't delete from cloud storage" });
  }

  db.prepare("DELETE FROM files WHERE id = ?").run(file.id);
  res.json({ id: file.id, deleted: true });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File too large — max ${MAX_FILE_MB}MB` });
  }
  next(err);
});

// ---------- Stripe Billing Integration ----------
function getStripeInstance() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  try {
    return require("stripe")(secretKey);
  } catch (err) {
    console.error("⚠️ Stripe SDK initialization error:", err.message);
    return null;
  }
}

app.post("/api/billing/create-checkout-session", authMiddleware, requireAdmin, async (req, res) => {
  const { gbAmount } = req.body || {};
  const expansionGb = Number(gbAmount) || 100;

  let userCount = 1;
  if (req.user.team_name) {
    userCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE team_name = ?").get(req.user.team_name).c || 1;
  }

  const monthlyCostUsd = expansionGb * 0.25 * userCount;
  const unitAmountCents = Math.round(monthlyCostUsd * 100);

  const stripe = getStripeInstance();

  if (stripe) {
    try {
      const origin = req.headers.origin || "https://raftpages.com";
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "subscription",
        customer_email: req.user.email,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `RaftPages Shared Storage Expansion (+${expansionGb} GB)`,
                description: `Shared Storage Pool for ${userCount} ${userCount === 1 ? "User" : "Users"} ($0.25/GB/mo/user)`,
              },
              unit_amount: unitAmountCents,
              recurring: { interval: "month" },
            },
            quantity: 1,
          },
        ],
        success_url: `${origin}/#/team?payment=success&gb=${expansionGb}`,
        cancel_url: `${origin}/#/team?payment=cancelled`,
      });

      return res.json({ url: session.url, mode: "stripe" });
    } catch (err) {
      console.error("❌ Stripe Session Creation Failed:", err.message);
      return res.status(400).json({ error: `Stripe Checkout Error: ${err.message}` });
    }
  }

  return res.status(400).json({
    error: "Stripe API key (STRIPE_SECRET_KEY) is not configured on the server. Set STRIPE_SECRET_KEY in .env to enable live Stripe Checkout.",
  });
});

// ---------- key/value storage ----------
// Personal rows (shared=false) are scoped to the requesting user. Shared
// rows (shared=true) are the TEAM SPACE: stored under a server-side
// team-namespaced key (client never sees the prefix), so each team only
// ever sees its own shared data. Reads require team membership; writes
// additionally require an editing role (viewers are read-only in the
// team space).
function sharedKeyFor(user, key) {
  return `team:${user.team_name}:${key}`;
}
function requireTeamForShared(req, res) {
  if (!req.user.team_name) {
    res.status(400).json({ error: "You're not on a team — team space is unavailable" });
    return false;
  }
  return true;
}
function requireTeamEditorForShared(req, res) {
  if (!requireTeamForShared(req, res)) return false;
  if (req.user.role === "viewer") {
    res.status(403).json({ error: "You have view-only access to the team space" });
    return false;
  }
  return true;
}

app.get("/api/storage/:key", authMiddleware, (req, res) => {
  const shared = req.query.shared === "true";
  if (shared && !requireTeamForShared(req, res)) return;
  const ownerId = shared ? SHARED_OWNER : req.user.id;
  const storeKey = shared ? sharedKeyFor(req.user, req.params.key) : req.params.key;
  const row = db
    .prepare("SELECT value, updated_at FROM kv WHERE key = ? AND shared = ? AND owner_id = ?")
    .get(storeKey, shared ? 1 : 0, ownerId);
  if (!row) return res.json({ key: req.params.key, value: null, shared, updatedAt: null });
  res.json({ key: req.params.key, value: row.value, shared, updatedAt: row.updated_at });
})

app.put("/api/storage/:key", authMiddleware, (req, res) => {
  const { value, shared } = req.body || {};
  const isShared = !!shared;
  if (isShared && !requireTeamEditorForShared(req, res)) return;
  const ownerId = isShared ? SHARED_OWNER : req.user.id;
  const storeKey = isShared ? sharedKeyFor(req.user, req.params.key) : req.params.key;
  db.prepare(
    `INSERT INTO kv (key, owner_id, shared, value, updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(key, owner_id, shared) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run(storeKey, ownerId, isShared ? 1 : 0, String(value));
  const row = db
    .prepare("SELECT updated_at FROM kv WHERE key = ? AND owner_id = ? AND shared = ?")
    .get(storeKey, ownerId, isShared ? 1 : 0);
  res.json({ key: req.params.key, value, shared: isShared, updatedAt: row?.updated_at });
});

app.delete("/api/storage/:key", authMiddleware, (req, res) => {
  const shared = req.query.shared === "true";
  if (shared && !requireTeamEditorForShared(req, res)) return;
  const ownerId = shared ? SHARED_OWNER : req.user.id;
  const storeKey = shared ? sharedKeyFor(req.user, req.params.key) : req.params.key;
  const info = db
    .prepare("DELETE FROM kv WHERE key = ? AND shared = ? AND owner_id = ?")
    .run(storeKey, shared ? 1 : 0, ownerId);
  res.json({ key: req.params.key, deleted: info.changes > 0, shared });
});

app.get("/api/storage", authMiddleware, (req, res) => {
  const shared = req.query.shared === "true";
  if (shared && !requireTeamForShared(req, res)) return;
  const prefix = req.query.prefix || "";
  const ownerId = shared ? SHARED_OWNER : req.user.id;
  const storePrefix = shared ? sharedKeyFor(req.user, prefix) : prefix;
  const strip = shared ? `team:${req.user.team_name}:`.length : 0;
  const rows = db
    .prepare("SELECT key FROM kv WHERE shared = ? AND owner_id = ? AND key LIKE ?")
    .all(shared ? 1 : 0, ownerId, storePrefix + "%");
  res.json({ keys: rows.map((r) => r.key.slice(strip)), prefix, shared });
});

// ---------- Real-time Presence & Sync Detection ----------
// In-memory presence map: pageId -> Map(userId -> { id, name, email, status, lastSeen })
const pagePresence = new Map();
const PRESENCE_TIMEOUT_MS = 15000; // 15 seconds without a heartbeat marks user inactive

function prunePresence(pageId) {
  const now = Date.now();
  if (pageId) {
    const usersMap = pagePresence.get(pageId);
    if (usersMap) {
      for (const [userId, info] of usersMap.entries()) {
        if (now - info.lastSeen > PRESENCE_TIMEOUT_MS) {
          usersMap.delete(userId);
        }
      }
      if (usersMap.size === 0) pagePresence.delete(pageId);
    }
  } else {
    for (const [pId, usersMap] of pagePresence.entries()) {
      for (const [userId, info] of usersMap.entries()) {
        if (now - info.lastSeen > PRESENCE_TIMEOUT_MS) {
          usersMap.delete(userId);
        }
      }
      if (usersMap.size === 0) pagePresence.delete(pId);
    }
  }
}

// Background cleanup every 30 seconds
setInterval(() => prunePresence(), 30000);

// Heartbeat endpoint: records presence and returns active users + lastModified timestamp
app.post("/api/presence/heartbeat", authMiddleware, (req, res) => {
  const { pageId, space, status = "viewing" } = req.body || {};
  if (!pageId) {
    return res.status(400).json({ error: "pageId is required" });
  }

  if (!pagePresence.has(pageId)) {
    pagePresence.set(pageId, new Map());
  }
  const usersMap = pagePresence.get(pageId);
  usersMap.set(req.user.id, {
    id: req.user.id,
    name: req.user.name || req.user.email.split("@")[0],
    email: req.user.email,
    status: status === "editing" ? "editing" : "viewing",
    lastSeen: Date.now(),
  });

  prunePresence(pageId);

  const activeUsers = Array.from(usersMap.values()).map(({ id, name, email, status }) => ({
    id,
    name,
    email,
    status,
  }));

  // Fetch updated_at timestamp of runbook_pages to allow sync detection
  const isShared = space === "team";
  const ownerId = isShared ? SHARED_OWNER : req.user.id;
  const storeKey = isShared && req.user.team_name ? sharedKeyFor(req.user, "runbook_pages") : "runbook_pages";

  const kvRow = db
    .prepare("SELECT updated_at FROM kv WHERE key = ? AND shared = ? AND owner_id = ?")
    .get(storeKey, isShared ? 1 : 0, ownerId);

  res.json({
    pageId,
    activeUsers,
    pagesUpdatedAt: kvRow?.updated_at || null,
  });
});

// Explicit leave endpoint (called on page navigate or tab close)
app.post("/api/presence/leave", authMiddleware, (req, res) => {
  const { pageId } = req.body || {};
  if (pageId && pagePresence.has(pageId)) {
    pagePresence.get(pageId).delete(req.user.id);
    if (pagePresence.get(pageId).size === 0) {
      pagePresence.delete(pageId);
    }
  }
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Runbook backend listening on :${PORT}`));

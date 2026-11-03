# Runbook Portal

A Confluence-style runbook portal: shared team pages + a private work log per person, real accounts via Google sign-in or magic-link email, with roles (admin / editor / viewer).

- `backend/` — Express + SQLite API (roles, storage). Verifies identity using Firebase.
- `src/` — React frontend (Vite). Handles Google sign-in and magic-link email via Firebase.

## 1. Set up Firebase (one-time, in the browser)

1. Go to https://console.firebase.google.com → **Add project** (free tier is enough).
2. In the project, go to **Build → Authentication → Get started**.
3. Under **Sign-in method**, enable:
   - **Google**
   - **Email/Password** → toggle on **Email link (passwordless sign-in)** specifically (not the plain password option).
4. Go to **Project settings → General → Your apps → Add app → Web (</>)**. Register it (no hosting needed). Copy the `firebaseConfig` values — you'll need `apiKey`, `authDomain`, `projectId`, `appId`.
5. Go to **Project settings → Service accounts → Generate new private key**. This downloads a JSON file — the backend uses it to verify tokens. Keep it secret, never commit it.
6. Under **Authentication → Settings → Authorized domains**, add the domain your frontend will actually be served from (e.g. your Debian server's domain, or `localhost` for testing).
7. **File attachments use one dedicated Cloud Storage bucket per user**, created automatically the first time each person uploads something — no manual bucket setup needed. Two things this requires:
   - Go to **Google Cloud Console** (console.cloud.google.com) → select your Firebase project → **IAM & Admin → IAM**. Find your service account (the one from step 5, usually `firebase-adminsdk-...@your-project.iam.gserviceaccount.com`) and make sure it has the **Storage Admin** role — this is what lets it *create* new buckets, not just read/write to existing ones. It often already has this via the default "Editor" role; check first.
   - Note your **Project ID** (shown on the Firebase project settings page, e.g. `runbook-86573`) — you'll set this as `GCS_PROJECT_ID` below.

## 2. Configure the project

In the project root, copy `.env.example` to `.env.production` and fill in the values from step 1.4, plus your backend's real address:
```
VITE_API_BASE=https://your-domain-or-ip:4000
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=...
```

## 3. Run the backend (Debian)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

cd backend
npm install
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/your-service-account.json
export GCS_PROJECT_ID=your-project-id
PORT=4000 node server.js
```
This creates `runbook.db` (SQLite, for pages/roles/metadata) on first run — back it up. Each person's file attachments live in their own Cloud Storage bucket (named `your-project-id-u-<their-firebase-id>`), created the first time they upload something.

To keep it running permanently, create `/etc/systemd/system/runbook-backend.service`:
```ini
[Unit]
Description=Runbook Portal backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/runbook-portal/backend
Environment=PORT=4000
Environment=GOOGLE_APPLICATION_CREDENTIALS=/path/to/your-service-account.json
Environment=GCS_PROJECT_ID=your-project-id
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now runbook-backend
```

## 4. Build and serve the frontend

```bash
npm install
npm run build
sudo apt install -y nginx
sudo cp -r dist/* /var/www/html/
sudo systemctl restart nginx
```

## 5. First sign-in

Visit your site and sign in with Google or a magic-link email. The **first person ever to sign in becomes admin** automatically. Everyone after starts as **viewer**; promote them from the **Team** tab (admin only).

## Notes
- Put both the frontend and backend behind HTTPS before real use (e.g. Nginx reverse proxy + Let's Encrypt, or Caddy). Firebase's sign-in popup and magic links require a secure context in production.
- Pages and work log entries are private per account — each person has their own space, not a shared team wiki.
- **Per-user Cloud Storage buckets**: each account gets its own dedicated bucket, created on first upload. This gives the strongest possible isolation between users, but has real costs worth knowing:
  - GCP soft-caps bucket creation (roughly 1 every couple seconds per project, and a few thousand buckets total before you'd need to request a quota increase from Google) — fine for small/medium teams, worth revisiting if you ever have thousands of users.
  - Your service account needs the broader **Storage Admin** role to create buckets on the fly (see step 1.7) — a bigger blast radius than object-level access if that key is ever compromised.
  - Managing lifecycle rules or billing analysis per-bucket gets harder at scale than with one bucket using per-user folders.
  - **Roadmap**: when team spaces are added, `ensureUserBucket()` in `server.js` is written to be easy to mirror into an `ensureTeamBucket()` — one bucket per team instead of per person.
- Not deciding on hosting yet is fine — Firebase Auth doesn't care where the frontend/backend run, so you can move from Debian to GCP (or anywhere) later without touching auth.

import { getIdToken } from "./firebase.js";

let rawBase = import.meta.env.VITE_API_BASE || "";
if (rawBase.includes("sslip.io")) rawBase = "";
const API_BASE = rawBase;

async function apiFetch(path, opts = {}) {
  const token = await getIdToken();
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${API_BASE}${path}`, { ...opts, headers });
}

export const auth = {
  async me() {
    const res = await apiFetch("/api/auth/me");
    if (!res.ok) return null;
    const data = await res.json();
    // storage is only present when the server decided this person should
    // see a quota warning (>=80% used, and the right audience for it)
    if (data.user && data.storage) data.user.storageWarning = data.storage;
    return data.user;
  },

  async completeProfile({ name, teamName }) {
    const res = await apiFetch("/api/auth/complete-profile", {
      method: "POST",
      body: JSON.stringify({ name, teamName }),
    });
    if (!res.ok) throw new Error("Couldn't save your profile");
    const data = await res.json();
    return data.user;
  },

  async updateProfile({ subTeam, dataResidencyRegion } = {}) {
    const res = await apiFetch("/api/auth/profile", {
      method: "POST",
      body: JSON.stringify({ subTeam, dataResidencyRegion }),
    });
    if (!res.ok) throw new Error("Couldn't update your profile");
    const data = await res.json();
    return data.user;
  },
};

export const team = {
  async list() {
    const res = await apiFetch("/api/users");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load team");
    return data.users;
  },
  async setRole(id, role) {
    const res = await apiFetch(`/api/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Failed to update role");
  },
  async remove(id) {
    const res = await apiFetch(`/api/users/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to delete user");
    return data; // { ok, warning }
  },
  async invite(email) {
    const res = await apiFetch("/api/invite", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to record invite");
    return data;
  },
  async storageStats() {
    const res = await apiFetch("/api/team/storage");
    if (!res.ok) return null;
    return res.json();
  },
};

export const files = {
  async upload(file) {
    const token = await getIdToken();
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_BASE}/api/upload`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
    return data; // { id, name, size, mime }
  },

  async download(id, filename) {
    const res = await apiFetch(`/api/files/${id}`);
    if (!res.ok) throw new Error("Download failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Returns a temporary object URL for inline preview (e.g. <img src>).
  // Caller is responsible for URL.revokeObjectURL(url) when done with it.
  async getObjectUrl(id) {
    const res = await apiFetch(`/api/files/${id}`);
    if (!res.ok) throw new Error("Couldn't load file");
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },

  async remove(id) {
    const res = await apiFetch(`/api/files/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Delete failed");
    return res.json();
  },
};

export const billing = {
  async createCheckoutSession(gbAmount) {
    const res = await apiFetch("/api/billing/create-checkout-session", {
      method: "POST",
      body: JSON.stringify({ gbAmount }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to create Stripe Checkout Session");
    return data; // { url }
  },
};

export const presence = {
  async heartbeat(pageId, space, status = "viewing") {
    try {
      const res = await apiFetch("/api/presence/heartbeat", {
        method: "POST",
        body: JSON.stringify({ pageId, space, status }),
      });
      if (!res.ok) return null;
      return res.json(); // { pageId, activeUsers, pagesUpdatedAt }
    } catch {
      return null;
    }
  },
  async leave(pageId) {
    try {
      await apiFetch("/api/presence/leave", {
        method: "POST",
        body: JSON.stringify({ pageId }),
      });
    } catch { }
  },
};

// Matches the window.storage interface: get/set/delete/list, each with
// an optional `shared` flag. shared=true is team-wide; shared=false (default)
// is private to the signed-in user.
window.storage = {
  async get(key, shared = false) {
    const res = await apiFetch(`/api/storage/${encodeURIComponent(key)}?shared=${shared}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("Storage get failed");
    const data = await res.json();
    if (!data || data.value === null || data.value === undefined) return null;
    return data;
  },
  async set(key, value, shared = false) {
    const res = await apiFetch(`/api/storage/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value, shared }),
    });
    if (!res.ok) return null;
    return res.json();
  },
  async delete(key, shared = false) {
    const res = await apiFetch(`/api/storage/${encodeURIComponent(key)}?shared=${shared}`, {
      method: "DELETE",
    });
    if (!res.ok) return null;
    return res.json();
  },
  async list(prefix = "", shared = false) {
    const res = await apiFetch(`/api/storage?prefix=${encodeURIComponent(prefix)}&shared=${shared}`);
    if (!res.ok) throw new Error("Storage list failed");
    return res.json();
  },
};

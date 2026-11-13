import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Search, Plus, ChevronRight, ChevronDown, ChevronsLeft, ChevronsRight, FileText, Folder,
  Circle, CheckCircle2, AlertTriangle, Clock, Trash2, Edit3,
  Save, X, Users, Shield, Eye, Pencil, User, LogOut, Terminal,
  NotebookPen, Loader2, Bold, Italic, Strikethrough, Underline, Link2, Table2,
  Code, Heading1, Heading2, Heading3, List, ListOrdered, Quote, IndentIncrease, IndentDecrease, Paperclip, Download, FileSpreadsheet, Image as ImageIcon, Mail, RefreshCw,
  Sun, Moon, Monitor, KeyRound, UserX, UserPlus, FilePlus, FolderPlus, FolderInput, Copy, MoreVertical, Link as LinkIcon, ExternalLink, Calendar, Building2,
  MessageSquare, RotateCcw, History, CreditCard, Info, Lock, AtSign, HardDrive
} from "lucide-react";
import { auth, team as teamApi, files as filesApi, billing, presence } from "./api.js";
import { getStoredThemePref, setThemePref } from "./theme.js";
import {
  googleSignIn, sendMagicLink, completeMagicLinkIfPresent, onAuthChange, signOut,
  passwordSignUp, passwordSignIn, friendlyAuthError, resendVerificationEmail, refreshEmailVerified,
  sendPasswordReset, changeUserPassword,
} from "./firebase.js";
import { useEditor, EditorContent, ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent } from "@tiptap/react";
import { Node, Extension, InputRule } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import CodeBlock from "@tiptap/extension-code-block";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Markdown } from "tiptap-markdown";

// ---------- design tokens ----------
const ROLE_META = {
  admin: { label: "Admin", icon: Shield, desc: "Manages team & roles" },
  editor: { label: "Team Member", icon: Users, desc: "Part of a team" },
  viewer: { label: "Individual User", icon: User, desc: "Personal use, not on a team" },
};

const STATUS_META = {
  reviewed: { label: "Reviewed", color: "#3ECF8E", Icon: CheckCircle2 },
  draft: { label: "Draft", color: "#F0A93A", Icon: Clock },
  stale: { label: "Stale", color: "#EF6B6B", Icon: AlertTriangle },
};

const PAGES_KEY = "runbook:pages";
const FOLDERS_KEY = "runbook:folders";
const WORKLOG_KEY = "worklog:entries";
const IDLE_TIMEOUT_MS = 5 * 60 * 60 * 1000; // 5 hours
const IDLE_ACTIVITY_KEY = "runbook_last_activity"; // shared across tabs via localStorage
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const initialsOf = (name) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("");

function RaftPagesLogo({ size = 32, className = "" }) {
  return (
    <svg viewBox="0 0 120 120" fill="none" style={{ width: size, height: size }} className={`flex-shrink-0 rounded-lg shadow-sm ${className}`}>
      <rect width="120" height="120" rx="28" fill="#312E81" />
      <circle cx="44" cy="38" r="10" fill="#8D5B4C" />
      <circle cx="76" cy="38" r="10" fill="#8D5B4C" />
      <circle cx="44" cy="38" r="6" fill="#CBB2A0" />
      <circle cx="76" cy="38" r="6" fill="#CBB2A0" />
      <ellipse cx="60" cy="48" rx="24" ry="20" fill="#A06D5B" />
      <ellipse cx="60" cy="53" rx="15" ry="12" fill="#E8D5C8" />
      <circle cx="51" cy="46" r="3.5" fill="#1E1715" />
      <circle cx="69" cy="46" r="3.5" fill="#1E1715" />
      <circle cx="52.5" cy="44.5" r="1.2" fill="#FFFFFF" />
      <circle cx="70.5" cy="44.5" r="1.2" fill="#FFFFFF" />
      <path d="M57 51 C57 49 63 49 63 51 C63 54 57 54 57 51 Z" fill="#2D1E18" />
      <path d="M57 53 Q60 56 63 53" stroke="#2D1E18" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <ellipse cx="40" cy="66" rx="8" ry="6" fill="#8D5B4C" />
      <ellipse cx="80" cy="66" rx="8" ry="6" fill="#8D5B4C" />
      <rect x="28" y="60" width="64" height="48" rx="10" fill="#0F172A" stroke="#6366F1" strokeWidth="2.5" />
      <circle cx="37" cy="68" r="2" fill="#EF4444" />
      <circle cx="43" cy="68" r="2" fill="#F59E0B" />
      <circle cx="49" cy="68" r="2" fill="#10B981" />
      <path d="M37 80 L44 85 L37 90" stroke="#38BDF8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="48" y1="90" x2="57" y2="90" stroke="#818CF8" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export default function RunbookPortal() {
  const [authChecked, setAuthChecked] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [pendingVerification, setPendingVerification] = useState(null);
  const [view, setView] = useState("runbooks"); // "runbooks" | "worklog" | "team"

  const [pages, setPages] = useState(null);
  const [folders, setFolders] = useState(null);
  const [teamPages, setTeamPages] = useState(null);
  const [teamFolders, setTeamFolders] = useState(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const [personalSpaceCollapsed, setPersonalSpaceCollapsed] = useState(false);
  const [teamSpaceCollapsed, setTeamSpaceCollapsed] = useState(false);
  const [versionHistoryPage, setVersionHistoryPage] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [themePref, setThemePrefState] = useState(getStoredThemePref);
  const changeTheme = (pref) => { setThemePref(pref); setThemePrefState(pref); };
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [toast, setToast] = useState(null);
  const [idleLoggedOut, setIdleLoggedOut] = useState(false);

  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [pageActiveUsers, setPageActiveUsers] = useState([]);
  const lastServerUpdatedAtRef = React.useRef({ personal: null, team: null });
  const [editingConflict, setEditingConflict] = useState(null);


  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    let unsub = () => { };
    // Safety fallback: ensure authChecked becomes true within 1000ms
    const safetyTimer = setTimeout(() => {
      setAuthChecked(true);
    }, 1000);

    (async () => {
      try { await completeMagicLinkIfPresent(); } catch { }
      unsub = onAuthChange(async (fbUser) => {
        clearTimeout(safetyTimer);
        if (!fbUser) {
          setCurrentUser(null);
          setPendingVerification(null);
          setAuthChecked(true);
          return;
        }
        if (!fbUser.emailVerified) {
          setPendingVerification(fbUser.email);
          setCurrentUser(null);
          setAuthChecked(true);
          return;
        }
        setPendingVerification(null);
        const user = await auth.me();
        setCurrentUser(user);
        setAuthChecked(true);
      });
    })();
    return () => {
      clearTimeout(safetyTimer);
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!currentUser) return;

    const markActive = () => {
      try { localStorage.setItem(IDLE_ACTIVITY_KEY, String(Date.now())); } catch { }
    };
    markActive();

    const events = ["mousedown", "mousemove", "keydown", "scroll", "touchstart"];
    let throttleTimer = null;
    const onActivity = () => {
      if (throttleTimer) return;
      throttleTimer = setTimeout(() => { throttleTimer = null; }, 5000);
      markActive();
    };
    events.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));

    const checkInterval = setInterval(() => {
      let last = 0;
      try { last = Number(localStorage.getItem(IDLE_ACTIVITY_KEY)) || 0; } catch { }
      if (last && Date.now() - last > IDLE_TIMEOUT_MS) {
        setIdleLoggedOut(true);
        signOut();
        setCurrentUser(null);
        setEditing(null);
        setSelectedId(null);
        setPages(null);
        setView("runbooks");
      }
    }, 30 * 1000);

    return () => {
      events.forEach((ev) => window.removeEventListener(ev, onActivity));
      clearInterval(checkInterval);
      if (throttleTimer) clearTimeout(throttleTimer);
    };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    (async () => {
      try {
        const [pagesRes, foldersRes] = await Promise.all([
          window.storage.get(PAGES_KEY, false),
          window.storage.get(FOLDERS_KEY, false),
        ]);
        let loadedPages = pagesRes ? JSON.parse(pagesRes.value) : [];
        let loadedFolders = foldersRes ? JSON.parse(foldersRes.value) : [];

        const needsMigration = loadedPages.some((p) => p.category !== undefined && p.folderId === undefined);
        if (needsMigration) {
          const byName = new Map(loadedFolders.filter((f) => !f.parentId).map((f) => [f.name, f]));
          for (const p of loadedPages) {
            if (p.category === undefined) continue;
            let folder = byName.get(p.category);
            if (!folder) {
              folder = { id: uid(), name: p.category, parentId: null };
              loadedFolders.push(folder);
              byName.set(p.category, folder);
            }
            p.folderId = folder.id;
            delete p.category;
          }
          try {
            await Promise.all([
              window.storage.set(PAGES_KEY, JSON.stringify(loadedPages), false),
              window.storage.set(FOLDERS_KEY, JSON.stringify(loadedFolders), false),
            ]);
          } catch { }
        }

        if (pagesRes?.updatedAt) lastServerUpdatedAtRef.current.personal = pagesRes.updatedAt;
        setPages(loadedPages);
        setFolders(loadedFolders);
      } catch {
        setPages([]);
        setFolders([]);
        setToast("Couldn't load your files — check your connection and try again");
      } finally {
        setLoading(false);
      }

      if (currentUser.team_name) {
        try {
          const [tp, tf] = await Promise.all([
            window.storage.get(PAGES_KEY, true),
            window.storage.get(FOLDERS_KEY, true),
          ]);
          if (tp?.updatedAt) lastServerUpdatedAtRef.current.team = tp.updatedAt;
          setTeamPages(tp ? JSON.parse(tp.value) : []);
          setTeamFolders(tf ? JSON.parse(tf.value) : []);
        } catch {
          setTeamPages([]);
          setTeamFolders([]);
        }
      } else {
        setTeamPages(null);
        setTeamFolders(null);
      }
    })();
  }, [currentUser]);

  const persist = useCallback(async (next) => {
    const prev = pages;
    setPages(next);
    try {
      const result = await window.storage.set(PAGES_KEY, JSON.stringify(next), false);
      if (!result) throw new Error("save failed");
      if (result.updatedAt) lastServerUpdatedAtRef.current.personal = result.updatedAt;
      return true;
    } catch {
      setPages(prev);
      setToast("Couldn't save — check your connection and try again");
      return false;
    }
  }, [pages]);

  const persistFolders = useCallback(async (next) => {
    const prev = folders;
    setFolders(next);
    try {
      const result = await window.storage.set(FOLDERS_KEY, JSON.stringify(next), false);
      if (!result) throw new Error("save failed");
      return true;
    } catch {
      setFolders(prev);
      setToast("Couldn't save folder changes — check your connection and try again");
      return false;
    }
  }, [folders]);

  const persistTeamPages = useCallback(async (next) => {
    const prev = teamPages;
    setTeamPages(next);
    try {
      const result = await window.storage.set(PAGES_KEY, JSON.stringify(next), true);
      if (!result) throw new Error("save failed");
      if (result.updatedAt) lastServerUpdatedAtRef.current.team = result.updatedAt;
      return true;
    } catch {
      setTeamPages(prev);
      setToast("Couldn't save to the team space — check your connection and try again");
      return false;
    }
  }, [teamPages]);

  const persistTeamFolders = useCallback(async (next) => {
    const prev = teamFolders;
    setTeamFolders(next);
    try {
      const result = await window.storage.set(FOLDERS_KEY, JSON.stringify(next), true);
      if (!result) throw new Error("save failed");
      return true;
    } catch {
      setTeamFolders(prev);
      setToast("Couldn't save to the team space — check your connection and try again");
      return false;
    }
  }, [teamFolders]);

  const role = currentUser?.role;
  const canEdit = true;
  const canDelete = true;
  const hasTeam = !!currentUser?.team_name;
  const canEditTeam = hasTeam && role !== "viewer";

  const spaceData = useCallback((space) =>
    space === "team"
      ? { pages: teamPages || [], folders: teamFolders || [], persistPages: persistTeamPages, persistFolders: persistTeamFolders }
      : { pages: pages || [], folders: folders || [], persistPages: persist, persistFolders: persistFolders },
    [pages, folders, teamPages, teamFolders, persist, persistFolders, persistTeamPages, persistTeamFolders]);

  const pageSpace = useCallback((pageId) => {
    if ((pages || []).some((p) => p.id === pageId)) return "personal";
    if ((teamPages || []).some((p) => p.id === pageId)) return "team";
    return null;
  }, [pages, teamPages]);

  const folderSpace = useCallback((folderId) => {
    if ((folders || []).some((f) => f.id === folderId)) return "personal";
    if ((teamFolders || []).some((f) => f.id === folderId)) return "team";
    return null;
  }, [folders, teamFolders]);

  const sortPagesByName = (a, b) =>
    (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base", numeric: true });

  const rootPagesOf = useCallback((space) =>
    spaceData(space).pages.filter((p) => !p.folderId && !p.parentId).sort(sortPagesByName),
    [spaceData]);

  const pagesInFolderOf = useCallback((space) => (folderId) =>
    spaceData(space).pages.filter((p) => p.folderId === folderId && !p.parentId).sort(sortPagesByName),
    [spaceData]);

  const childPagesOf = useCallback((space) => (parentId) =>
    spaceData(space).pages.filter((p) => p.parentId === parentId).sort(sortPagesByName),
    [spaceData]);

  const childFoldersOf = useCallback((space) => (parentId) =>
    spaceData(space).folders.filter((f) => f.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name)),
    [spaceData]);

  const getDescendantFolderIds = useCallback((folderId) => {
    const space = folderSpace(folderId) || "personal";
    const all = spaceData(space).folders;
    const out = [];
    const walk = (pid) => {
      for (const f of all) {
        if (f.parentId === pid) { out.push(f.id); walk(f.id); }
      }
    };
    walk(folderId);
    return out;
  }, [spaceData, folderSpace]);

  const getDescendantPageIds = useCallback((pageId, space) => {
    const all = spaceData(space).pages;
    const out = [];
    const walk = (pid) => {
      for (const p of all) {
        if (p.parentId === pid) { out.push(p.id); walk(p.id); }
      }
    };
    walk(pageId);
    return out;
  }, [spaceData]);

  const flatTreeOf = useCallback((space) => {
    const kids = childFoldersOf(space);
    const out = [];
    const walk = (parentId, depth) => {
      for (const f of kids(parentId)) {
        out.push({ id: f.id, name: f.name, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [childFoldersOf]);
  const flatFolderTree = useMemo(() => flatTreeOf("personal"), [flatTreeOf]);
  const flatTeamFolderTree = useMemo(() => flatTreeOf("team"), [flatTreeOf]);

  const folderById = useMemo(
    () => new Map([...(folders || []), ...(teamFolders || [])].map((f) => [f.id, f])),
    [folders, teamFolders]
  );
  const folderPath = useCallback((folderId) => {
    const path = [];
    let cur = folderId ? folderById.get(folderId) : null;
    while (cur) {
      path.unshift(cur.name);
      cur = cur.parentId ? folderById.get(cur.parentId) : null;
    }
    return path;
  }, [folderById]);

  const pageAncestors = useCallback((page) => {
    if (!page) return [];
    const space = pageSpace(page.id) || "personal";
    const allPages = spaceData(space).pages;
    const pageMap = new Map(allPages.map((p) => [p.id, p]));
    const ancestors = [];
    let cur = page.parentId ? pageMap.get(page.parentId) : null;
    while (cur) {
      ancestors.unshift(cur.title);
      cur = cur.parentId ? pageMap.get(cur.parentId) : null;
    }
    return ancestors;
  }, [pageSpace, spaceData]);

  const fullPagePathStr = useCallback((page) => {
    if (!page) return "Top level";
    const parts = [...folderPath(page.folderId), ...pageAncestors(page)];
    return parts.join(" / ") || "Top level";
  }, [folderPath, pageAncestors]);

  const createFolder = async (name, parentId, space = "personal") => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const { folders: all, persistFolders: doPersist } = spaceData(space);
    const folder = { id: uid(), name: trimmed, parentId: parentId || null };
    const ok = await doPersist([...all, folder]);
    return ok ? folder : null;
  };

  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState(null);

  const deleteFolderCascade = async (folderId) => {
    const space = folderSpace(folderId) || "personal";
    const { pages: allPages, folders: allFolders, persistPages: doPersistPages, persistFolders: doPersistFolders } = spaceData(space);
    const descendantIds = getDescendantFolderIds(folderId);
    const allFolderIds = new Set([folderId, ...descendantIds]);
    const nextFolders = allFolders.filter((f) => !allFolderIds.has(f.id));
    const nextPages = allPages.filter((p) => !allFolderIds.has(p.folderId));
    const [okF, okP] = await Promise.all([doPersistFolders(nextFolders), doPersistPages(nextPages)]);
    setConfirmDeleteFolder(null);
    if (okF && okP) setToast("Folder deleted");
  };

  const titleTakenIn = useCallback((space, folderId, title, ignoreId = null, parentId = null) => {
    const norm = (s) => (s || "").trim().toLowerCase();
    return spaceData(space).pages.some(
      (p) =>
        p.id !== ignoreId &&
        (p.folderId || null) === (folderId || null) &&
        (p.parentId || null) === (parentId || null) &&
        norm(p.title) === norm(title)
    );
  }, [spaceData]);

  const duplicatePage = async (pageId) => {
    const space = pageSpace(pageId) || "personal";
    const { pages: allPages, persistPages: doPersist } = spaceData(space);
    const src = allPages.find((p) => p.id === pageId);
    if (!src) return;
    const now = new Date().toISOString();

    const idMap = new Map();
    const newPages = [];

    const clonePageTree = (origId, newParentId, titleOverride) => {
      const orig = allPages.find((p) => p.id === origId);
      if (!orig) return;
      const newId = uid();
      idMap.set(origId, newId);

      let title = titleOverride || orig.title;
      if (titleOverride) {
        let n = 2;
        while (titleTakenIn(space, orig.folderId, title, null, newParentId)) {
          title = `${orig.title} (copy ${n++})`;
        }
      }
      const copy = {
        ...orig,
        id: newId,
        title,
        parentId: newParentId || null,
        updatedAt: now,
        updatedBy: currentUser.name,
      };
      newPages.push(copy);

      allPages.filter((p) => p.parentId === origId).forEach((child) => clonePageTree(child.id, newId, null));
    };

    let rootTitle = `${src.title} (copy)`;
    let n = 2;
    while (titleTakenIn(space, src.folderId, rootTitle, null, src.parentId || null)) {
      rootTitle = `${src.title} (copy ${n++})`;
    }

    clonePageTree(pageId, src.parentId || null, rootTitle);

    const ok = await doPersist([...newPages, ...allPages]);
    if (ok) {
      setSelectedId(newPages[0].id);
      setToast("Page duplicated");
    }
  };

  const renamePage = async (pageId, newTitle) => {
    const trimmed = (newTitle || "").trim();
    if (!trimmed) return;
    const space = pageSpace(pageId) || "personal";
    const { pages: allPages, persistPages: doPersist } = spaceData(space);
    const current = allPages.find((p) => p.id === pageId);
    if (!current) return;
    if (titleTakenIn(space, current.folderId, trimmed, pageId, current.parentId || null)) {
      setToast(`A page named "${trimmed}" already exists here`);
      return;
    }
    const now = new Date().toISOString();
    const ok = await doPersist(allPages.map((p) =>
      p.id === pageId ? { ...p, title: trimmed, updatedAt: now, updatedBy: currentUser.name } : p
    ));
    if (ok) setToast("Page renamed");
  };

  const renameFolder = async (folderId, newName) => {
    const trimmed = (newName || "").trim();
    if (!trimmed) return;
    const space = folderSpace(folderId) || "personal";
    const { folders: allFolders, persistFolders: doPersist } = spaceData(space);
    const ok = await doPersist(allFolders.map((f) => (f.id === folderId ? { ...f, name: trimmed } : f)));
    if (ok) setToast("Folder renamed");
  };

  const duplicateFolder = async (folderId) => {
    const space = folderSpace(folderId) || "personal";
    const { pages: allPages, folders: allFolders, persistPages: doPersistPages, persistFolders: doPersistFolders } = spaceData(space);
    const src = allFolders.find((f) => f.id === folderId);
    if (!src) return;
    const now = new Date().toISOString();
    const idMap = new Map();
    const newFolders = [];
    const cloneTree = (origId, newParentId, nameOverride) => {
      const orig = allFolders.find((f) => f.id === origId);
      if (!orig) return;
      const newId = uid();
      idMap.set(origId, newId);
      newFolders.push({ id: newId, name: nameOverride || orig.name, parentId: newParentId });
      allFolders.filter((f) => f.parentId === origId).forEach((child) => cloneTree(child.id, newId));
    };
    cloneTree(folderId, src.parentId, `${src.name} (copy)`);
    const newPages = allPages
      .filter((p) => idMap.has(p.folderId))
      .map((p) => ({ ...p, id: uid(), folderId: idMap.get(p.folderId), updatedAt: now, updatedBy: currentUser.name }));
    const okF = await doPersistFolders([...allFolders, ...newFolders]);
    if (!okF) return;
    if (newPages.length) {
      const okP = await doPersistPages([...newPages, ...allPages]);
      if (!okP) return;
    }
    setToast(`Folder duplicated${newPages.length ? ` with ${newPages.length} page${newPages.length === 1 ? "" : "s"}` : ""}`);
  };

  const pageUrl = useCallback((page) => {
    const segs = [...folderPath(page.folderId), ...pageAncestors(page), page.title]
      .map((s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
      .filter(Boolean)
      .join("/");
    return `${window.location.origin}${window.location.pathname}#/page/${page.id}${segs ? "/" + segs : ""}`;
  }, [folderPath, pageAncestors]);

  const openPageInNewTab = (page) => {
    window.open(pageUrl(page), "_blank", "noopener,noreferrer");
  };

  const copyPageLink = async (page) => {
    const url = pageUrl(page);
    try {
      await navigator.clipboard.writeText(url);
      setToast(pageSpace(page.id) === "team" ? "Link copied — your teammates can open it" : "Link copied (only you can open it)");
    } catch {
      setToast("Couldn't copy — your browser blocked clipboard access");
    }
  };

  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [ctxMenu, setCtxMenu] = useState(null);

  const startRename = (type, id, currentName) => {
    setRenaming({ type, id });
    setRenameValue(currentName);
  };
  const confirmRename = async () => {
    if (!renaming) return;
    const { type, id } = renaming;
    const val = renameValue;
    setRenaming(null);
    setRenameValue("");
    if (type === "page") await renamePage(id, val);
    else await renameFolder(id, val);
  };
  const cancelRename = () => { setRenaming(null); setRenameValue(""); };

  const openPageMenu = (e, page, space, canEditSpace) => {
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Open", icon: FileText, onClick: () => handleSelectPage(page) },
        { label: "Open in new tab", icon: ExternalLink, onClick: () => openPageInNewTab(page) },
        { label: "Copy link", icon: LinkIcon, onClick: () => copyPageLink(page) },
        { label: "New subpage", icon: FilePlus, disabled: !canEditSpace, onClick: () => startNewSubpage(page, space) },
        { divider: true },
        { label: "Rename", icon: Pencil, disabled: !canEditSpace, onClick: () => startRename("page", page.id, page.title) },
        { label: "Duplicate", icon: Copy, disabled: !canEditSpace, onClick: () => duplicatePage(page.id) },
        { label: "Move to…", icon: FolderInput, disabled: !canEditSpace, onClick: () => setMoveTarget({ type: "page", id: page.id, name: page.title, space }) },
        { divider: true },
        { label: "Delete", icon: Trash2, danger: true, disabled: !canEditSpace, onClick: () => setConfirmDelete(page.id) },
      ],
    });
  };

  const openFolderMenu = (e, folder, space, canEditSpace) => {
    const allPages = spaceData(space).pages;
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "New page here", icon: FilePlus, disabled: !canEditSpace, onClick: () => startNewPage(folder.id, space) },
        { label: "New subfolder", icon: FolderPlus, disabled: !canEditSpace, onClick: () => { setCreatingFolderUnder(folder.id); setNewFolderName(""); setCollapsed((c) => ({ ...c, [folder.id]: false })); } },
        { divider: true },
        { label: "Rename", icon: Pencil, disabled: !canEditSpace, onClick: () => startRename("folder", folder.id, folder.name) },
        { label: "Duplicate", icon: Copy, disabled: !canEditSpace, onClick: () => duplicateFolder(folder.id) },
        { label: "Move to…", icon: FolderInput, disabled: !canEditSpace, onClick: () => setMoveTarget({ type: "folder", id: folder.id, name: folder.name, space }) },
        { divider: true },
        {
          label: "Delete", icon: Trash2, danger: true, disabled: !canEditSpace,
          onClick: () => {
            const descendantIds = getDescendantFolderIds(folder.id);
            const pageCount = allPages.filter((p) => p.folderId === folder.id || descendantIds.includes(p.folderId)).length;
            setConfirmDeleteFolder({ id: folder.id, name: folder.name, folderCount: descendantIds.length, pageCount });
          },
        },
      ],
    });
  };

  const movePageToFolder = async (pageId, folderId) => {
    const space = pageSpace(pageId) || "personal";
    const { pages: allPages, persistPages: doPersist } = spaceData(space);
    const page = allPages.find((p) => p.id === pageId);
    if (page && titleTakenIn(space, folderId, page.title, pageId, page.parentId || null)) {
      setToast(`A page named "${page.title}" already exists in that folder`);
      return;
    }
    const now = new Date().toISOString();
    const next = allPages.map((p) => (p.id === pageId ? { ...p, folderId, updatedAt: now, updatedBy: currentUser.name } : p));
    const ok = await doPersist(next);
    if (ok) setToast("Page moved");
  };

  const moveFolderToParent = async (folderId, newParentId) => {
    const space = folderSpace(folderId) || "personal";
    const { folders: allFolders, persistFolders: doPersist } = spaceData(space);
    const next = allFolders.map((f) => (f.id === folderId ? { ...f, parentId: newParentId } : f));
    const ok = await doPersist(next);
    if (ok) setToast("Folder moved");
  };

  const [moveTarget, setMoveTarget] = useState(null);
  const [creatingFolderUnder, setCreatingFolderUnder] = useState(null);
  const [newFolderName, setNewFolderName] = useState("");

  const confirmCreateFolder = async () => {
    let space, parentId;
    if (creatingFolderUnder === "root") { space = "personal"; parentId = null; }
    else if (creatingFolderUnder === "team-root") { space = "team"; parentId = null; }
    else { parentId = creatingFolderUnder; space = folderSpace(parentId) || "personal"; }
    const folder = await createFolder(newFolderName, parentId, space);
    if (folder) {
      setCollapsed((c) => ({ ...c, [parentId]: false }));
      setToast("Folder created");
    }
    setCreatingFolderUnder(null);
    setNewFolderName("");
  };
  const cancelCreateFolder = () => { setCreatingFolderUnder(null); setNewFolderName(""); };

  const handleSelectPage = (p) => { setSelectedId(p.id); setEditing(null); };

  const filtered = useMemo(() => {
    const all = [...(pages || []), ...(teamPages || [])];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.content.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [pages, teamPages, query]);

  const filteredIds = useMemo(() => new Set(filtered.map((p) => p.id)), [filtered]);

  const folderHasMatchOf = useCallback((space) => {
    const inFolder = pagesInFolderOf(space);
    const kids = childFoldersOf(space);
    const check = (folderId) => {
      if (!query) return true;
      if (inFolder(folderId).some((p) => filteredIds.has(p.id))) return true;
      return kids(folderId).some((f) => check(f.id));
    };
    return check;
  }, [query, pagesInFolderOf, filteredIds, childFoldersOf]);

  const selected =
    (pages?.find((p) => p.id === selectedId)) ||
    (teamPages?.find((p) => p.id === selectedId)) ||
    null;
  const selectedSpace = selected ? (pageSpace(selected.id) || "personal") : null;

  // Heartbeat loop for presence on the active page (PASTE HERE)
  useEffect(() => {
    const pageId = editing?.id || selected?.id;
    if (!pageId || !currentUser) {
      setPageActiveUsers([]);
      return;
    }

    const space = editing ? (editing.__space || "personal") : (selectedSpace || "personal");
    const status = editing ? "editing" : "viewing";

    let active = true;
    const sendBeat = async () => {
      const res = await presence.heartbeat(pageId, space, status);
      if (!active) return;
      if (res?.activeUsers) {
        setPageActiveUsers(res.activeUsers);
      }
      if (res?.pagesUpdatedAt) {
        const lastKnown = lastServerUpdatedAtRef.current[space];
        if (!lastKnown) {
          lastServerUpdatedAtRef.current[space] = res.pagesUpdatedAt;
        } else if (lastKnown !== res.pagesUpdatedAt) {
          lastServerUpdatedAtRef.current[space] = res.pagesUpdatedAt;
          try {
            const freshRes = await window.storage.get(PAGES_KEY, space === "team");
            if (freshRes?.value && active) {
              const freshPages = JSON.parse(freshRes.value);
              if (space === "team") {
                setTeamPages(freshPages);
              } else {
                setPages(freshPages);
              }
              if (editing && editing.id === pageId) {
                const serverPage = freshPages.find((p) => p.id === pageId);
                if (serverPage && serverPage.updatedAt !== editing.updatedAt) {
                  setEditingConflict({
                    updatedBy: serverPage.updatedBy || "Another collaborator",
                    updatedAt: serverPage.updatedAt,
                  });
                }
              }
            }
          } catch { }
        }
      }
    };

    sendBeat();
    const interval = setInterval(sendBeat, 4000); // Poll presence every 4s

    return () => {
      active = false;
      clearInterval(interval);
      presence.leave(pageId);
    };
  }, [editing?.id, selected?.id, editing ? "editing" : "viewing", currentUser, selectedSpace]);

  const initialHashApplied = React.useRef(false);
  const pagesReadyForRouting = pages !== null && (!currentUser?.team_name || teamPages !== null);

  useEffect(() => {
    if (!currentUser || !pagesReadyForRouting || !initialHashApplied.current) return;
    let target;
    if (view === "team") target = "#/team";
    else if (view === "worklog") target = "#/worklog";
    else if (selected) {
      const segs = [...folderPath(selected.folderId), ...pageAncestors(selected), selected.title]
        .map((s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
        .filter(Boolean)
        .join("/");
      target = `#/page/${selected.id}${segs ? "/" + segs : ""}`;
    } else target = "#/";
    if (window.location.hash !== target) window.location.hash = target;
  }, [currentUser, pagesReadyForRouting, view, selected, folderPath, pageAncestors]);

  useEffect(() => {
    if (!currentUser || !pagesReadyForRouting) return;
    const applyHash = () => {
      const h = window.location.hash || "";
      const pageMatch = h.match(/^#\/page\/([^/]+)/);
      if (pageMatch) {
        const p = pages.find((x) => x.id === pageMatch[1]) || (teamPages || []).find((x) => x.id === pageMatch[1]);
        if (p) { setView("runbooks"); setEditing(null); setSelectedId(p.id); }
        return;
      }
      if (h === "#/team") { if (role === "admin") setView("team"); return; }
      if (h === "#/worklog") { setView("worklog"); return; }
      if (h === "#/" || h === "") { setView("runbooks"); setSelectedId(null); }
    };
    applyHash();
    initialHashApplied.current = true;
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [currentUser, pagesReadyForRouting, pages, teamPages, role]);

  const toggleFolder = (id) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const startNewPage = (folderId, space = "personal") => {
    setEditingConflict(null);
    setEditing({
      id: null,
      title: "",
      folderId: folderId !== undefined ? folderId : null,
      parentId: null,
      status: "draft",
      tags: [],
      content: "",
      __editKey: uid(),
      __space: space,
    });
    setSelectedId(null);
  };

  const startNewSubpage = (parentPage, space = "personal") => {
    setEditingConflict(null);
    const targetSpace = space || pageSpace(parentPage.id) || "personal";
    setEditing({
      id: null,
      title: "",
      folderId: parentPage.folderId || null,
      parentId: parentPage.id,
      status: "draft",
      tags: [],
      content: "",
      __editKey: uid(),
      __space: targetSpace,
    });
    setCollapsed((c) => ({ ...c, [parentPage.id]: false }));
    setSelectedId(null);
  };

  const startEditPage = (p) => {
    setEditingConflict(null);
    setEditing({ ...p, parentId: p.parentId || null, __editKey: uid(), __space: pageSpace(p.id) || "personal" });
    setSelectedId(p.id);
  };

  const [titleError, setTitleError] = useState(false);
  const [titleErrorMsg, setTitleErrorMsg] = useState("");

  const saveEdit = async () => {
    if (!editing.title.trim()) {
      setTitleError(true);
      setTitleErrorMsg("A title is required before this page can be saved.");
      setToast("Give the page a title before saving");
      return;
    }
    const { __editKey, __space, ...cleanEditing } = editing;
    const targetSpace = __space || "personal";

    const movingSpace = cleanEditing.id && pageSpace(cleanEditing.id) !== targetSpace;
    const landingFolderId = movingSpace ? null : cleanEditing.folderId;
    const landingParentId = movingSpace ? null : (cleanEditing.parentId || null);

    if (titleTakenIn(targetSpace, landingFolderId, cleanEditing.title, cleanEditing.id, landingParentId)) {
      const where = targetSpace === "team" ? "the team space" : "your space";
      const place = landingFolderId ? "this folder of" : "the top level of";
      setTitleError(true);
      setTitleErrorMsg(`A page named "${cleanEditing.title.trim()}" already exists in ${place} ${where}. Choose a different title.`);
      setToast("That page name is already taken here");
      return;
    }
    setTitleError(false);
    setTitleErrorMsg("");
    const now = new Date().toISOString();
    const originalSpace = cleanEditing.id ? pageSpace(cleanEditing.id) : null;
    let id = cleanEditing.id || uid();

    // Preserve previous version as backup
    const currentSpace = originalSpace || targetSpace;
    const existingPage = spaceData(currentSpace).pages.find((p) => p.id === id);
    let history = existingPage?.history || [];
    if (existingPage && (existingPage.content !== cleanEditing.content || existingPage.title !== cleanEditing.title)) {
      const backup = {
        id: uid(),
        title: existingPage.title,
        content: existingPage.content,
        updatedAt: existingPage.updatedAt || now,
        updatedBy: existingPage.updatedBy || currentUser.name,
      };
      history = [backup, ...history].slice(0, 15);
    }
    const stamped = { ...cleanEditing, parentId: landingParentId, updatedAt: now, updatedBy: currentUser.name, history };

    // Clear draft buffer for this page
    try { localStorage.removeItem(`runbook_draft_${id}`); } catch { }

    if (originalSpace && originalSpace !== targetSpace) {
      const from = spaceData(originalSpace);
      const to = spaceData(targetSpace);

      let freshFromPages = from.pages;
      let freshToPages = to.pages;
      try {
        const [ffRes, ftRes] = await Promise.all([
          window.storage.get(PAGES_KEY, originalSpace === "team"),
          window.storage.get(PAGES_KEY, targetSpace === "team"),
        ]);
        if (ffRes?.value) freshFromPages = JSON.parse(ffRes.value);
        if (ftRes?.value) freshToPages = JSON.parse(ftRes.value);
      } catch { }

      const okRemove = await from.persistPages(freshFromPages.filter((p) => p.id !== id));
      if (!okRemove) return;
      const ok = await to.persistPages([{ ...stamped, id, folderId: null, parentId: null }, ...freshToPages.filter((p) => p.id !== id)]);
      if (!ok) return;
    } else {
      const { pages: allPages, persistPages: doPersist } = spaceData(targetSpace);

      let freshPages = allPages;
      try {
        const freshRes = await window.storage.get(PAGES_KEY, targetSpace === "team");
        if (freshRes?.value) {
          freshPages = JSON.parse(freshRes.value);
          if (freshRes.updatedAt) {
            lastServerUpdatedAtRef.current[targetSpace] = freshRes.updatedAt;
          }
        }
      } catch { }

      const next = cleanEditing.id
        ? (freshPages.some((p) => p.id === id)
          ? freshPages.map((p) => (p.id === id ? { ...stamped, id } : p))
          : [{ ...stamped, id }, ...freshPages])
        : [{ ...stamped, id }, ...freshPages];
      const ok = await doPersist(next);
      if (!ok) return;
    }
    setSelectedId(id);
    setToast(cleanEditing.id ? "Page saved" : "Page created");
    setEditing(null);
    setEditingConflict(null);
  };

  const deletePage = async (id) => {
    const space = pageSpace(id) || "personal";
    const { pages: allPages, persistPages: doPersist } = spaceData(space);
    const descendantIds = new Set([id, ...getDescendantPageIds(id, space)]);

    let freshPages = allPages;
    try {
      const freshRes = await window.storage.get(PAGES_KEY, space === "team");
      if (freshRes?.value) freshPages = JSON.parse(freshRes.value);
    } catch { }

    const nextPages = freshPages.filter((p) => !descendantIds.has(p.id));
    setConfirmDelete(null);
    const ok = await doPersist(nextPages);
    if (!ok) return;
    if (selectedId && descendantIds.has(selectedId)) setSelectedId(null);
    setToast("Page deleted");
  };

  const setStatus = async (id, status) => {
    const space = pageSpace(id) || "personal";
    const { pages: allPages, persistPages: doPersist } = spaceData(space);

    let freshPages = allPages;
    try {
      const freshRes = await window.storage.get(PAGES_KEY, space === "team");
      if (freshRes?.value) freshPages = JSON.parse(freshRes.value);
    } catch { }

    const now = new Date().toISOString();
    const next = freshPages.map((p) => (p.id === id ? { ...p, status, updatedAt: now, updatedBy: currentUser.name } : p));
    const ok = await doPersist(next);
    if (ok) setToast(`Marked ${STATUS_META[status].label}`);
  };

  const removeAttachment = async (pageId, fileId) => {
    const space = pageSpace(pageId) || "personal";
    const { pages: allPages, persistPages: doPersist } = spaceData(space);
    const page = allPages.find((p) => p.id === pageId);
    if (!page) return;
    const now = new Date().toISOString();
    const nextContent = page.content
      .split("\n")
      .filter((line) => !line.includes(`[[file:${fileId}|`))
      .join("\n");
    const next = allPages.map((p) =>
      p.id === pageId ? { ...p, content: nextContent, updatedAt: now, updatedBy: currentUser.name } : p
    );
    const ok = await doPersist(next);
    if (!ok) return;

    try {
      await filesApi.remove(fileId);
      setToast("Attachment deleted");
    } catch {
      setToast("Removed from page, but the file may still exist in storage — check GCS");
    }
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-[var(--bg-void)]">
        <Loader2 size={22} className="text-[var(--accent)] animate-spin" />
      </div>
    );
  }

  if (pendingVerification) {
    return (
      <VerifyEmailScreen
        email={pendingVerification}
        onVerified={async () => {
          setPendingVerification(null);
          const user = await auth.me();
          setCurrentUser(user);
        }}
      />
    );
  }

  if (!currentUser) {
    return (
      <LoginScreen
        onProfileComplete={async () => {
          const user = await auth.me();
          setCurrentUser(user);
        }}
        idleLoggedOut={idleLoggedOut}
        onDismissIdleNotice={() => setIdleLoggedOut(false)}
      />
    );
  }

  const RoleIcon = ROLE_META[role].icon;

  return (
    <div className="min-h-screen w-full bg-[var(--bg-void)] flex" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
      {/* Sidebar */}
      <aside className={`${sidebarCollapsed ? "w-16" : "w-72"} flex-shrink-0 border-r border-[var(--border)] flex flex-col h-screen sticky top-0 transition-all duration-200`}>
        <div className={`p-4 border-b border-[var(--border)] flex items-center ${sidebarCollapsed ? "flex-col gap-3" : "gap-2"}`}>
          <RaftPagesLogo size={32} />
          {!sidebarCollapsed && (
            <span className="text-[var(--text-primary)] text-base font-bold tracking-tight flex-1" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              Raft<span className="text-[var(--accent)]">Pages</span>
            </span>
          )}
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded"
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}
          </button>
        </div>

        {sidebarCollapsed ? (
          <>
            <div className="flex-1 flex flex-col items-center gap-1 pt-3">
              <button
                onClick={() => setView("runbooks")}
                title="My Files"
                className={`w-10 h-10 rounded-md flex items-center justify-center transition-colors ${view === "runbooks" ? "bg-[var(--accent-15)] text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--panel-raised)]"}`}
              >
                <Folder size={17} />
              </button>
            </div>
            <div className="p-2 border-t border-[var(--border)] flex flex-col items-center gap-2">
              {view === "runbooks" && canEdit && (
                <button
                  onClick={() => startNewPage()}
                  title="New page"
                  className="w-10 h-10 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white flex items-center justify-center"
                >
                  <Plus size={17} />
                </button>
              )}
              <div className="w-8 h-8 rounded-full bg-[var(--border)] flex items-center justify-center text-[var(--text-primary)] text-xs font-medium" title={currentUser.name}>
                {initialsOf(currentUser.name)}
              </div>
              <button
                onClick={() => changeTheme(themePref === "light" ? "dark" : themePref === "dark" ? "system" : "light")}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1"
                title={`Theme: ${themePref} (click to change)`}
              >
                {themePref === "light" ? <Sun size={14} /> : themePref === "dark" ? <Moon size={14} /> : <Monitor size={14} />}
              </button>
              <button
                onClick={() => { signOut(); setCurrentUser(null); setEditing(null); setSelectedId(null); setPages(null); setView("runbooks"); }}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1"
                title="Sign out"
              >
                <LogOut size={14} />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="px-3 pt-3 flex items-center gap-1">
              <NavTab active={view === "runbooks"} onClick={() => setView("runbooks")} icon={Folder} label="My Files" />
            </div>

            {view === "runbooks" && (
              <div className="p-3 border-b border-[var(--border)]">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search your files..."
                    className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md pl-8 pr-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-60)]"
                  />
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto py-2">
              {view !== "runbooks" && (
                <p className="text-[var(--text-dim)] text-sm px-4 py-3">
                  Manage roles and sub-teams for your organization.
                </p>
              )}
              {view === "runbooks" && loading && <p className="text-[var(--text-muted)] text-sm px-4 py-2">Loading your files…</p>}
              {view === "runbooks" && !loading && pages?.length === 0 && folders?.length === 0 && (
                <p className="text-[var(--text-dim)] text-sm px-4 py-3">No files yet — create your first page below.</p>
              )}

              {view === "runbooks" && (() => {
                const renderSpaceSection = (space, canEditSpace, rootKey) => {
                  const kids = childFoldersOf(space);
                  const inFolder = pagesInFolderOf(space);
                  const childPages = childPagesOf(space);
                  const hasMatch = folderHasMatchOf(space);
                  const roots = rootPagesOf(space);

                  return (
                    <>
                      {kids(null).map((folder) => (
                        <FolderNode
                          key={folder.id}
                          folder={folder}
                          depth={0}
                          space={space}
                          canEditSpace={canEditSpace}
                          childFolders={kids}
                          pagesInFolder={inFolder}
                          childPages={childPages}
                          query={query}
                          filteredIds={filteredIds}
                          folderHasMatch={hasMatch}
                          collapsed={collapsed}
                          toggleFolder={toggleFolder}
                          selectedId={selectedId}
                          editingId={editing?.id}
                          onSelectPage={handleSelectPage}
                          canEdit={canEditSpace}
                          onFolderContextMenu={(e, f) => openFolderMenu(e, f, space, canEditSpace)}
                          onPageContextMenu={(e, p) => openPageMenu(e, p, space, canEditSpace)}
                          pageHref={pageUrl}
                          creatingFolderUnder={creatingFolderUnder}
                          newFolderName={newFolderName}
                          setNewFolderName={setNewFolderName}
                          onConfirmCreateFolder={confirmCreateFolder}
                          onCancelCreateFolder={cancelCreateFolder}
                          renaming={renaming}
                          renameValue={renameValue}
                          setRenameValue={setRenameValue}
                          onConfirmRename={confirmRename}
                          onCancelRename={cancelRename}
                          openPageMenu={openPageMenu}
                        />
                      ))}

                      {creatingFolderUnder === rootKey && (
                        <div className="flex items-center gap-1.5 py-1 px-3">
                          <input
                            autoFocus
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") confirmCreateFolder(); if (e.key === "Escape") cancelCreateFolder(); }}
                            placeholder="Folder name"
                            className="flex-1 bg-[var(--panel-raised)] border border-[var(--accent-60)] rounded-md px-2 py-1 text-xs text-[var(--text-primary)] focus:outline-none"
                          />
                          <button onClick={confirmCreateFolder} className="text-[var(--accent)] hover:text-[var(--accent-hover)] p-1"><CheckCircle2 size={13} /></button>
                          <button onClick={cancelCreateFolder} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1"><X size={13} /></button>
                        </div>
                      )}

                      {roots.map((p) => (
                        <PageNode
                          key={p.id}
                          page={p}
                          depth={0}
                          space={space}
                          canEditSpace={canEditSpace}
                          childPages={childPages}
                          query={query}
                          filteredIds={filteredIds}
                          collapsed={collapsed}
                          toggleFolder={toggleFolder}
                          selectedId={selectedId}
                          editingId={editing?.id}
                          onSelectPage={handleSelectPage}
                          onPageContextMenu={(e, page) => openPageMenu(e, page, space, canEditSpace)}
                          pageHref={pageUrl}
                          renaming={renaming}
                          renameValue={renameValue}
                          setRenameValue={setRenameValue}
                          onConfirmRename={confirmRename}
                          onCancelRename={cancelRename}
                          openPageMenu={openPageMenu}
                        />
                      ))}
                    </>
                  );
                };

                return (
                  <>
                    <div className="flex items-center justify-between px-3 pt-2 pb-1 text-[var(--text-dim)] hover:text-[var(--text-primary)] transition-colors select-none">
                      <button
                        onClick={() => setPersonalSpaceCollapsed((v) => !v)}
                        className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold flex-1 text-left"
                      >
                        {personalSpaceCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                        <User size={11} /> Personal space
                      </button>
                      {canEdit && (
                        <div className="flex items-center gap-0.5">
                          <button onClick={() => startNewPage(null, "personal")} title="New personal page" className="p-1 text-[var(--text-muted)] hover:text-[var(--accent)]">
                            <FilePlus size={12} />
                          </button>
                          <button onClick={() => { setCreatingFolderUnder("root"); setNewFolderName(""); setPersonalSpaceCollapsed(false); }} title="New personal folder" className="p-1 text-[var(--text-muted)] hover:text-[var(--accent)]">
                            <FolderPlus size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                    {!personalSpaceCollapsed && renderSpaceSection("personal", canEdit, "root")}

                    {hasTeam && (
                      <>
                        <div className="flex items-center justify-between px-3 pt-3 pb-1 mt-2 border-t border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text-primary)] transition-colors select-none">
                          <button
                            onClick={() => setTeamSpaceCollapsed((v) => !v)}
                            className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold flex-1 text-left"
                          >
                            {teamSpaceCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                            <Users size={11} /> Team space
                          </button>
                          {canEditTeam && (
                            <div className="flex items-center gap-0.5">
                              <button onClick={() => startNewPage(null, "team")} title="New team page" className="p-1 text-[var(--text-muted)] hover:text-[var(--accent)]">
                                <FilePlus size={12} />
                              </button>
                              <button onClick={() => { setCreatingFolderUnder("team-root"); setNewFolderName(""); setTeamSpaceCollapsed(false); }} title="New team folder" className="p-1 text-[var(--text-muted)] hover:text-[var(--accent)]">
                                <FolderPlus size={12} />
                              </button>
                            </div>
                          )}
                        </div>
                        {!teamSpaceCollapsed && (
                          <>
                            {teamPages === null ? (
                              <p className="text-[var(--text-dim)] text-sm px-4 py-2">Loading team space…</p>
                            ) : teamPages.length === 0 && (teamFolders || []).length === 0 && creatingFolderUnder !== "team-root" ? (
                              <p className="text-[var(--text-dim)] text-sm px-4 py-2">
                                {canEditTeam ? "No team pages yet — create one with the + above." : "No team pages yet."}
                              </p>
                            ) : null}
                            {renderSpaceSection("team", canEditTeam, "team-root")}
                          </>
                        )}
                      </>
                    )}
                  </>
                );
              })()}

              {view === "runbooks" && query && filtered.length === 0 && (
                <p className="text-[var(--text-muted)] text-sm px-4 py-6 text-center">No pages match "{query}"</p>
              )}
            </div>

            {view === "runbooks" && canEdit && (
              <div className="px-3 pb-2">
                <button
                  onClick={() => { setCreatingFolderUnder("root"); setNewFolderName(""); }}
                  className="w-full flex items-center justify-center gap-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xs py-1.5 rounded-md hover:bg-[var(--panel-raised)] transition-colors"
                >
                  <FolderPlus size={13} /> New folder
                </button>
              </div>
            )}

            {view === "runbooks" && (
              <div className="p-3 border-t border-[var(--border)]">
                <button
                  onClick={() => startNewPage()}
                  className="w-full flex items-center justify-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[15px] font-medium py-2.5 rounded-md transition-colors"
                >
                  <Plus size={15} /> New page
                </button>
              </div>
            )}

            <div className="px-3 pt-3 pb-1 border-t border-[var(--border)] flex items-center justify-between">
              <span className="text-[var(--text-dim)] text-[10px] uppercase tracking-wider">Theme</span>
              <ThemeToggle value={themePref} onChange={changeTheme} />
            </div>

            <div className="relative p-3 border-t border-[var(--border)]">
              <button
                onClick={() => setProfileMenuOpen((v) => !v)}
                className="w-full flex items-center gap-2 p-1.5 rounded-lg hover:bg-[var(--panel-raised)] transition-colors text-left focus:outline-none"
              >
                <div className="w-8 h-8 rounded-full bg-[var(--accent-15)] text-[var(--accent)] border border-[var(--accent-30)] flex items-center justify-center text-xs font-bold flex-shrink-0">
                  {initialsOf(currentUser.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[var(--text-primary)] text-sm font-medium truncate">{currentUser.name}</div>
                  <div className="text-[var(--text-muted)] text-xs flex items-center gap-1">
                    <RoleIcon size={10} /> {ROLE_META[role].label}
                  </div>
                </div>
                <ChevronDown size={14} className="text-[var(--text-muted)] flex-shrink-0" />
              </button>

              {profileMenuOpen && (
                <div className="absolute bottom-full left-3 right-3 mb-2 bg-[var(--panel)] border border-[var(--border)] rounded-xl shadow-2xl z-50 overflow-hidden py-1 animate-in fade-in slide-in-from-bottom-2 duration-150">
                  <div className="px-3 py-2 border-b border-[var(--border)]">
                    <p className="text-[var(--text-primary)] text-xs font-semibold truncate">{currentUser.name}</p>
                    <p className="text-[var(--text-dim)] text-[10px] truncate">{currentUser.email}</p>
                  </div>
                  <button
                    onClick={() => { setProfileMenuOpen(false); setShowChangePasswordModal(true); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--panel-raised)] transition-colors"
                  >
                    <KeyRound size={13} className="text-[var(--accent)]" /> Change Password
                  </button>

                  {role === "admin" && (
                    <>
                      <button
                        onClick={() => { setProfileMenuOpen(false); setView("team"); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--panel-raised)] transition-colors"
                      >
                        <Users size={13} className="text-[var(--accent)]" /> Team management
                      </button>
                      <button
                        onClick={() => { setProfileMenuOpen(false); setShowPaymentModal(true); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--panel-raised)] transition-colors"
                      >
                        <CreditCard size={13} className="text-[var(--accent)]" /> Upgrade / Secure Payment
                      </button>
                    </>
                  )}

                  <button
                    onClick={() => { setProfileMenuOpen(false); setShowAboutModal(true); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--panel-raised)] transition-colors"
                  >
                    <Info size={13} className="text-[var(--accent)]" /> About RaftPages
                  </button>

                  <div className="border-t border-[var(--border)] my-1" />
                  <button
                    onClick={() => { setProfileMenuOpen(false); signOut(); setCurrentUser(null); setEditing(null); setSelectedId(null); setPages(null); setView("runbooks"); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--danger)] hover:bg-[var(--panel-raised)] transition-colors"
                  >
                    <LogOut size={13} /> Sign Out
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0 h-screen flex flex-col overflow-hidden">
        {currentUser.storageWarning && (
          <div className="flex-shrink-0 flex items-center justify-between gap-3 mx-8 mt-4 p-3.5 rounded-lg bg-[var(--warning)]/15 border border-[var(--warning)]/30">
            <div className="flex items-center gap-2.5">
              <AlertTriangle size={16} className="text-[var(--warning)] flex-shrink-0" />
              <p className="text-[var(--text-primary)] text-xs leading-relaxed">
                {currentUser.storageWarning.scope === "team" ? "Your team's storage" : "Your storage"} is{" "}
                <span className="font-semibold text-[var(--warning)]">{currentUser.storageWarning.pct}% full</span> ({(currentUser.storageWarning.usedBytes / (1024 * 1024 * 1024)).toFixed(2)} GB of{" "}
                {(currentUser.storageWarning.quotaBytes / (1024 * 1024 * 1024)).toFixed(0)} GB). Uploads will be blocked at the limit.
                {role !== "admin" && " Contact your team admin to expand storage."}
              </p>
            </div>
            {role === "admin" && (
              <button
                onClick={() => setShowPaymentModal(true)}
                className="flex-shrink-0 flex items-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white font-medium text-xs px-3 py-1.5 rounded-md shadow-sm transition-colors"
              >
                <CreditCard size={13} /> Upgrade Storage
              </button>
            )}
          </div>
        )}
        {view === "worklog" ? (
          <WorkLogView currentUser={currentUser} setToast={setToast} />
        ) : view === "team" ? (
          <TeamView setToast={setToast} currentUser={currentUser} onCurrentUserUpdate={setCurrentUser} />
        ) : editing ? (
          <EditView
            key={editing.__editKey}
            editing={editing}
            setEditing={setEditing}
            folderTree={editing.__space === "team" ? flatTeamFolderTree : flatFolderTree}
            onCreateFolder={(name, parentId) => createFolder(name, parentId, editing.__space || "personal")}
            canChooseTeamSpace={canEditTeam}
            onSave={saveEdit}
            onCancel={() => { setEditing(null); setEditingConflict(null); }}
            titleError={titleError}
            titleErrorMsg={titleErrorMsg}
            setTitleError={setTitleError}
            activeUsers={pageActiveUsers}
            currentUser={currentUser}
            editingConflict={editingConflict}
            setEditingConflict={setEditingConflict}
          />
        ) : selected ? (
          <PageView
            page={selected}
            activeUsers={pageActiveUsers}
            isTeamPage={selectedSpace === "team"}
            folderPathStr={fullPagePathStr(selected)}
            canEdit={selectedSpace === "team" ? canEditTeam : canEdit}
            canDelete={selectedSpace === "team" ? canEditTeam : canDelete}
            onEdit={() => startEditPage(selected)}
            onNewSubpage={() => startNewSubpage(selected, selectedSpace)}
            onDelete={() => setConfirmDelete(selected.id)}
            onStatus={(s) => setStatus(selected.id, s)}
            onRemoveAttachment={(fileId) => removeAttachment(selected.id, fileId)}
            onCopyLink={() => copyPageLink(selected)}
            pageHref={pageUrl(selected)}
            currentUser={currentUser}
            setToast={setToast}
            onOpenBackups={() => setVersionHistoryPage(selected)}
          />
        ) : (
          <EmptyState canEdit={canEdit} onNew={() => startNewPage()} currentUser={currentUser} pageCount={pages?.length || 0} />
        )}
      </main>

      {versionHistoryPage && (
        <VersionHistoryModal
          page={versionHistoryPage}
          onClose={() => setVersionHistoryPage(null)}
          onRestore={(ver) => {
            startEditPage({ ...versionHistoryPage, title: ver.title, content: ver.content });
            setVersionHistoryPage(null);
            setToast("Restored backup version into editor — click Save to apply");
          }}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[var(--panel)] border border-[var(--border)] rounded-xl p-5 max-w-sm w-full">
            <p className="text-[var(--text-primary)] text-sm font-medium mb-1">Delete this page?</p>
            <p className="text-[var(--text-muted)] text-xs mb-4">This deletes the page and any subpages under it. This can't be undone.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(null)} className="px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
              <button onClick={() => deletePage(confirmDelete)} className="px-3 py-1.5 text-sm bg-[var(--danger)] hover:bg-[var(--danger-hover)] text-white rounded-md">Delete</button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteFolder && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[var(--panel)] border border-[var(--border)] rounded-xl p-5 max-w-sm w-full">
            <p className="text-[var(--text-primary)] text-sm font-medium mb-1">Delete "{confirmDeleteFolder.name}"?</p>
            <p className="text-[var(--text-muted)] text-xs mb-4">
              {confirmDeleteFolder.pageCount > 0 || confirmDeleteFolder.folderCount > 0
                ? `This deletes ${confirmDeleteFolder.pageCount} page${confirmDeleteFolder.pageCount === 1 ? "" : "s"} and ${confirmDeleteFolder.folderCount} subfolder${confirmDeleteFolder.folderCount === 1 ? "" : "s"} inside it. This can't be undone.`
                : "This folder is empty. This can't be undone."}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDeleteFolder(null)} className="px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
              <button onClick={() => deleteFolderCascade(confirmDeleteFolder.id)} className="px-3 py-1.5 text-sm bg-[var(--danger)] hover:bg-[var(--danger-hover)] text-white rounded-md">Delete</button>
            </div>
          </div>
        </div>
      )}

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />
      )}

      {moveTarget && (
        <MoveDialog
          target={moveTarget}
          flatFolderTree={moveTarget.space === "team" ? flatTeamFolderTree : flatFolderTree}
          excludedIds={moveTarget.type === "folder" ? [moveTarget.id, ...getDescendantFolderIds(moveTarget.id)] : []}
          onClose={() => setMoveTarget(null)}
          onChoose={async (destFolderId) => {
            if (moveTarget.type === "page") await movePageToFolder(moveTarget.id, destFolderId);
            else await moveFolderToParent(moveTarget.id, destFolderId);
            setMoveTarget(null);
          }}
        />
      )}

      {showChangePasswordModal && (
        <ChangePasswordModal onClose={() => setShowChangePasswordModal(false)} setToast={setToast} />
      )}

      {showAboutModal && (
        <AboutModal onClose={() => setShowAboutModal(false)} />
      )}

      {showPaymentModal && role === "admin" && (
        <PaymentModal onClose={() => setShowPaymentModal(false)} setToast={setToast} currentUser={currentUser} />
      )}

      {toast && (
        <div className="fixed bottom-5 right-5 bg-[var(--panel-raised)] border border-[var(--border)] text-[var(--text-primary)] text-sm px-4 py-2.5 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

function ContextMenu({ x, y, items, onClose }) {
  const ref = React.useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.min(x, window.innerWidth - width - 8),
      top: Math.min(y, window.innerHeight - height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 min-w-[190px] bg-[var(--panel)] border border-[var(--border)] rounded-md shadow-xl py-1"
    >
      {items.map((item, i) =>
        item.divider ? (
          <div key={i} className="h-px bg-[var(--border)] my-1" />
        ) : (
          <button
            key={i}
            onClick={() => { item.onClick(); onClose(); }}
            disabled={item.disabled}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${item.danger
              ? "text-[var(--danger)] hover:bg-[var(--panel-raised)]"
              : "text-[var(--text-primary)] hover:bg-[var(--panel-raised)]"
              }`}
          >
            {item.icon && <item.icon size={14} className={item.danger ? "" : "text-[var(--text-muted)]"} />}
            {item.label}
          </button>
        )
      )}
    </div>
  );
}

function MoveDialog({ target, flatFolderTree, excludedIds, onClose, onChoose }) {
  const [moving, setMoving] = useState(false);
  const options = flatFolderTree.filter((f) => !excludedIds.includes(f.id));

  const choose = async (id) => {
    setMoving(true);
    await onChoose(id);
    setMoving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[var(--panel)] border border-[var(--border)] rounded-xl p-5 max-w-sm w-full max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <p className="text-[var(--text-primary)] text-sm font-medium mb-1">Move "{target.name}"</p>
        <p className="text-[var(--text-muted)] text-xs mb-4">Choose a destination.</p>
        <div className="overflow-y-auto flex-1 -mx-1">
          <button
            onClick={() => choose(null)}
            disabled={moving}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-[var(--text-primary)] hover:bg-[var(--panel-raised)] rounded-md disabled:opacity-60"
          >
            <Folder size={14} className="text-[var(--text-muted)]" /> Top level (no folder)
          </button>
          {options.map((f) => (
            <button
              key={f.id}
              onClick={() => choose(f.id)}
              disabled={moving}
              style={{ paddingLeft: 12 + f.depth * 16 }}
              className="w-full flex items-center gap-2 pr-3 py-2 text-sm text-left text-[var(--text-primary)] hover:bg-[var(--panel-raised)] rounded-md disabled:opacity-60"
            >
              <Folder size={14} className="text-[var(--text-muted)] flex-shrink-0" /> <span className="truncate">{f.name}</span>
            </button>
          ))}
          {options.length === 0 && (
            <p className="text-[var(--text-dim)] text-xs px-3 py-2">No other folders available.</p>
          )}
        </div>
        <div className="flex justify-end pt-3 mt-2 border-t border-[var(--border)]">
          <button onClick={onClose} disabled={moving} className="px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ThemeToggle({ value, onChange }) {
  const options = [
    { key: "light", icon: Sun, label: "Light" },
    { key: "dark", icon: Moon, label: "Dark" },
    { key: "system", icon: Monitor, label: "System" },
  ];
  return (
    <div className="flex items-center gap-0.5 bg-[var(--panel-raised)] border border-[var(--border)] rounded-md p-0.5">
      {options.map(({ key, icon: Icon, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          title={label}
          className={`w-7 h-7 rounded flex items-center justify-center transition-colors ${value === key ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  );
}

function FolderNode({
  folder, depth, space, canEditSpace, childFolders, pagesInFolder, childPages, query, filteredIds, folderHasMatch,
  collapsed, toggleFolder, selectedId, editingId, onSelectPage,
  canEdit, onFolderContextMenu, onPageContextMenu, pageHref,
  creatingFolderUnder, newFolderName, setNewFolderName, onConfirmCreateFolder, onCancelCreateFolder,
  renaming, renameValue, setRenameValue, onConfirmRename, onCancelRename, openPageMenu,
}) {
  if (query && !folderHasMatch(folder.id)) return null;

  const kids = childFolders(folder.id);
  const pgs = pagesInFolder(folder.id);
  const visiblePages = pgs.filter((p) => !p.parentId);
  const isCollapsed = query ? false : !!collapsed[folder.id];
  const indent = 12 + depth * 16;
  const isRenamingThis = renaming?.type === "folder" && renaming.id === folder.id;

  return (
    <div>
      {isRenamingThis ? (
        <div className="flex items-center gap-1.5 py-1" style={{ paddingLeft: indent }}>
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onConfirmRename(); if (e.key === "Escape") onCancelRename(); }}
            onBlur={onConfirmRename}
            className="flex-1 bg-[var(--panel-raised)] border border-[var(--accent-60)] rounded-md px-2 py-1 text-sm text-[var(--text-primary)] focus:outline-none"
          />
        </div>
      ) : (
        <div
          className="group flex items-center gap-1 pr-2 hover:bg-[var(--panel-raised)] rounded-md"
          style={{ paddingLeft: indent }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onFolderContextMenu(e, folder); }}
        >
          <button
            onClick={() => toggleFolder(folder.id)}
            className="flex items-center gap-1.5 flex-1 min-w-0 py-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm uppercase tracking-wider"
          >
            {isCollapsed ? <ChevronRight size={12} className="flex-shrink-0" /> : <ChevronDown size={12} className="flex-shrink-0" />}
            <Folder size={12} className="flex-shrink-0" />
            <span className="flex-1 text-left truncate normal-case">{folder.name}</span>
            <span className="text-[var(--text-dim)] flex-shrink-0">{visiblePages.length}</span>
          </button>
          {canEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onFolderContextMenu(e, folder); }}
              title="More actions"
              className="hidden group-hover:block p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] flex-shrink-0"
            >
              <MoreVertical size={13} />
            </button>
          )}
        </div>
      )}

      {creatingFolderUnder === folder.id && (
        <div className="flex items-center gap-1.5 py-1" style={{ paddingLeft: indent + 18 }}>
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onConfirmCreateFolder(); if (e.key === "Escape") onCancelCreateFolder(); }}
            placeholder="Folder name"
            className="flex-1 bg-[var(--panel-raised)] border border-[var(--accent-60)] rounded-md px-2 py-1 text-sm text-[var(--text-primary)] focus:outline-none"
          />
          <button onClick={onConfirmCreateFolder} className="text-[var(--accent)] hover:text-[var(--accent-hover)] p-1"><CheckCircle2 size={13} /></button>
          <button onClick={onCancelCreateFolder} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1"><X size={13} /></button>
        </div>
      )}

      {!isCollapsed && (
        <>
          {kids.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              depth={depth + 1}
              space={space}
              canEditSpace={canEditSpace}
              childFolders={childFolders}
              pagesInFolder={pagesInFolder}
              childPages={childPages}
              query={query}
              filteredIds={filteredIds}
              folderHasMatch={folderHasMatch}
              collapsed={collapsed}
              toggleFolder={toggleFolder}
              selectedId={selectedId}
              editingId={editingId}
              onSelectPage={onSelectPage}
              canEdit={canEdit}
              onFolderContextMenu={onFolderContextMenu}
              onPageContextMenu={onPageContextMenu}
              pageHref={pageHref}
              creatingFolderUnder={creatingFolderUnder}
              newFolderName={newFolderName}
              setNewFolderName={setNewFolderName}
              onConfirmCreateFolder={onConfirmCreateFolder}
              onCancelCreateFolder={onCancelCreateFolder}
              renaming={renaming}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              onConfirmRename={onConfirmRename}
              onCancelRename={onCancelRename}
              openPageMenu={openPageMenu}
            />
          ))}
          {visiblePages.map((p) => (
            <PageNode
              key={p.id}
              page={p}
              depth={depth + 1}
              space={space}
              canEditSpace={canEditSpace}
              childPages={childPages}
              query={query}
              filteredIds={filteredIds}
              collapsed={collapsed}
              toggleFolder={toggleFolder}
              selectedId={selectedId}
              editingId={editingId}
              onSelectPage={onSelectPage}
              onPageContextMenu={onPageContextMenu}
              pageHref={pageHref}
              renaming={renaming}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              onConfirmRename={onConfirmRename}
              onCancelRename={onCancelRename}
              openPageMenu={openPageMenu}
            />
          ))}
        </>
      )}
    </div>
  );
}

function PageNode({
  page,
  depth = 0,
  space,
  canEditSpace,
  childPages,
  query,
  filteredIds,
  collapsed,
  toggleFolder,
  selectedId,
  editingId,
  onSelectPage,
  onPageContextMenu,
  pageHref,
  renaming,
  renameValue,
  setRenameValue,
  onConfirmRename,
  onCancelRename,
  openPageMenu,
}) {
  const kids = childPages(page.id);
  const visibleKids = query
    ? kids.filter((p) => filteredIds.has(p.id) || kidsHasMatch(p, childPages, filteredIds))
    : kids;
  const hasKids = kids.length > 0;
  const isCollapsed = query ? false : !!collapsed[page.id];
  const indent = 12 + depth * 16;
  const StatusIcon = STATUS_META[page.status]?.Icon || Circle;
  const active = page.id === selectedId && !editingId;
  const isRenamingPage = renaming?.type === "page" && renaming.id === page.id;

  if (query && !filteredIds.has(page.id) && visibleKids.length === 0) {
    return null;
  }

  return (
    <div>
      {isRenamingPage ? (
        <div className="flex items-center gap-1.5 py-1 pr-2" style={{ paddingLeft: indent }}>
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onConfirmRename(); if (e.key === "Escape") onCancelRename(); }}
            onBlur={onConfirmRename}
            className="flex-1 bg-[var(--panel-raised)] border border-[var(--accent-60)] rounded-md px-2 py-1 text-sm text-[var(--text-primary)] focus:outline-none"
          />
        </div>
      ) : (
        <div
          className="group flex items-center gap-1 pr-2 hover:bg-[var(--panel-raised)] rounded-md"
          style={{ paddingLeft: indent }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onPageContextMenu(e, page); }}
        >
          {hasKids ? (
            <button
              onClick={(e) => { e.stopPropagation(); toggleFolder(page.id); }}
              className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] flex-shrink-0"
              title={isCollapsed ? "Expand subpages" : "Collapse subpages"}
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
          ) : (
            <div className="w-4 flex-shrink-0" />
          )}

          <a
            href={pageHref(page)}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onSelectPage(page);
            }}
            className={`flex-1 min-w-0 flex items-center gap-2 py-1.5 text-[15px] text-left no-underline transition-colors ${active ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
          >
            <StatusIcon size={13} style={{ color: STATUS_META[page.status]?.color }} className="flex-shrink-0" />
            <span className="truncate">{page.title}</span>
          </a>

          <button
            onClick={(e) => { e.stopPropagation(); openPageMenu(e, page, space, canEditSpace); }}
            title="More actions"
            className="hidden group-hover:block p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] flex-shrink-0"
          >
            <MoreVertical size={13} />
          </button>
        </div>
      )}

      {!isCollapsed && visibleKids.map((child) => (
        <PageNode
          key={child.id}
          page={child}
          depth={depth + 1}
          space={space}
          canEditSpace={canEditSpace}
          childPages={childPages}
          query={query}
          filteredIds={filteredIds}
          collapsed={collapsed}
          toggleFolder={toggleFolder}
          selectedId={selectedId}
          editingId={editingId}
          onSelectPage={onSelectPage}
          onPageContextMenu={onPageContextMenu}
          pageHref={pageHref}
          renaming={renaming}
          renameValue={renameValue}
          setRenameValue={setRenameValue}
          onConfirmRename={onConfirmRename}
          onCancelRename={onCancelRename}
          openPageMenu={openPageMenu}
        />
      ))}
    </div>
  );
}

function kidsHasMatch(p, childPages, filteredIds) {
  const kids = childPages(p.id);
  return kids.some((k) => filteredIds.has(k.id) || kidsHasMatch(k, childPages, filteredIds));
}

function NavTab({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors ${active ? "bg-[var(--accent-15)] text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--panel-raised)]"
        }`}
    >
      <Icon size={13} /> {label}
    </button>
  );
}

function EmptyState({ canEdit, onNew, currentUser, pageCount }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6">
      <div className="w-12 h-12 rounded-lg bg-[var(--panel-raised)] border border-[var(--border)] flex items-center justify-center mb-4">
        <FileText size={20} className="text-[var(--text-muted)]" />
      </div>
      <h2 className="text-[var(--text-primary)] text-lg font-medium mb-1" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
        {pageCount === 0 ? "Nothing here yet" : "Select a page"}
      </h2>
      <p className="text-[var(--text-muted)] text-sm max-w-xs mb-6">
        {pageCount === 0
          ? "Your private space is empty. Create your first page to get started."
          : `${pageCount} page${pageCount === 1 ? "" : "s"} in your private space. Pick one from the sidebar, or create a new one.`}
      </p>
      {canEdit && (
        <button onClick={onNew} className="flex items-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium px-4 py-2 rounded-md">
          <Plus size={15} /> Create a page
        </button>
      )}
      <div className="flex items-center gap-1.5 text-[var(--text-dim)] text-xs mt-8">
        <Users size={12} /> signed in as {currentUser.name} — only you can see this
      </div>
    </div>
  );
}

function VerifyEmailScreen({ email, onVerified }) {
  const [checking, setChecking] = useState(false);
  const [resending, setResending] = useState(false);
  const [message, setMessage] = useState("");
  const [notYet, setNotYet] = useState(false);

  const handleCheckAgain = async () => {
    setChecking(true);
    setMessage("");
    setNotYet(false);
    try {
      const verified = await refreshEmailVerified();
      if (verified) {
        await onVerified();
      } else {
        setNotYet(true);
      }
    } catch {
      setMessage("Couldn't check right now — try again in a moment.");
    } finally {
      setChecking(false);
    }
  };

  const handleResend = async () => {
    setResending(true);
    setMessage("");
    try {
      await resendVerificationEmail();
      setMessage("Sent — check your inbox (and spam folder).");
    } catch (err) {
      setMessage(err.message || "Couldn't resend right now.");
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[var(--bg-void)] p-6" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <div className="w-full max-w-sm text-center">
        <div className="w-12 h-12 rounded-lg bg-[var(--accent-15)] border border-[var(--accent-30)] flex items-center justify-center mx-auto mb-5">
          <Mail size={20} className="text-[var(--accent)]" />
        </div>
        <h2 className="text-[var(--text-primary)] text-lg font-medium mb-2" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
          Verify your email
        </h2>
        <p className="text-[var(--text-muted)] text-sm mb-1">We sent a confirmation link to</p>
        <p className="text-[var(--text-primary)] text-sm font-medium mb-6">{email}</p>

        <button
          onClick={handleCheckAgain}
          disabled={checking}
          className="w-full flex items-center justify-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-60 text-white text-sm font-medium py-2 rounded-md transition-colors mb-2"
        >
          {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          I've clicked it — check again
        </button>
        <button
          onClick={handleResend}
          disabled={resending}
          className="w-full text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xs py-2 disabled:opacity-60"
        >
          {resending ? "Sending…" : "Resend the email"}
        </button>

        {notYet && <p className="text-[var(--warning)] text-xs mt-2">Not verified yet — click the link in the email first.</p>}
        {message && <p className="text-[var(--text-muted)] text-xs mt-2">{message}</p>}

        <button
          onClick={() => signOut()}
          className="text-[var(--text-dim)] hover:text-[var(--text-muted)] text-xs mt-8"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

const TEAM_MEMBERS_DUMMY = [
  { name: "Alex Rivers", email: "dev-admin@chorus.lan", role: "Admin", team: "Chorus Engineering" },
  { name: "Sarah Chen", email: "sarah.chen@chorus.lan", role: "Cloud Engineer", team: "Chorus Engineering" },
  { name: "David Kim", email: "david.kim@chorus.lan", role: "DevOps Intern", team: "Chorus Engineering" },
];

function ChangePasswordModal({ onClose, setToast }) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (newPassword.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await changeUserPassword(newPassword);
      setToast("Password updated successfully");
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to update password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[var(--overlay)] flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[var(--panel)] border border-[var(--border)] rounded-xl p-6 max-w-sm w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <KeyRound size={18} className="text-[var(--accent)]" />
            <h2 className="text-[var(--text-primary)] text-base font-semibold m-0">Change Password</h2>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-[var(--text-secondary)] block mb-1">New Password</label>
            <input
              type="password"
              required
              minLength={6}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 6 characters"
              className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
            />
          </div>
          <div>
            <label className="text-xs text-[var(--text-secondary)] block mb-1">Confirm New Password</label>
            <input
              type="password"
              required
              minLength={6}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter new password"
              className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
            />
          </div>
          {error && <p className="text-[var(--danger)] text-xs">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
            <button
              type="submit"
              disabled={busy}
              className="flex items-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs px-3.5 py-1.5 rounded-md font-medium disabled:opacity-60"
            >
              {busy && <Loader2 size={12} className="animate-spin" />} Save Password
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AboutModal({ onClose }) {
  const host = typeof window !== "undefined" ? window.location.hostname.toLowerCase() : "";
  const isDevHost = host.includes("dev") || host.includes("localhost") || host === "127.0.0.1" || host.includes("staging");

  const explicitEnv = import.meta.env.VITE_APP_ENV ? import.meta.env.VITE_APP_ENV.toLowerCase() : null;
  const currentEnv = explicitEnv || (isDevHost ? "development" : (import.meta.env.MODE || (import.meta.env.DEV ? "development" : "production"))).toLowerCase();
  const isProd = currentEnv === "production";
  const envLabel = isProd ? "Production" : "Development";

  const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "2026.4.1";

  return (
    <div className="fixed inset-0 bg-[var(--overlay)] flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[var(--panel)] border border-[var(--border)] rounded-xl p-6 max-w-md w-full shadow-2xl text-center" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-center mb-3">
          <RaftPagesLogo size={48} />
        </div>
        <h2 className="text-[var(--text-primary)] text-xl font-bold tracking-tight mb-1" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
          Raft<span className="text-[var(--accent)]">Pages</span>
        </h2>
        <p className="text-[var(--accent)] font-mono text-xs font-semibold mb-4">Version {appVersion} (Enterprise Edition)</p>
        <div className="bg-[var(--panel-raised)] border border-[var(--border)] rounded-lg p-4 text-left text-xs text-[var(--text-secondary)] space-y-2 mb-5 font-mono">
          <div className="flex justify-between items-center">
            <span className="text-[var(--text-dim)]">Version:</span>
            <span className="text-[var(--text-primary)] font-semibold">v{appVersion}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-[var(--text-dim)]">Environment:</span>
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${isProd ? "bg-[var(--success)]/15 text-[var(--success)] border border-[var(--success)]/30" : "bg-[var(--warning)]/15 text-[var(--warning)] border border-[var(--warning)]/30"}`}>
              {envLabel}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-[var(--text-dim)]">Release:</span>
            <span className="text-[var(--text-primary)] font-semibold">
              {typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "20261102-1652"}
            </span>
          </div>
        </div>
        <p className="text-[var(--text-muted)] text-xs mb-5 leading-relaxed">
          RaftPages provides secure, real-time technical documentation, work log tracking, and collaborative runbook management for engineering teams.
        </p>
        <button
          onClick={onClose}
          className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium py-2 rounded-md transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function PaymentModal({ onClose, setToast, currentUser }) {
  const [gbAmount, setGbAmount] = useState(100);
  const [cardNumber, setCardNumber] = useState("");
  const [expDate, setExpDate] = useState("");
  const [cvv, setCvv] = useState("");
  const [billingName, setBillingName] = useState(currentUser?.name || "");
  const [checkoutMode, setMode] = useState("stripe"); // 'stripe' or 'card'
  const [processing, setProcessing] = useState(false);
  const [success, setSuccess] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const [userCount, setUserCount] = useState(1);

  useEffect(() => {
    if (currentUser?.team_name) {
      teamApi.list()
        .then((users) => setUserCount(users?.length || 1))
        .catch(() => setUserCount(1));
    }
  }, [currentUser]);

  const ratePerGbUser = 0.25;
  const monthlyCost = (gbAmount * ratePerGbUser * userCount).toFixed(2);
  const totalPoolGb = 5 + gbAmount;

  const handleCheckout = async (e) => {
    e.preventDefault();
    setProcessing(true);
    setPaymentError("");

    try {
      const data = await billing.createCheckoutSession(gbAmount);
      if (data && data.url) {
        window.location.href = data.url;
      } else {
        throw new Error("Invalid checkout response from server");
      }
    } catch (err) {
      setPaymentError(err.message || "Checkout session initialization failed");
      setToast("Checkout error: " + (err.message || "Failed to launch Stripe"));
      setProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[var(--overlay)] flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[var(--panel)] border border-[var(--border)] rounded-2xl p-6 max-w-lg w-full shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4 pb-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <Shield size={20} className="text-[var(--accent)]" />
            <div>
              <h2 className="text-[var(--text-primary)] text-base font-semibold m-0">Secure Upgrade & Billing</h2>
              <p className="text-[var(--text-dim)] text-xs m-0">Stripe SSL Hosted Gateway</p>
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1">
            <X size={18} />
          </button>
        </div>

        {success ? (
          <div className="text-center py-8 space-y-3">
            <div className="w-12 h-12 rounded-full bg-[var(--success)]/20 text-[var(--success)] flex items-center justify-center mx-auto">
              <CheckCircle2 size={28} />
            </div>
            <h3 className="text-[var(--text-primary)] text-lg font-bold">Quota Upgraded Successfully!</h3>
            <p className="text-[var(--text-muted)] text-xs max-w-xs mx-auto">
              Your account storage pool has been boosted by <span className="font-semibold text-[var(--text-primary)]">+{gbAmount} GB</span> at <span className="font-semibold text-[var(--accent)]">${monthlyCost}/mo</span>.
            </p>
            <button
              onClick={onClose}
              className="mt-4 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs px-6 py-2 rounded-md font-medium"
            >
              Back to RaftPages
            </button>
          </div>
        ) : (
          <form onSubmit={handleCheckout} className="space-y-4">
            {/* Team & User Seats Breakdown */}
            <div className="bg-[var(--panel-raised)] border border-[var(--border)] rounded-xl p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                  <Users size={14} className="text-[var(--accent)]" /> Active Team Users & Seats
                </span>
                <span className="text-[11px] font-semibold text-[var(--accent)] bg-[var(--accent-15)] px-2.5 py-0.5 rounded-full border border-[var(--accent-30)]">
                  {currentUser?.team_name ? `${userCount} Active ${userCount === 1 ? "User" : "Users"}` : "1 Individual User"}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px] text-[var(--text-secondary)] pt-1.5 border-t border-[var(--border)]/60">
                <div>
                  <span className="text-[var(--text-dim)] block text-[10px]">Team / Account Name</span>
                  <span className="font-medium text-[var(--text-primary)] truncate block">{currentUser?.team_name || "Individual Account"}</span>
                </div>
                <div>
                  <span className="text-[var(--text-dim)] block text-[10px]">Plan Seats Included</span>
                  <span className="font-medium text-[var(--text-primary)] block">Up to 5 Users Included ($0/seat)</span>
                </div>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-[var(--text-primary)]">Shared Storage Pool Expansion ($0.25/GB/mo/user)</label>
                <span className="text-xs font-bold text-[var(--accent)] font-mono">${monthlyCost} / month</span>
              </div>

              <div className="bg-[var(--panel-raised)] border border-[var(--border)] rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between text-xs font-semibold text-[var(--text-primary)]">
                  <span>Additional Shared Pool: +{gbAmount} GB</span>
                  <span className="text-[var(--text-dim)] text-[11px]">Total Org Pool: {totalPoolGb} GB</span>
                </div>
                <input
                  type="range"
                  min="20"
                  max="1000"
                  step="20"
                  value={gbAmount}
                  onChange={(e) => setGbAmount(Number(e.target.value))}
                  className="w-full accent-[var(--accent)] cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-[var(--text-dim)] font-mono">
                  <span>+20 GB</span>
                  <span>+250 GB</span>
                  <span>+500 GB</span>
                  <span>+1,000 GB</span>
                </div>
                <div className="text-[11px] text-[var(--text-muted)] space-y-1 pt-2 border-t border-[var(--border)]/60">
                  <div className="flex justify-between">
                    <span>Billing Formula:</span>
                    <span className="font-mono text-[var(--text-primary)]">${ratePerGbUser}/GB × {userCount} {userCount === 1 ? "User" : "Users"} × {gbAmount} GB</span>
                  </div>
                  <div className="flex justify-between font-semibold text-[var(--accent)]">
                    <span>Total Monthly Invoice:</span>
                    <span className="font-mono text-xs">${monthlyCost} / mo</span>
                  </div>
                  <p className="text-[10px] text-[var(--text-dim)] pt-0.5 m-0 italic">
                    * All sub-teams and team members draw from the single shared {totalPoolGb} GB organization storage pool without per-user caps.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-3 pt-1 border-t border-[var(--border)]">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-[var(--text-primary)]">Payment Method</label>
                <div className="flex gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setMode("stripe")}
                    className={`px-2 py-0.5 rounded ${checkoutMode === "stripe" ? "bg-[var(--accent-15)] text-[var(--accent)] font-semibold" : "text-[var(--text-dim)]"}`}
                  >
                    Stripe Hosted
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("card")}
                    className={`px-2 py-0.5 rounded ${checkoutMode === "card" ? "bg-[var(--accent-15)] text-[var(--accent)] font-semibold" : "text-[var(--text-dim)]"}`}
                  >
                    Credit Card
                  </button>
                </div>
              </div>

              {checkoutMode === "card" ? (
                <div className="space-y-2">
                  <div>
                    <span className="text-[11px] text-[var(--text-dim)] block mb-1">Cardholder Name</span>
                    <input
                      value={billingName}
                      onChange={(e) => setBillingName(e.target.value)}
                      required
                      className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-3 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
                    />
                  </div>
                  <div>
                    <span className="text-[11px] text-[var(--text-dim)] block mb-1">Card Number</span>
                    <input
                      value={cardNumber}
                      onChange={(e) => setCardNumber(e.target.value)}
                      placeholder="4242 •••• •••• 4242"
                      required
                      className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-3 py-1.5 text-xs font-mono text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-[11px] text-[var(--text-dim)] block mb-1">Expires</span>
                      <input
                        value={expDate}
                        onChange={(e) => setExpDate(e.target.value)}
                        placeholder="MM/YY"
                        required
                        className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-3 py-1.5 text-xs font-mono text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
                      />
                    </div>
                    <div>
                      <span className="text-[11px] text-[var(--text-dim)] block mb-1">CVV Security Code</span>
                      <input
                        type="password"
                        value={cvv}
                        onChange={(e) => setCvv(e.target.value)}
                        placeholder="•••"
                        required
                        maxLength={4}
                        className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-3 py-1.5 text-xs font-mono text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-3 bg-[var(--panel-raised)] border border-[var(--border)] rounded-xl text-center space-y-1">
                  <div className="text-xs text-[var(--text-primary)] font-medium">Stripe SSL Hosted Checkout</div>
                  <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                    You will be redirected to Stripe's secure SSL page to enter your card details and complete payment.
                  </p>
                </div>
              )}
            </div>

            {paymentError && (
              <div className="p-3 bg-[var(--danger)]/15 border border-[var(--danger)]/30 rounded-lg flex items-start gap-2 text-xs text-[var(--danger)] animate-in fade-in duration-150">
                <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
                <span className="leading-relaxed">{paymentError}</span>
              </div>
            )}

            <div className="pt-2">
              <button
                type="submit"
                disabled={processing}
                className="w-full flex items-center justify-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium py-2.5 rounded-md shadow-md transition-all disabled:opacity-60"
              >
                {processing ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                {processing
                  ? "Redirecting to Stripe SSL..."
                  : `Proceed to Checkout (+$${monthlyCost}/mo for +${gbAmount} GB)`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function LoginScreen({ onProfileComplete, idleLoggedOut, onDismissIdleNotice }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkSent, setLinkSent] = useState(false);

  const [mode, setMode] = useState("signin");
  const [name, setName] = useState("");
  const [teamName, setTeamName] = useState("");
  const [dataResidencyRegion, setDataResidencyRegion] = useState("EU (europe-west1) - GDPR Compliant");
  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  const [showReset, setShowReset] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetError, setResetError] = useState("");

  const handleForgotPassword = async () => {
    if (!email) {
      setResetError("Enter your email above first");
      setShowReset(true);
      return;
    }
    setResetError(""); setResetBusy(true); setShowReset(true);
    try {
      await sendPasswordReset(email);
      setResetSent(true);
    } catch (err) {
      setResetError(friendlyAuthError(err));
    } finally {
      setResetBusy(false);
    }
  };

  const handleGoogle = async () => {
    onDismissIdleNotice?.();
    setError(""); setBusy(true);
    try {
      await googleSignIn();
    } catch (err) {
      setError(err.message || "Google sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const handleMagicLink = async (e) => {
    e.preventDefault();
    onDismissIdleNotice?.();
    setError(""); setBusy(true);
    try {
      await sendMagicLink(email);
      setLinkSent(true);
    } catch (err) {
      setError(err.message || "Couldn't send the link");
    } finally {
      setBusy(false);
    }
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    onDismissIdleNotice?.();
    setPwError(""); setPwBusy(true);
    try {
      if (mode === "signup") {
        await passwordSignUp(email, password, name);
        try { await auth.completeProfile({ name, teamName, dataResidencyRegion }); } catch { }
      } else {
        await passwordSignIn(email, password);
      }
    } catch (err) {
      setPwError(friendlyAuthError(err));
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[var(--bg-void)] p-6" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-8 justify-center">
          <RaftPagesLogo size={36} />
          <span className="text-[var(--text-primary)] text-xl font-bold tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            Raft<span className="text-[var(--accent)]">Pages</span>
          </span>
        </div>

        {idleLoggedOut && (
          <div className="flex items-center gap-2 mb-4 p-3 rounded-md bg-[var(--warning)]/15 border border-[var(--warning)]/30">
            <Clock size={14} className="text-[var(--warning)] flex-shrink-0" />
            <p className="text-[var(--text-primary)] text-xs">You were signed out after 5 hours of inactivity.</p>
          </div>
        )}

        <div className="bg-[var(--panel)] border border-[var(--border)] rounded-xl p-6">
          <h1 className="text-[var(--text-primary)] text-base font-medium mb-4">
            {mode === "signup" ? "Create your account" : "Sign in"}
          </h1>

          <form onSubmit={handlePasswordSubmit} className="space-y-3">
            {mode === "signup" && (
              <>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  required
                  className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-60)]"
                />
                <input
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="Company / team name (optional)"
                  className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-60)]"
                />
                <div>
                  <label className="text-[11px] text-[var(--text-secondary)] block mb-1">Data Residency & Compliance Zone</label>
                  <select
                    value={dataResidencyRegion}
                    onChange={(e) => setDataResidencyRegion(e.target.value)}
                    className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
                  >
                    <option value="EU (europe-west1) - GDPR Compliant">🇪🇺 EU (europe-west1) — GDPR Compliant</option>
                    <option value="US (us-central1) - SOC2/HIPAA Compliant">🇺🇸 US (us-central1) — SOC2 / HIPAA Compliant</option>
                    <option value="Asia (asia-east1) - APPI Compliant">🇯🇵 Asia (asia-east1) — APPI Compliant</option>
                    <option value="UK (europe-west2) - UK GDPR Compliant">🇬🇧 UK (europe-west2) — UK GDPR Compliant</option>
                  </select>
                </div>
                <p className="text-[var(--text-dim)] text-[11px] -mt-1.5 leading-relaxed">
                  {teamName.trim()
                    ? "You'll be the admin for this team. Compliance zone locked to your region."
                    : "Leave blank to sign up as an individual user."}
                </p>
              </>
            )}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-60)]"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
              minLength={6}
              className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-60)]"
            />
            {mode === "signin" && (
              <button
                type="button"
                onClick={handleForgotPassword}
                className="text-[var(--text-muted)] hover:text-[var(--accent)] text-xs -mt-1"
              >
                Forgot password?
              </button>
            )}
            {pwError && <p className="text-[var(--danger)] text-xs">{pwError}</p>}
            <button
              type="submit"
              disabled={pwBusy}
              className="w-full flex items-center justify-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-60 text-white text-sm font-medium py-2 rounded-md transition-colors"
            >
              {pwBusy && <Loader2 size={14} className="animate-spin" />}
              {mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>

          <button
            type="button"
            onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setPwError(""); }}
            className="w-full text-center text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xs mt-3"
          >
            {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
          </button>

          {showReset && (
            <div className="mt-3 p-3 rounded-md bg-[var(--panel-raised)] border border-[var(--border)]">
              {resetBusy ? (
                <p className="text-[var(--text-muted)] text-xs flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> Sending reset link…
                </p>
              ) : resetSent ? (
                <p className="text-[var(--success)] text-xs">
                  Check <span className="font-medium">{email}</span> for a password reset link.
                </p>
              ) : resetError ? (
                <p className="text-[var(--danger)] text-xs">{resetError}</p>
              ) : null}
              <button
                type="button"
                onClick={() => { setShowReset(false); setResetSent(false); setResetError(""); }}
                className="text-[var(--text-dim)] hover:text-[var(--text-muted)] text-xs mt-1.5"
              >
                Dismiss
              </button>
            </div>
          )}

          <div className="flex items-center gap-2 my-4">
            <div className="h-px bg-[var(--border)] flex-1" />
            <span className="text-[var(--text-dim)] text-xs">or</span>
            <div className="h-px bg-[var(--border)] flex-1" />
          </div>

          <button
            type="button"
            onClick={handleGoogle}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2.5 bg-[#4285F4] hover:bg-[#3367D6] active:bg-[#2851A3] disabled:opacity-60 text-white text-sm font-medium py-2.5 px-4 rounded-md transition-all shadow-sm mb-3"
          >
            <div className="w-5 h-5 bg-white rounded flex items-center justify-center p-0.5 shadow-xs">
              <svg width="14" height="14" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.5-.4-3.5z" /><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 44c5.5 0 10.4-1.9 14.3-5.1l-6.6-5.6C29.7 35 27 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.6 39.6 16.3 44 24 44z" /><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.3-4.1 5.7l6.6 5.6C41.9 35.8 44 30.3 44 24c0-1.3-.1-2.5-.4-3.5z" /></svg>
            </div>
            Continue with Google
          </button>

          {linkSent ? (
            <p className="text-[var(--success)] text-sm text-center py-2">
              Check <span className="font-medium">{email}</span> for a sign-in link.
            </p>
          ) : (
            <button
              type="button"
              onClick={handleMagicLink}
              disabled={busy || !email}
              title={!email ? "Enter your email above first" : ""}
              className="w-full flex items-center justify-center gap-1.5 bg-[var(--panel-raised)] hover:bg-[var(--panel-raised-hover)] border border-[var(--border)] disabled:opacity-50 text-[var(--text-primary)] text-sm font-medium py-2.5 rounded-md transition-colors"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              Email me a sign-in link instead
            </button>
          )}
          {error && <p className="text-[var(--danger)] text-xs mt-2">{error}</p>}
        </div>
        <p className="text-[var(--text-dim)] text-xs text-center mt-4 leading-relaxed">
          The first person to sign in becomes the team admin. Everyone after starts as an individual user until promoted.
        </p>
      </div>
    </div>
  );
}

function WorkLogView({ currentUser, setToast }) {
  const [entries, setEntries] = useState(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await window.storage.get(WORKLOG_KEY, false);
      setEntries(res ? JSON.parse(res.value) : []);
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addEntry = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSaving(true);
    const entry = { id: uid(), text: text.trim(), createdAt: new Date().toISOString() };
    const next = [entry, ...(entries || [])];
    setEntries(next);
    setText("");
    try {
      await window.storage.set(WORKLOG_KEY, JSON.stringify(next), false);
      setToast("Log entry added");
    } catch {
      setToast("Couldn't save — try again");
    } finally {
      setSaving(false);
    }
  };

  const removeEntry = async (id) => {
    const next = (entries || []).filter((e) => e.id !== id);
    setEntries(next);
    try { await window.storage.set(WORKLOG_KEY, JSON.stringify(next), false); } catch { }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto w-full max-w-2xl mx-auto px-8 py-10">
      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] mb-3">
        <NotebookPen size={12} /> Private to {currentUser.name}
      </div>
      <h1 className="text-[var(--text-primary)] text-2xl font-medium leading-tight mb-6" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
        My Work Log
      </h1>

      <form onSubmit={addEntry} className="mb-8">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What did you work on? e.g. Investigated payment-gateway timeout, opened issue #482, deployed hotfix to staging."
          rows={3}
          className="w-full bg-[var(--panel)] border border-[var(--border)] rounded-lg p-3 text-sm text-[var(--text-body)] leading-relaxed focus:outline-none focus:border-[var(--accent-60)] resize-y"
        />
        <button
          type="submit"
          disabled={saving || !text.trim()}
          className="mt-2 flex items-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white text-sm font-medium px-3.5 py-1.5 rounded-md"
        >
          <Plus size={14} /> Add entry
        </button>
      </form>

      {entries === null ? (
        <p className="text-[var(--text-muted)] text-sm">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-[var(--text-muted)] text-sm">No entries yet — log your first update above.</p>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div key={entry.id} className="group flex items-start gap-3 bg-[var(--panel)] border border-[var(--border)] rounded-lg p-3.5">
              <div className="flex-1 min-w-0">
                <p className="text-[var(--text-body)] text-sm leading-relaxed whitespace-pre-wrap">{entry.text}</p>
                <p className="text-[var(--text-dim)] text-xs font-mono mt-1.5">{fmtDateTime(entry.createdAt)}</p>
              </div>
              <button
                onClick={() => removeEntry(entry.id)}
                className="opacity-0 group-hover:opacity-100 text-[var(--text-dim)] hover:text-[var(--danger)] flex-shrink-0 transition-opacity"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function StorageBar({ usedBytes, quotaBytes }) {
  const pct = Math.min(100, Math.round((usedBytes / quotaBytes) * 100));
  const color = pct >= 85 ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-[var(--accent)]";
  return (
    <div>
      <div className="flex justify-between text-xs text-[var(--text-muted)] mb-1">
        <span>{fmtBytes(usedBytes)} used</span>
        <span>{fmtBytes(quotaBytes)} total ({pct}%)</span>
      </div>
      <div className="w-full h-2 rounded-full bg-[var(--panel-raised)] overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function TeamStorageCard({ teamName }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    teamApi.storageStats().then((s) => { setStats(s); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="mb-6 p-4 bg-[var(--panel)] border border-[var(--border)] rounded-xl flex items-center gap-2 text-xs text-[var(--text-muted)]">
      <Loader2 size={13} className="animate-spin" /> Loading storage stats…
    </div>
  );
  if (!stats) return null;

  return (
    <div className="mb-6 p-4 bg-[var(--panel)] border border-[var(--border)] rounded-xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
          <HardDrive size={15} className="text-[var(--accent)]" /> Team Storage & Capacity
        </div>
        <button onClick={() => setExpanded(v => !v)} className="text-xs text-[var(--accent)] hover:underline">
          {expanded ? "Hide details" : "Show breakdown"}
        </button>
      </div>

      <StorageBar usedBytes={stats.totalUsedBytes} quotaBytes={stats.quotaBytes} />

      {expanded && (
        <div className="space-y-3 pt-2 border-t border-[var(--border)]">
          {/* Shared team assets row */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--text-secondary)] flex items-center gap-1.5"><Users size={11} /> Shared Runbooks & Pages</span>
            <span className="font-mono text-[var(--text-primary)]">{fmtBytes(stats.sharedTeamBytes)}</span>
          </div>

          {/* Sub-team rows */}
          {stats.subTeams.map((st) => (
            <div key={st.name} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                  <Building2 size={11} className="text-[var(--accent)]" /> {st.name}
                  <span className="text-[var(--text-muted)]">({st.memberCount} member{st.memberCount !== 1 ? "s" : ""})</span>
                </span>
                <span className="font-mono text-[var(--text-primary)]">{fmtBytes(st.usedBytes)}</span>
              </div>
              {/* Per-member within sub-team */}
              <div className="pl-5 space-y-0.5">
                {st.members.map((m) => (
                  <div key={m.id} className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                    <span>{m.name} <span className="text-[var(--text-dim)]">({m.role})</span></span>
                    <span className="font-mono">{fmtBytes(m.usedBytes)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TeamView({ setToast, currentUser, onCurrentUserUpdate }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const [showAddTeam, setShowAddTeam] = useState(false);
  const [newSubTeam, setNewSubTeam] = useState("");

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState("");

  const [ownTeamName, setOwnTeamName] = useState("");
  const [savingTeamName, setSavingTeamName] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await teamApi.list();
      setUsers(list);
    } catch (err) {
      setError(err.message || "Failed to load team");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const changeRole = async (id, role) => {
    setUsers((u) => u.map((usr) => (usr.id === id ? { ...usr, role } : usr)));
    try {
      await teamApi.setRole(id, role);
      setToast("Role updated");
    } catch (err) {
      setToast(err.message || "Couldn't update role");
      load();
    }
  };

  const deleteUser = async (id) => {
    setDeletingId(id);
    try {
      const result = await teamApi.remove(id);
      setUsers((u) => u.filter((usr) => usr.id !== id));
      setToast(result.warning || "User deleted");
    } catch (err) {
      setToast(err.message || "Couldn't delete user");
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  const sendInvite = async (e) => {
    e.preventDefault();
    setInviteError("");
    if (users?.some((u) => u.email.toLowerCase() === inviteEmail.trim().toLowerCase())) {
      setInviteError("That person is already on the team.");
      return;
    }
    setInviting(true);
    try {
      await teamApi.invite(inviteEmail.trim());
      await sendMagicLink(inviteEmail.trim());
      setToast(`Invite sent to ${inviteEmail.trim()}`);
      setInviteEmail("");
      setShowInvite(false);
    } catch (err) {
      setInviteError(err.message || "Couldn't send the invite");
    } finally {
      setInviting(false);
    }
  };

  const saveTeamName = async (e) => {
    e.preventDefault();
    if (!ownTeamName.trim()) return;
    setSavingTeamName(true);
    try {
      const updated = await auth.completeProfile({ name: currentUser.name, teamName: ownTeamName.trim() });
      onCurrentUserUpdate({ ...currentUser, team_name: updated.team_name, role: updated.role });
      setToast("Company name set — you're now the admin for this team");
      load();
    } catch {
      setToast("Couldn't save your company name");
    } finally {
      setSavingTeamName(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto w-full max-w-2xl mx-auto px-8 py-10">
      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] mb-3">
        <Shield size={12} /> Admin
      </div>

      {!currentUser.team_name && (
        <form onSubmit={saveTeamName} className="mb-6 p-4 bg-[var(--panel)] border border-[var(--accent)]/40 rounded-lg">
          <p className="text-[var(--text-primary)] text-sm font-medium mb-1">Set your company/team name</p>
          <p className="text-[var(--text-muted)] text-xs mb-3">
            Your account isn't attached to a team yet, so you can only see yourself here and can't invite anyone. Set a name to start building your team.
          </p>
          <div className="flex gap-2">
            <input
              value={ownTeamName}
              onChange={(e) => setOwnTeamName(e.target.value)}
              placeholder="Company / team name"
              required
              className="flex-1 bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-60)]"
            />
            <button
              type="submit"
              disabled={savingTeamName}
              className="flex items-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-60 text-white text-sm font-medium px-4 py-2 rounded-md"
            >
              {savingTeamName && <Loader2 size={14} className="animate-spin" />} Save
            </button>
          </div>
        </form>
      )}

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-[var(--text-primary)] text-3xl font-medium leading-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            Team Management
          </h1>
          {currentUser.team_name && (
            <p className="text-[var(--text-muted)] text-xs mt-1 flex items-center gap-1.5">
              <Shield size={12} className="text-[var(--accent)]" /> Data Residency: <span className="text-[var(--text-primary)] font-medium">{currentUser.data_residency_region || "EU (europe-west1) - GDPR Compliant"}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowAddTeam((v) => !v); setShowInvite(false); }}
            disabled={!currentUser.team_name}
            title={!currentUser.team_name ? "Set a company name first" : ""}
            className="flex items-center gap-1.5 bg-[var(--panel-raised)] border border-[var(--border)] hover:bg-[var(--panel-hover)] text-[var(--text-primary)] text-sm font-medium px-3 py-1.5 rounded-md transition-colors disabled:opacity-40"
          >
            <Building2 size={15} className="text-[var(--accent)]" /> Add team
          </button>
          <button
            onClick={() => { setShowInvite((v) => !v); setShowAddTeam(false); }}
            disabled={!currentUser.team_name}
            title={!currentUser.team_name ? "Set a company name first" : ""}
            className="flex items-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white text-sm font-medium px-3 py-1.5 rounded-md transition-colors"
          >
            <UserPlus size={15} /> Add user
          </button>
        </div>
      </div>

      {showAddTeam && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newSubTeam.trim()) return;
            try {
              await auth.updateProfile({ subTeam: newSubTeam.trim() });
              onCurrentUserUpdate({ ...currentUser, sub_team: newSubTeam.trim() });
              setToast(`Sub-team "${newSubTeam.trim()}" created`);
              setNewSubTeam("");
              setShowAddTeam(false);
              load(); // refresh member list
            } catch (err) {
              setToast(err.message || "Failed to create sub-team");
            }
          }}
          className="mb-6 p-4 bg-[var(--panel)] border border-[var(--border)] rounded-lg space-y-3 animate-in fade-in duration-150"
        >
          <p className="text-[var(--text-primary)] text-sm font-medium">Add New Sub-Team / Department</p>
          <p className="text-[var(--text-muted)] text-xs">
            Create a sub-team department (e.g., Security Ops, Cloud Engineering, Platform Infra) for organizing team members.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={newSubTeam}
              onChange={(e) => setNewSubTeam(e.target.value)}
              placeholder="e.g. Security & Compliance Ops"
              required
              className="flex-1 bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-60)]"
            />
            <button
              type="submit"
              className="flex items-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium px-4 py-2 rounded-md"
            >
              <Building2 size={14} /> Create team
            </button>
          </div>
        </form>
      )}

      {currentUser.team_name && (
        <div className="mb-6 p-4 bg-[var(--panel)] border border-[var(--border)] rounded-xl space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
            <Shield size={14} className="text-[var(--accent)]" /> Location & Data Compliance Management
          </div>
          <p className="text-[var(--text-muted)] text-xs leading-relaxed">
            Data location compliance enforces strict regional storage isolation (GDPR, SOC2, APPI) for team assets, database records, and GCS buckets.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
            <div>
              <label className="text-[11px] text-[var(--text-secondary)] block mb-1">Data Residency Region (Compliant Zone)</label>
              <select
                value={currentUser.data_residency_region || "EU (europe-west1) - GDPR Compliant"}
                onChange={async (e) => {
                  const val = e.target.value;
                  try {
                    await auth.updateProfile({ dataResidencyRegion: val });
                    onCurrentUserUpdate({ ...currentUser, data_residency_region: val });
                    setToast(`Data residency compliance set to ${val.split(" - ")[0]}`);
                  } catch {
                    setToast("Failed to update data location");
                  }
                }}
                className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
              >
                <option value="EU (europe-west1) - GDPR Compliant">🇪🇺 EU (europe-west1) — GDPR Compliant</option>
                <option value="US (us-central1) - SOC2/HIPAA Compliant">🇺🇸 US (us-central1) — SOC2 / HIPAA Compliant</option>
                <option value="Asia (asia-east1) - APPI Compliant">🇯🇵 Asia (asia-east1) — APPI Compliant</option>
                <option value="UK (europe-west2) - UK GDPR Compliant">🇬🇧 UK (europe-west2) — UK GDPR Compliant</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-[var(--text-secondary)] block mb-1">Sub-Team Department</label>
              <select
                value={currentUser.sub_team || "Platform Infrastructure"}
                onChange={async (e) => {
                  const val = e.target.value;
                  try {
                    await auth.updateProfile({ subTeam: val });
                    onCurrentUserUpdate({ ...currentUser, sub_team: val });
                    setToast(`Sub-team updated to ${val}`);
                  } catch {
                    setToast("Failed to update sub-team");
                  }
                }}
                className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
              >
                <option value="Platform Infrastructure">Platform Infrastructure</option>
                <option value="Cloud & Site Reliability">Cloud & Site Reliability</option>
                <option value="Developer Experience">Developer Experience</option>
                <option value="Security & Compliance Ops">Security & Compliance Ops</option>
                <option value="Database Engineering">Database Engineering</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {showInvite && (
        <form onSubmit={sendInvite} className="mb-6 p-4 bg-[var(--panel)] border border-[var(--border)] rounded-lg">
          <p className="text-[var(--text-primary)] text-sm font-medium mb-1">Invite someone to the team</p>
          <p className="text-[var(--text-muted)] text-xs mb-3">
            Sends them a sign-in link by email. They'll land in the app already signed in as an individual user — promote their role below once they've joined.
          </p>
          <div className="flex gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="teammate@company.com"
              required
              className="flex-1 bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-60)]"
            />
            <button
              type="submit"
              disabled={inviting}
              className="flex items-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-60 text-white text-sm font-medium px-4 py-2 rounded-md"
            >
              {inviting && <Loader2 size={14} className="animate-spin" />} Send invite
            </button>
          </div>
          {inviteError && <p className="text-[var(--danger)] text-xs mt-2">{inviteError}</p>}
        </form>
      )}

      {currentUser.team_name && currentUser.role === "admin" && (
        <TeamStorageCard teamName={currentUser.team_name} />
      )}

      {error && <p className="text-[var(--danger)] text-sm mb-4">{error}</p>}
      {!users ? (
        <p className="text-[var(--text-muted)] text-sm">Loading…</p>
      ) : (
        <div className="space-y-2">
          {users.map((u) => {
            const Icon = ROLE_META[u.role].icon;
            const isSelf = u.id === currentUser.id;
            return (
              <div key={u.id} className="flex items-center gap-3 bg-[var(--panel)] border border-[var(--border)] rounded-lg p-3">
                <div className="w-8 h-8 rounded-full bg-[var(--border)] flex items-center justify-center text-[var(--text-primary)] text-xs font-medium flex-shrink-0">
                  {initialsOf(u.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[var(--text-primary)] text-sm font-medium truncate">{u.name}{isSelf && <span className="text-[var(--text-dim)] font-normal"> (you)</span>}</div>
                  <div className="text-[var(--text-muted)] text-xs truncate">{u.email}</div>
                  <div className={`text-xs truncate ${u.team_name ? "text-[var(--text-secondary)]" : "text-[var(--text-dim)] italic"}`}>
                    {u.team_name || "No company set"}
                  </div>
                </div>
                <select
                  value={u.role}
                  onChange={(e) => changeRole(u.id, e.target.value)}
                  className="bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-2 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
                >
                  {Object.entries(ROLE_META).map(([key, m]) => (
                    <option key={key} value={key}>{m.label}</option>
                  ))}
                </select>
                <Icon size={13} className="text-[var(--text-muted)] flex-shrink-0" />
                {!isSelf && (
                  <button
                    onClick={() => setConfirmDeleteId(u.id)}
                    className="text-[var(--text-muted)] hover:text-[var(--danger)] p-1 flex-shrink-0"
                    title="Delete user"
                  >
                    <UserX size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {confirmDeleteId && (
        <div className="fixed inset-0 bg-[var(--overlay)] flex items-center justify-center z-50 p-4" onClick={() => setConfirmDeleteId(null)}>
          <div className="bg-[var(--panel)] border border-[var(--border)] rounded-xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <p className="text-[var(--text-primary)] text-sm font-medium mb-1">Delete this user?</p>
            <p className="text-[var(--text-muted)] text-xs mb-4">
              Permanently deletes their account, all their pages and work log, and their cloud storage bucket. This can't be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDeleteId(null)} className="px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
              <button
                onClick={() => deleteUser(confirmDeleteId)}
                disabled={deletingId === confirmDeleteId}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[var(--danger)] hover:bg-[var(--danger-hover)] disabled:opacity-60 text-white rounded-md"
              >
                {deletingId === confirmDeleteId && <Loader2 size={13} className="animate-spin" />} Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Color palette for collaborator avatars
const COLLABORATOR_COLORS = [
  "#3B82F6", // blue
  "#10B981", // emerald
  "#8B5CF6", // purple
  "#F59E0B", // amber
  "#EC4899", // pink
  "#06B6D4", // cyan
  "#E11D48", // rose
  "#14B8A6", // teal
];

function getAvatarColor(idOrEmail) {
  let hash = 0;
  const str = String(idOrEmail || "");
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLLABORATOR_COLORS[Math.abs(hash) % COLLABORATOR_COLORS.length];
}

function getInitials(name, email) {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (email || "??").slice(0, 2).toUpperCase();
}

// Presence Component: renders avatars and active editor badge
function ActiveCollaborators({ activeUsers = [], currentUserId, isEditing = false }) {
  // Show other users on this page (and tag current user)
  if (!activeUsers || activeUsers.length === 0) return null;

  const others = activeUsers.filter((u) => u.id !== currentUserId);
  const activeEditor = others.find((u) => u.status === "editing");

  return (
    <div className="flex items-center gap-2">
      {/* Warning banner if someone else is actively editing */}
      {activeEditor && !isEditing && (
        <span className="flex items-center gap-1.5 text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-full animate-pulse">
          <Edit3 size={11} />
          <span className="font-medium">{activeEditor.name}</span> is editing
        </span>
      )}

      {/* Stacked Avatars */}
      <div className="flex items-center -space-x-1.5 overflow-hidden py-1">
        {activeUsers.map((user) => {
          const isMe = user.id === currentUserId;
          const userColor = getAvatarColor(user.email || user.name);
          const initials = getInitials(user.name, user.email);
          const isUserEditing = user.status === "editing";

          return (
            <div
              key={user.id}
              title={`${user.name} (${user.email})${isMe ? " - You" : ""}${isUserEditing ? " (Editing...)" : " (Viewing)"}`}
              className="relative group cursor-pointer"
            >
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shadow-sm ring-2 ${isUserEditing ? "ring-amber-400 animate-pulse" : "ring-[var(--panel)]"
                  }`}
                style={{ backgroundColor: userColor }}
              >
                {initials}
              </div>
              {/* Tooltip */}
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:flex flex-col items-center z-50 pointer-events-none">
                <span className="bg-neutral-900 text-white text-[10px] rounded px-2 py-0.5 whitespace-nowrap shadow-lg">
                  {user.name} {isMe ? "(You)" : ""} {isUserEditing ? "✏️ editing" : "👁️ viewing"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PageView({ page, isTeamPage, folderPathStr, canEdit, canDelete, onEdit, onNewSubpage, onDelete, onStatus, onRemoveAttachment, onCopyLink, pageHref, currentUser, setToast, onOpenBackups, activeUsers }) {
  const Meta = STATUS_META[page.status];
  const historyCount = page.history?.length || 0;

  return (
    <div className="w-full h-full flex flex-col px-8 py-6 overflow-hidden">
      <div className="flex-shrink-0">
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] mb-3">
          {isTeamPage && (
            <span className="flex items-center gap-1 bg-[var(--accent-15)] text-[var(--accent)] px-1.5 py-0.5 rounded">
              <Users size={10} /> Team
            </span>
          )}
          <Folder size={12} /> {folderPathStr}
        </div>
        <div className="flex items-start justify-between gap-4 mb-3">
          <h1 className="text-[var(--text-primary)] text-3xl font-medium leading-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            {page.title}
          </h1>
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
            {/* Active Collaborators Avatars */}
            <ActiveCollaborators activeUsers={activeUsers} currentUserId={currentUser?.id} isEditing={false} />
            <a
              href={pageHref}
              target="_blank"
              rel="noopener noreferrer"
              title="Open this page in a new tab"
              className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--accent-50)] px-2.5 py-1.5 rounded-md no-underline"
            >
              <ExternalLink size={12} /> New tab
            </a>
            <button onClick={onCopyLink} title="Copy link to this page" className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--accent-50)] px-2.5 py-1.5 rounded-md">
              <LinkIcon size={12} /> Copy link
            </button>
            <button
              onClick={onOpenBackups}
              title="View version history and backups"
              className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--accent-50)] px-2.5 py-1.5 rounded-md"
            >
              <Clock size={12} /> Backups ({historyCount})
            </button>
            {canEdit && (
              <button onClick={onNewSubpage} title="Create a subpage under this page" className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--accent-50)] px-2.5 py-1.5 rounded-md">
                <FilePlus size={12} /> Subpage
              </button>
            )}
            {canEdit && (
              <button onClick={onEdit} className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--accent-50)] px-2.5 py-1.5 rounded-md">
                <Edit3 size={12} /> Edit
              </button>
            )}
            {canDelete && (
              <button onClick={onDelete} className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--danger)] border border-[var(--border)] hover:border-[var(--danger-50)] px-2.5 py-1.5 rounded-md">
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <span className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-full" style={{ backgroundColor: `${Meta.color}1A`, color: Meta.color }}>
            <Meta.Icon size={12} /> {Meta.label}
          </span>
          {page.tags.map((t) => (
            <span key={t} className="text-xs text-[var(--text-muted)] bg-[var(--panel-raised)] border border-[var(--border)] px-2 py-1 rounded-full font-mono">#{t}</span>
          ))}
          <span className="text-xs text-[var(--text-dim)] ml-auto font-mono">
            updated {fmtDate(page.updatedAt)} by {page.updatedBy}
          </span>
        </div>

        {canEdit && (
          <div className="flex items-center gap-1.5 mb-4 pb-4 border-b border-[var(--border)]">
            <span className="text-xs text-[var(--text-dim)] mr-1">Mark as:</span>
            {Object.entries(STATUS_META).map(([key, m]) => (
              <button
                key={key}
                onClick={() => onStatus(key)}
                className={`flex items-center gap-1 text-xs px-2 py-1 rounded-md border transition-colors ${page.status === key ? "border-transparent" : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  }`}
                style={page.status === key ? { backgroundColor: `${m.color}1A`, color: m.color } : {}}
              >
                <m.Icon size={11} /> {m.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <ReadOnlyContent key={`${page.id}-${page.updatedAt}`} content={page.content} />
        <CommentsSection pageId={page.id} currentUser={currentUser} setToast={setToast} />
      </div>
    </div>
  );
}

async function getPageComments(pageId) {
  try {
    const raw = await window.storage.get(`runbook_comments_${pageId}`, false);
    return raw ? JSON.parse(raw.value) : [];
  } catch {
    return [];
  }
}

async function savePageComments(pageId, comments) {
  try {
    await window.storage.set(`runbook_comments_${pageId}`, JSON.stringify(comments), false);
    return true;
  } catch {
    return false;
  }
}

function CommentsSection({ pageId, currentUser, setToast }) {
  const [comments, setComments] = useState([]);
  const [newComment, setNewComment] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionFilter, setMentionMenuFilter] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const list = await getPageComments(pageId);
      if (active) {
        setComments(list);
        setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [pageId]);

  const handleCommentChange = (e) => {
    const val = e.target.value;
    setNewComment(val);
    const lastAtIdx = val.lastIndexOf("@");
    if (lastAtIdx !== -1 && lastAtIdx >= val.length - 15 && !val.slice(lastAtIdx).includes(" ")) {
      setMentionMenuFilter(val.slice(lastAtIdx + 1).toLowerCase());
      setShowMentionMenu(true);
    } else {
      setShowMentionMenu(false);
    }
  };

  const handleInsertMention = (member) => {
    const lastAtIdx = newComment.lastIndexOf("@");
    const prefix = lastAtIdx !== -1 ? newComment.slice(0, lastAtIdx) : newComment;
    setNewComment(`${prefix}@${member.name} `);
    setShowMentionMenu(false);
  };

  const filteredMembers = TEAM_MEMBERS_DUMMY.filter((m) =>
    m.name.toLowerCase().includes(mentionFilter) || m.role.toLowerCase().includes(mentionFilter)
  );

  const handleAddComment = async (e) => {
    e.preventDefault();
    const text = newComment.trim();
    if (!text) return;
    setSubmitting(true);
    const commentObj = {
      id: uid(),
      text,
      createdAt: new Date().toISOString(),
      userName: currentUser?.name || "User",
      userEmail: currentUser?.email || "",
    };
    const next = [...comments, commentObj];
    const ok = await savePageComments(pageId, next);
    if (ok) {
      setComments(next);
      setNewComment("");
      setToast("Comment posted");
    } else {
      setToast("Failed to post comment");
    }
    setSubmitting(false);
  };

  const handleDeleteComment = async (commentId) => {
    const next = comments.filter((c) => c.id !== commentId);
    const ok = await savePageComments(pageId, next);
    if (ok) {
      setComments(next);
      setToast("Comment deleted");
    }
  };

  return (
    <div className="mt-8 pt-6 border-t border-[var(--border)]">
      <div className="flex items-center gap-2 mb-4">
        <MessageSquare size={16} className="text-[var(--accent)]" />
        <h3 className="text-[var(--text-primary)] text-sm font-semibold m-0">Comments ({comments.length})</h3>
      </div>

      {currentUser && (
        <form onSubmit={handleAddComment} className="mb-6 relative">
          <textarea
            value={newComment}
            onChange={handleCommentChange}
            placeholder="Write a comment or leave feedback on this runbook... Type @ to mention a team member."
            rows={3}
            className="w-full bg-[var(--panel-raised)] border border-[var(--border)] rounded-lg p-3 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-60)] resize-none"
          />

          {showMentionMenu && filteredMembers.length > 0 && (
            <div className="absolute left-3 bottom-12 w-64 bg-[var(--panel)] border border-[var(--border)] rounded-xl shadow-2xl z-30 py-1 overflow-hidden">
              <div className="px-3 py-1.5 border-b border-[var(--border)] flex items-center gap-1.5 text-[10px] text-[var(--accent)] font-semibold uppercase tracking-wider">
                <AtSign size={12} /> Mention Team Member
              </div>
              {filteredMembers.map((member) => (
                <button
                  key={member.email}
                  type="button"
                  onClick={() => handleInsertMention(member)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--panel-raised)] transition-colors flex items-center justify-between"
                >
                  <div>
                    <div className="text-[var(--text-primary)] font-medium">{member.name}</div>
                    <div className="text-[var(--text-dim)] text-[10px]">{member.role}</div>
                  </div>
                  <span className="text-[10px] text-[var(--accent)] font-mono">@{member.name.split(" ")[0].toLowerCase()}</span>
                </button>
              ))}
            </div>
          )}

          <div className="mt-2 flex items-center justify-between">
            <span className="text-[10px] text-[var(--text-dim)] flex items-center gap-1">
              <AtSign size={10} /> Type @ to mention team members
            </span>
            <button
              type="submit"
              disabled={submitting || !newComment.trim()}
              className="flex items-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-md transition-colors"
            >
              {submitting && <Loader2 size={12} className="animate-spin" />}
              Post comment
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-[var(--text-muted)] text-xs">Loading comments...</p>
      ) : comments.length === 0 ? (
        <p className="text-[var(--text-dim)] text-xs italic">No comments yet. Be the first to start a conversation!</p>
      ) : (
        <div className="space-y-3">
          {comments.map((c) => (
            <div key={c.id} className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-3 text-xs">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-[var(--accent-15)] text-[var(--accent)] text-[10px] font-bold flex items-center justify-center">
                    {initialsOf(c.userName)}
                  </div>
                  <span className="text-[var(--text-primary)] font-medium">{c.userName}</span>
                  <span className="text-[var(--text-dim)] font-mono text-[10px]">{fmtDateTime(c.createdAt)}</span>
                </div>
                {currentUser && (currentUser.email === c.userEmail || currentUser.role === "admin") && (
                  <button
                    type="button"
                    onClick={() => handleDeleteComment(c.id)}
                    className="text-[var(--text-dim)] hover:text-[var(--danger)] p-1 rounded"
                    title="Delete comment"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              <p className="text-[var(--text-secondary)] whitespace-pre-wrap m-0 leading-relaxed">{c.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VersionHistoryModal({ page, onClose, onRestore }) {
  const history = page.history || [];
  const [selectedVersion, setSelectedVersion] = useState(history[0] || null);

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-[var(--panel)] border border-[var(--border)] rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-[var(--accent)]" />
            <h2 className="text-[var(--text-primary)] text-sm font-semibold m-0">Version History / Backups</h2>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded">
            <X size={16} />
          </button>
        </div>

        {history.length === 0 ? (
          <div className="p-8 text-center text-[var(--text-muted)] text-xs">
            No previous backup versions stored yet for this page. Previous versions are saved automatically whenever changes are saved.
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex overflow-hidden">
            <div className="w-64 border-r border-[var(--border)] overflow-y-auto p-2 space-y-1 bg-[var(--panel-raised)] flex-shrink-0">
              {history.map((ver, idx) => (
                <button
                  key={ver.id || idx}
                  onClick={() => setSelectedVersion(ver)}
                  className={`w-full text-left p-2.5 rounded-lg text-xs transition-colors ${selectedVersion === ver
                    ? "bg-[var(--accent-15)] text-[var(--accent)] border border-[var(--accent-30)] font-medium"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--panel)] border border-transparent"
                    }`}
                >
                  <div className="font-semibold text-[var(--text-primary)] truncate">{ver.title || page.title}</div>
                  <div className="text-[10px] text-[var(--text-dim)] font-mono mt-0.5">{fmtDateTime(ver.updatedAt)}</div>
                  <div className="text-[10px] text-[var(--text-muted)] mt-0.5">by {ver.updatedBy}</div>
                </button>
              ))}
            </div>

            <div className="flex-1 flex flex-col min-h-0 bg-[var(--panel)]">
              {selectedVersion ? (
                <>
                  <div className="p-4 border-b border-[var(--border)] flex items-center justify-between gap-3">
                    <div>
                      <span className="text-xs text-[var(--text-primary)] font-semibold">{selectedVersion.title}</span>
                      <span className="text-[10px] text-[var(--text-dim)] ml-2 font-mono">{fmtDateTime(selectedVersion.updatedAt)}</span>
                    </div>
                    <button
                      onClick={() => onRestore(selectedVersion)}
                      className="flex items-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs px-3 py-1.5 rounded-md shadow-sm transition-colors"
                    >
                      <RotateCcw size={12} /> Restore this version
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-5 rb-content">
                    <ReadOnlyContent key={selectedVersion.id || selectedVersion.updatedAt} content={selectedVersion.content} />
                  </div>
                </>
              ) : (
                <div className="p-6 text-xs text-[var(--text-muted)]">Select a version from the left list to preview.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReadOnlyContent({ content }) {
  const extensions = useMemo(() => buildExtensions(), []);
  const editor = useEditor({
    extensions,
    content: migrateLegacyUnderline(content),
    editable: false,
  });
  if (!editor) return null;
  return (
    <div className="rb-content">
      <EditorContent editor={editor} />
    </div>
  );
}

function migrateLegacyUnderline(raw) {
  return (raw || "").replace(/\+\+(.+?)\+\+/g, "<u>$1</u>");
}

function attachmentMarkdownItPlugin(md) {
  md.inline.ruler.before("link", "attachment", (state, silent) => {
    const rest = state.src.slice(state.pos);
    const m = /^\[\[file:([^|]+)\|([^|]+)\|([^\]]+)\]\]/.exec(rest);
    if (!m) return false;
    if (!silent) {
      const token = state.push("attachment", "", 0);
      token.attrs = [["data-id", m[1]], ["data-name", m[2]], ["data-size", m[3]]];
    }
    state.pos += m[0].length;
    return true;
  });
  md.renderer.rules.attachment = (tokens, idx) => {
    const t = tokens[idx];
    const attrs = t.attrs.map(([k, v]) => `${k}="${String(v).replace(/"/g, "&quot;")}"`).join(" ");
    return `<span data-attachment ${attrs}></span>`;
  };
}

const AttachmentNode = Node.create({
  name: "attachment",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      id: { default: null },
      name: { default: null },
      size: { default: null },
    };
  },
  parseHTML() {
    return [{
      tag: "span[data-attachment]",
      getAttrs: (el) => ({
        id: el.getAttribute("data-id"),
        name: el.getAttribute("data-name"),
        size: el.getAttribute("data-size"),
      }),
    }];
  },
  renderHTML({ node }) {
    return ["span", { "data-attachment": "", "data-id": node.attrs.id, "data-name": node.attrs.name, "data-size": node.attrs.size }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AttachmentNodeView);
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(`[[file:${node.attrs.id}|${node.attrs.name}|${node.attrs.size}]]`);
        },
        parse: { setup(md) { md.use(attachmentMarkdownItPlugin); } },
      },
    };
  },
});

function AttachmentNodeView({ node, deleteNode, editor }) {
  const { id, name, size } = node.attrs;
  const isImage = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name || "");
  const isVideo = /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(name || "");
  const removeHandler = editor.isEditable
    ? async () => {
      try { await filesApi.remove(id); } catch { }
      deleteNode();
    }
    : null;
  const Component = isImage ? ImageAttachment : isVideo ? VideoAttachment : FileAttachment;
  return (
    <NodeViewWrapper as="span" className="inline-block align-middle my-1">
      <Component id={id} name={name} size={size} onRemove={removeHandler} />
    </NodeViewWrapper>
  );
}

const ListTabPriority = Extension.create({
  name: "listTabPriority",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (this.editor.isActive("listItem")) {
          this.editor.commands.sinkListItem("listItem");
          return true;
        }
        return false;
      },
      "Shift-Tab": () => {
        if (this.editor.isActive("listItem")) {
          this.editor.commands.liftListItem("listItem");
          return true;
        }
        return false;
      },
    };
  },
});

const AutoDate = Extension.create({
  name: "autoDate",
  addOptions() {
    return {
      onTriggerDatePicker: null,
    };
  },
  addInputRules() {
    const handleTrigger = ({ state, range }) => {
      const matchedText = state.doc.textBetween(range.from, range.to, "\n", "\0");
      const leadingSpace = matchedText.startsWith(" ") ? " " : "";
      if (leadingSpace) {
        state.tr.insertText(" ", range.from, range.from + 1);
        state.tr.delete(range.from + 1, range.to);
      } else {
        state.tr.delete(range.from, range.to);
      }
      if (this.options.onTriggerDatePicker) {
        setTimeout(() => {
          this.options.onTriggerDatePicker();
        }, 0);
      }
    };

    return [
      new InputRule({
        find: /(?:^|\s)\/date\s$/,
        handler: handleTrigger,
      }),
      new InputRule({
        find: /(?:^|\s)\/date$/,
        handler: handleTrigger,
      }),
      new InputRule({
        find: /(?:^|\s)\/calendar\s$/,
        handler: handleTrigger,
      }),
      new InputRule({
        find: /(?:^|\s)\/calendar$/,
        handler: handleTrigger,
      }),
    ];
  },
});

const ParagraphKeepEmpty = Paragraph.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const isEffectivelyEmpty =
            node.childCount === 0 ||
            (node.content.content ?? []).every((child) => child.type.name === "hardBreak");
          if (isEffectivelyEmpty) {
            state.write("<br />");
            state.closeBlock(node);
          } else {
            state.renderInline(node);
            state.closeBlock(node);
          }
        },
        parse: {},
      },
    };
  },
});

function CodeBlockNodeView({ node, updateAttributes, editor }) {
  const [isCollapsed, setIsCollapsed] = useState(Boolean(node?.attrs?.collapsed));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setIsCollapsed(Boolean(node?.attrs?.collapsed));
  }, [node?.attrs?.collapsed]);

  const copyCode = (e) => {
    e?.preventDefault();
    e?.stopPropagation();
    const text = node?.textContent || "";
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const toggleCollapse = (e) => {
    e?.preventDefault();
    e?.stopPropagation();
    const next = !isCollapsed;
    setIsCollapsed(next);
    if (editor && editor.isEditable && typeof updateAttributes === "function") {
      try {
        updateAttributes({ collapsed: next });
      } catch { }
    }
  };

  const lineCount = (node?.textContent || "").split("\n").length;
  const language = node?.attrs?.language || "code";

  if (!node) return null;

  return (
    <NodeViewWrapper className="code-block-wrapper my-3 relative group rounded-lg border border-[var(--border)] bg-[var(--code-bg)] overflow-hidden max-w-full">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--panel-raised)] border-b border-[var(--border)] text-xs text-[var(--text-muted)] font-mono select-none">
        <span className="flex items-center gap-1.5 text-[var(--accent)] font-semibold">
          <Code size={12} /> {language}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={copyCode}
            className="flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors px-2 py-0.5 rounded border border-transparent hover:border-[var(--border)]"
            title="Copy code"
          >
            {copied ? <CheckCircle2 size={12} className="text-[var(--accent)]" /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={toggleCollapse}
            className="flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--panel)] px-2 py-0.5 rounded border border-[var(--border)] transition-colors"
            title={isCollapsed ? "Expand code block" : "Collapse code block"}
          >
            {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            {isCollapsed ? "Expand" : "Collapse"}
          </button>
        </div>
      </div>
      <div className={`transition-all duration-200 ${isCollapsed ? "max-h-20 overflow-hidden relative" : "relative"}`}>
        <pre className="p-3 text-xs font-mono text-[var(--code-text)] overflow-x-auto m-0 leading-relaxed whitespace-pre-wrap break-all">
          <NodeViewContent as="code" />
        </pre>
        {isCollapsed && (
          <div
            onClick={toggleCollapse}
            className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[var(--code-bg)] via-[var(--code-bg)]/90 to-transparent flex items-end justify-center pb-1.5 cursor-pointer z-10"
          >
            <span className="text-[11px] text-[var(--accent)] bg-[var(--panel)] px-3 py-0.5 rounded-full border border-[var(--border)] shadow-md font-medium hover:bg-[var(--panel-raised)] transition-colors flex items-center gap-1">
              <ChevronRight size={12} /> Click to expand code ({lineCount} lines)
            </span>
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

const CustomCodeBlock = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      language: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-language") || el.firstElementChild?.getAttribute("class")?.replace("language-", ""),
        renderHTML: (attrs) => (attrs.language ? { "data-language": attrs.language, class: `language-${attrs.language}` } : {}),
      },
      collapsed: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-collapsed") === "true",
        renderHTML: (attrs) => (attrs.collapsed ? { "data-collapsed": "true" } : {}),
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView);
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write("```" + (node.attrs.language || "") + "\n");
          const text = node.textContent || "";
          state.write(text);
          if (!text.endsWith("\n")) {
            state.write("\n");
          }
          state.write("```");
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

function buildExtensions(options = {}) {
  return [
    StarterKit.configure({
      paragraph: false,
      codeBlock: false,
      link: { openOnClick: false, HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" } },
    }),
    ParagraphKeepEmpty,
    ListTabPriority,
    AutoDate.configure({
      onTriggerDatePicker: options.onTriggerDatePicker,
    }),
    Table.configure({ resizable: true }),
    TableRow, TableCell, TableHeader,
    CustomCodeBlock,
    AttachmentNode,
    Markdown.configure({ html: true, tightLists: true, linkify: true }),
  ];
}

function ImageAttachment({ id, name, size, onRemove }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [imgWidth, setImgWidth] = useState("100%");
  const [displayAsLink, setDisplayAsLink] = useState(false);

  useEffect(() => {
    let objectUrl;
    let cancelled = false;
    filesApi.getObjectUrl(id)
      .then((u) => { if (!cancelled) { objectUrl = u; setUrl(u); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e) => { if (e.key === "Escape") { setExpanded(false); setConfirmingDelete(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const handleDownload = async () => {
    setDownloading(true);
    try { await filesApi.download(id, name); } catch { } finally { setDownloading(false); }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleted(true);
    await onRemove();
    setDeleting(false);
  };

  if (deleted) return null;

  if (displayAsLink || failed) {
    return (
      <div className="inline-flex items-center gap-1.5 my-1">
        <FileAttachment id={id} name={name} size={size} onRemove={onRemove} />
        {!failed && (
          <button
            type="button"
            onClick={() => setDisplayAsLink(false)}
            className="text-xs text-[var(--accent)] hover:underline px-1.5 py-1 rounded bg-[var(--panel-raised)] border border-[var(--border)]"
            title="Switch back to image preview"
          >
            Show image
          </button>
        )}
      </div>
    );
  }

  if (!url) {
    return (
      <div className="w-full max-w-md h-40 rounded-lg bg-[var(--panel)] border border-[var(--border)] flex items-center justify-center">
        <Loader2 size={16} className="animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  return (
    <>
      <div className="group relative my-2 inline-block max-w-full">
        <div className="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity bg-[var(--overlay)] backdrop-blur-md border border-[var(--border)] rounded-md px-1.5 py-1 flex items-center gap-1 text-xs">
          <span className="text-[10px] text-[var(--text-dim)] uppercase font-mono mr-0.5">Width:</span>
          {["25%", "50%", "75%", "100%"].map((w) => (
            <button
              key={w}
              type="button"
              onClick={(e) => { e.stopPropagation(); setImgWidth(w); }}
              className={`px-1.5 py-0.5 text-[10px] rounded font-mono transition-colors ${imgWidth === w ? "bg-[var(--accent)] text-white font-bold" : "text-[var(--text-secondary)] hover:bg-[var(--panel)]"
                }`}
            >
              {w}
            </button>
          ))}
          <div className="w-px h-3 bg-[var(--border)] mx-1" />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDisplayAsLink(true); }}
            className="text-[10px] text-[var(--accent)] hover:underline flex items-center gap-0.5"
            title="Display as clean text file link"
          >
            <LinkIcon size={10} /> Text Link
          </button>
        </div>

        <img
          src={url}
          alt={name}
          onClick={() => setExpanded(true)}
          style={{ width: imgWidth, maxWidth: "100%" }}
          className="rounded-lg border border-[var(--border)] h-auto cursor-zoom-in hover:border-[var(--accent-50)] transition-all"
          title="Click to expand"
        />
        {onRemove && (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }}
            className="absolute top-2 right-2 z-10 bg-[var(--overlay)] hover:bg-[var(--danger)] text-[var(--text-primary)] p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
            title="Delete attachment"
          >
            <Trash2 size={13} />
          </button>
        )}
        <p className="text-[var(--text-dim)] text-xs mt-1.5 font-mono">{name} · {size}</p>
      </div>

      {expanded && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-6"
          onClick={() => { setExpanded(false); setConfirmingDelete(false); }}
        >
          <div className="absolute top-4 right-4 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="flex items-center gap-1.5 bg-[var(--panel-raised)] hover:bg-[var(--border)] border border-[var(--border)] text-[var(--text-primary)] text-xs px-3 py-2 rounded-md disabled:opacity-60"
            >
              {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              Download
            </button>
            {onRemove && (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="flex items-center gap-1.5 bg-[var(--panel-raised)] hover:bg-[var(--danger)] border border-[var(--border)] text-[var(--text-primary)] text-xs px-3 py-2 rounded-md"
              >
                <Trash2 size={13} /> Delete
              </button>
            )}
            <button
              onClick={() => { setExpanded(false); setConfirmingDelete(false); }}
              className="bg-[var(--panel-raised)] hover:bg-[var(--border)] border border-[var(--border)] text-[var(--text-primary)] p-2 rounded-md"
              title="Close"
            >
              <X size={15} />
            </button>
          </div>
          <img
            src={url}
            alt={name}
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full rounded-lg object-contain"
          />
          <p
            className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[var(--text-secondary)] text-xs font-mono bg-[var(--overlay)] px-3 py-1.5 rounded-full"
            onClick={(e) => e.stopPropagation()}
          >
            {name} · {size}
          </p>

          {confirmingDelete && (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
              <div className="bg-[var(--panel)] border border-[var(--border)] rounded-xl p-5 max-w-sm w-full mx-4">
                <p className="text-[var(--text-primary)] text-sm font-medium mb-1">Delete this attachment?</p>
                <p className="text-[var(--text-muted)] text-xs mb-4">This removes it from the page and permanently deletes it from cloud storage. Can't be undone.</p>
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setConfirmingDelete(false)} className="px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[var(--danger)] hover:bg-[var(--danger-hover)] disabled:opacity-60 text-white rounded-md"
                  >
                    {deleting && <Loader2 size={13} className="animate-spin" />} Delete
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function VideoAttachment({ id, name, size, onRemove }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl;
    let cancelled = false;
    filesApi.getObjectUrl(id)
      .then((u) => { if (!cancelled) { objectUrl = u; setUrl(u); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  if (failed) {
    return <FileAttachment id={id} name={name} size={size} onRemove={onRemove} />;
  }

  if (!url) {
    return (
      <div className="w-full max-w-lg h-48 rounded-lg bg-[var(--panel)] border border-[var(--border)] flex items-center justify-center my-2">
        <Loader2 size={16} className="animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  return (
    <div className="my-3 max-w-full inline-block">
      <video
        src={url}
        controls
        preload="metadata"
        className="max-w-full max-h-[480px] rounded-lg border border-[var(--border)] bg-black shadow-md"
      />
      <div className="mt-1 flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <span className="truncate max-w-xs">{name}</span>
        <span>·</span>
        <span>{size}</span>
      </div>
    </div>
  );
}

function FileAttachment({ id, name, size, onRemove }) {
  const [downloading, setDownloading] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const isSheet = /\.(xlsx|xls|csv)$/i.test(name || "");
  const Icon = isSheet ? FileSpreadsheet : Paperclip;

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await filesApi.download(id, name);
    } catch {
    } finally {
      setDownloading(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleted(true);
    await onRemove();
    setDeleting(false);
  };

  if (deleted) return null;

  return (
    <div className="group relative inline-flex">
      <button
        onClick={handleDownload}
        disabled={downloading}
        className="flex items-center gap-2.5 bg-[var(--panel)] border border-[var(--border)] hover:border-[var(--accent-50)] rounded-lg pl-3.5 pr-3 py-2.5 text-left transition-colors disabled:opacity-60"
      >
        <div className="w-8 h-8 rounded-md bg-[var(--panel-raised)] flex items-center justify-center flex-shrink-0">
          {downloading ? <Loader2 size={14} className="animate-spin text-[var(--accent)]" /> : <Icon size={14} className="text-[var(--accent)]" />}
        </div>
        <div className="min-w-0">
          <div className="text-[var(--text-primary)] text-sm truncate">{name}</div>
          <div className="text-[var(--text-muted)] text-xs">{size} · click to download</div>
        </div>
        <Download size={13} className="text-[var(--text-dim)] flex-shrink-0 ml-2" />
      </button>
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }}
          className="ml-1 flex items-center justify-center text-[var(--text-dim)] hover:text-[var(--danger)] opacity-0 group-hover:opacity-100 transition-opacity px-1"
          title="Delete attachment"
        >
          <Trash2 size={13} />
        </button>
      )}

      {confirmingDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setConfirmingDelete(false)}>
          <div className="bg-[var(--panel)] border border-[var(--border)] rounded-xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <p className="text-[var(--text-primary)] text-sm font-medium mb-1">Delete this attachment?</p>
            <p className="text-[var(--text-muted)] text-xs mb-4">This removes it from the page and permanently deletes it from cloud storage. Can't be undone.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmingDelete(false)} className="px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[var(--danger)] hover:bg-[var(--danger-hover)] disabled:opacity-60 text-white rounded-md"
              >
                {deleting && <Loader2 size={13} className="animate-spin" />} Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EditorToolbarBtn({ icon: Icon, title, onClick, active }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`p-1.5 rounded transition-colors ${active
        ? "bg-[var(--accent-15)] text-[var(--accent)]"
        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--border)]"
        }`}
    >
      <Icon size={14} />
    </button>
  );
}

function adjustColumnWidth(editor, delta) {
  if (!editor || !editor.isActive("table")) return;
  const { state, view } = editor;
  const { selection, tr } = state;

  let cellNode = null;
  let tableNode = null;
  let tablePos = null;

  for (let d = selection.$from.depth; d > 0; d--) {
    const node = selection.$from.node(d);
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
      cellNode = node;
    }
    if (node.type.name === "table") {
      tablePos = selection.$from.before(d);
      tableNode = node;
      break;
    }
  }

  if (!tableNode || !cellNode) return;

  let targetColIndex = -1;
  tableNode.forEach((rowNode) => {
    let colIdx = 0;
    rowNode.forEach((cNode) => {
      if (cNode === cellNode) {
        targetColIndex = colIdx;
      }
      colIdx += (cNode.attrs.colspan || 1);
    });
  });

  if (targetColIndex === -1) return;

  let currentPos = tablePos + 1;
  let modified = false;

  tableNode.forEach((rowNode) => {
    let colIdx = 0;
    rowNode.forEach((cNode) => {
      const cPos = currentPos;
      const colSpan = cNode.attrs.colspan || 1;
      if (colIdx === targetColIndex) {
        let currentWidth = cNode.attrs.colwidth ? cNode.attrs.colwidth[0] : 100;
        if (!cNode.attrs.colwidth) {
          const domEl = view.nodeDOM(cPos);
          if (domEl && domEl.offsetWidth) {
            currentWidth = domEl.offsetWidth;
          }
        }
        const newWidth = Math.max(40, currentWidth + delta);
        tr.setNodeMarkup(cPos, null, {
          ...cNode.attrs,
          colwidth: [newWidth],
        });
        modified = true;
      }
      colIdx += colSpan;
      currentPos += cNode.nodeSize;
    });
    currentPos += 1;
  });

  if (modified) {
    view.dispatch(tr);
  }
}

// Automatically compress screenshots and uploaded images to preserve storage and bandwidth
async function compressImageFile(file, options = {}) {
  if (!file || !file.type || !file.type.startsWith("image/")) return file;
  if (file.type === "image/svg+xml" || file.type === "image/gif") return file;

  const {
    maxWidth = 1920,
    maxHeight = 1920,
    quality = 0.82,
    outputType = "image/webp",
  } = options;

  try {
    let img;
    if (typeof createImageBitmap === "function") {
      img = await createImageBitmap(file);
    } else {
      img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = URL.createObjectURL(file);
      });
    }

    let { width, height } = img;
    if (width > maxWidth || height > maxHeight) {
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), outputType, quality);
    });

    if (!blob || blob.size >= file.size) {
      return file; // Keep original if compression didn't reduce size
    }

    const originalBase = file.name.replace(/\.[^/.]+$/, "");
    const ext = outputType === "image/webp" ? "webp" : "jpg";
    const compressedFileName = `${originalBase}.${ext}`;

    return new File([blob], compressedFileName, { type: outputType });
  } catch (err) {
    console.warn("Image compression skipped, using original:", err);
    return file;
  }
}

function EditView({
  editing,
  setEditing,
  folderTree,
  onCreateFolder,
  canChooseTeamSpace,
  onSave,
  onCancel,
  titleError,
  titleErrorMsg,
  setTitleError,
  activeUsers,
  currentUser,
  editingConflict,
  setEditingConflict,
}) {
  const set = (field) => (e) => setEditing({ ...editing, [field]: e.target.value });
  const setTitle = (e) => {
    setEditing({ ...editing, title: e.target.value });
    if (e.target.value.trim() && titleError) setTitleError(false);
  };
  const [addingFolder, setAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const fileInputRef = React.useRef(null);
  const uploadRef = React.useRef(null);

  const localToday = () => {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  };
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [selectedDate, setSelectedDate] = useState(localToday);

  const handleFolderSelect = (e) => {
    const val = e.target.value;
    if (val === "__new__") {
      setAddingFolder(true);
      setNewFolderName("");
    } else {
      setEditing({ ...editing, folderId: val === "__root__" ? null : val });
    }
  };

  const confirmNewFolder = async () => {
    if (!newFolderName.trim()) return;
    setCreatingFolder(true);
    const folder = await onCreateFolder(newFolderName, null);
    setCreatingFolder(false);
    if (folder) {
      setEditing({ ...editing, folderId: folder.id });
      setAddingFolder(false);
    }
  };

  const extensions = useMemo(
    () => buildExtensions({ onTriggerDatePicker: () => setShowDatePicker(true) }),
    []
  );

  const uploadAndInsertFile = useCallback(async (file) => {
    if (!file) return;
    setUploading(true);
    setUploadError("");
    try {
      const fileToUpload = await compressImageFile(file);
      const meta = await filesApi.upload(fileToUpload);
      const kb = Math.max(1, Math.round(meta.size / 1024));
      editor?.chain().focus().insertContent({
        type: "attachment",
        attrs: { id: meta.id, name: meta.name, size: `${kb}KB` }
      }).run();
    } catch (err) {
      setUploadError(err.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }, []);

  useEffect(() => {
    uploadRef.current = uploadAndInsertFile;
  }, [uploadAndInsertFile]);

  const editor = useEditor({
    extensions,
    content: migrateLegacyUnderline(editing.content),
    editable: true,
    onUpdate: ({ editor }) => {
      setEditing((prev) => ({ ...prev, content: editor.storage.markdown.getMarkdown() }));
    },
    editorProps: {
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items || [];
        const files = event.clipboardData?.files || [];
        let imageFile = null;

        for (const f of files) {
          if (f.type && f.type.startsWith("image/")) {
            imageFile = f;
            break;
          }
        }
        if (!imageFile) {
          for (const item of items) {
            if (item.type && item.type.startsWith("image/")) {
              imageFile = item.getAsFile();
              break;
            }
          }
        }

        if (imageFile) {
          event.preventDefault();
          const ext = imageFile.type.split("/")[1] || "png";
          const name = imageFile.name && imageFile.name !== "image.png" && imageFile.name !== "blob"
            ? imageFile.name
            : `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
          const fileToUpload = new File([imageFile], name, { type: imageFile.type || "image/png" });
          uploadRef.current?.(fileToUpload);
          return true;
        }
        return false;
      },
      handleDrop: (view, event, slice, moved) => {
        if (!moved && event.dataTransfer?.files?.length) {
          const file = event.dataTransfer.files[0];
          if (file && file.type.startsWith("image/")) {
            event.preventDefault();
            uploadRef.current?.(file);
            return true;
          }
        }
        return false;
      }
    }
  });

  const [showFormatMenu, setShowFormatMenu] = useState(false);
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const formatMenuRef = React.useRef(null);
  useEffect(() => {
    if (!showFormatMenu) return;
    const onClickOutside = (e) => {
      if (formatMenuRef.current && !formatMenuRef.current.contains(e.target)) setShowFormatMenu(false);
    };
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [showFormatMenu]);

  const draftKey = editing.id ? `runbook_draft_${editing.id}` : null;
  const [draftAvailable, setDraftAvailable] = useState(null);

  useEffect(() => {
    if (!draftKey) return;
    try {
      const saved = localStorage.getItem(draftKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.savedAt && parsed.content !== editing.content) {
          setDraftAvailable(parsed);
        }
      }
    } catch { }
  }, [draftKey]);

  useEffect(() => {
    if (!editing || !editing.id) return;
    const key = `runbook_draft_${editing.id}`;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify({
          title: editing.title,
          content: editing.content,
          status: editing.status,
          tags: editing.tags,
          folderId: editing.folderId,
          savedAt: new Date().toISOString(),
        }));
      } catch { }
    }, 500);
    return () => clearTimeout(timer);
  }, [editing]);

  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const linkInputRef = React.useRef(null);
  const openLinkInput = () => {
    if (!editor) return;
    setLinkUrl(editor.getAttributes("link").href || "");
    setShowLinkInput(true);
    requestAnimationFrame(() => linkInputRef.current?.focus());
  };
  const confirmLink = () => {
    if (!editor) return;
    const url = linkUrl.trim();
    if (url) {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    }
    setShowLinkInput(false);
  };

  const insertSelectedDate = () => {
    if (!selectedDate || !editor) return;
    const chosen = new Date(`${selectedDate}T00:00:00`);
    const formatted = new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "2-digit",
    }).format(chosen);
    editor.chain().focus().insertContent(formatted).run();
    setShowDatePicker(false);
  };

  const handleAttach = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length || !editor) return;
    for (const file of files) {
      await uploadAndInsertFile(file);
    }
  };

  if (!editor) return null;

  const inTable = editor.isActive("table");

  const formatOptions = [
    { label: "Normal text", icon: FileText, action: () => editor.chain().focus().setParagraph().run() },
    { label: "Heading 1", icon: Heading1, action: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: "Heading 2", icon: Heading2, action: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "Heading 3", icon: Heading3, action: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: "Quote", icon: Quote, action: () => editor.chain().focus().toggleBlockquote().run() },
  ];

  return (
    <div className="w-full h-full flex flex-col px-8 py-6 overflow-hidden">
      {/* Draft Buffer Banner */}
      {draftAvailable && (
        <div className="flex-shrink-0 mb-3 bg-[var(--accent-15)] border border-[var(--accent-30)] text-[var(--text-primary)] px-3.5 py-2 rounded-lg text-xs flex items-center justify-between gap-2 shadow-sm">
          <span className="flex items-center gap-1.5 font-medium">
            <RotateCcw size={13} className="text-[var(--accent)]" /> Unsaved draft buffer found from {fmtDateTime(draftAvailable.savedAt)}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing((prev) => ({ ...prev, ...draftAvailable }));
                setDraftAvailable(null);
              }}
              className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-2.5 py-1 rounded text-xs font-medium"
            >
              Restore draft
            </button>
            <button
              type="button"
              onClick={() => {
                try { if (draftKey) localStorage.removeItem(draftKey); } catch { }
                setDraftAvailable(null);
              }}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] px-1.5 py-1"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* Concurrent Edit Warning Banner */}
      {editingConflict && (
        <div className="flex-shrink-0 mb-3 bg-amber-500/15 border border-amber-500/30 text-[var(--text-primary)] px-3.5 py-2.5 rounded-lg text-xs flex items-center justify-between gap-3 shadow-sm">
          <span className="flex items-center gap-2 text-amber-500 font-medium">
            <AlertTriangle size={15} className="flex-shrink-0" />
            <span>
              <strong>{editingConflict.updatedBy}</strong> just published changes to this page. You can still save to overwrite with your edits, or cancel to view their update.
            </span>
          </span>
          <button
            type="button"
            onClick={() => setEditingConflict(null)}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] px-2 py-1 text-xs"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Top action header */}
      <div className="flex-shrink-0 flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--text-muted)] uppercase tracking-wider">{editing.id ? "Editing page" : "New page"}</span>
          <ActiveCollaborators activeUsers={activeUsers} currentUserId={currentUser?.id} isEditing={true} />
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onCancel} className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-3 py-1.5">
            <X size={13} /> Cancel
          </button>
          <button onClick={onSave} className="flex items-center gap-1 text-xs bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-3 py-1.5 rounded-md font-medium">
            <Save size={13} /> Save
          </button>
        </div>
      </div>

      {/* Title */}
      <div className="flex-shrink-0 mb-1">
        <input
          value={editing.title}
          onChange={setTitle}
          placeholder="Page title"
          className={`w-full bg-transparent text-[var(--text-primary)] text-3xl font-medium focus:outline-none placeholder-[var(--text-dim)] border-b pb-2 ${titleError ? "border-[var(--danger)]" : "border-transparent"
            }`}
          style={{ fontFamily: "'Space Grotesk', sans-serif" }}
        />
        {titleError && <p className="text-[var(--danger)] text-xs mt-1 mb-2">{titleErrorMsg || "A title is required before this page can be saved."}</p>}
      </div>

      {/* Metadata bar */}
      <div className="flex-shrink-0 flex items-center gap-3 mb-4 flex-wrap">
        {canChooseTeamSpace && (
          <select
            value={editing.__space || "personal"}
            onChange={(e) => setEditing({ ...editing, __space: e.target.value, folderId: null })}
            title="Where this page lives — team pages are visible to your whole team"
            className="bg-[var(--panel-raised)] border border-[var(--accent-30)] rounded-md px-2.5 py-1.5 text-xs text-[var(--accent)] focus:outline-none focus:border-[var(--accent-60)]"
          >
            <option value="personal">🔒 Personal</option>
            <option value="team">👥 Team space</option>
          </select>
        )}
        {addingFolder ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") confirmNewFolder(); if (e.key === "Escape") setAddingFolder(false); }}
              placeholder="New folder name"
              disabled={creatingFolder}
              className="bg-[var(--panel-raised)] border border-[var(--accent-60)] rounded-md px-2.5 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none w-40 disabled:opacity-60"
            />
            <button type="button" onClick={confirmNewFolder} disabled={creatingFolder} className="text-[var(--accent)] hover:text-[var(--accent-hover)] p-1">
              {creatingFolder ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
            </button>
            <button type="button" onClick={() => setAddingFolder(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xs px-1.5" title="Cancel new folder">
              <X size={13} />
            </button>
          </div>
        ) : (
          <select
            value={editing.folderId || "__root__"}
            onChange={handleFolderSelect}
            className="bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
          >
            <option value="__root__">No folder (top level)</option>
            {folderTree.map((f) => (
              <option key={f.id} value={f.id}>{"—".repeat(f.depth) + (f.depth ? " " : "")}{f.name}</option>
            ))}
            <option value="__new__">+ New folder…</option>
          </select>
        )}
        <select
          value={editing.status}
          onChange={set("status")}
          className="bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
        >
          {Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
        <input
          value={editing.tags.join(", ")}
          onChange={(e) => setEditing({ ...editing, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })}
          placeholder="tags, comma, separated"
          className="flex-1 min-w-[160px] bg-[var(--panel-raised)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
        />
      </div>

      {/* Formatting toolbar */}
      <div className="flex-shrink-0 flex items-center gap-0.5 mb-0 p-1.5 bg-[var(--panel-raised)] border border-[var(--border)] border-b-0 rounded-t-lg flex-wrap relative z-20">
        <div className="relative" ref={formatMenuRef}>
          <button
            type="button"
            onClick={() => setShowFormatMenu((v) => !v)}
            className="flex items-center gap-1 px-2 py-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--border)] transition-colors text-xs"
          >
            <Heading1 size={14} /> Format <ChevronDown size={12} />
          </button>
          {showFormatMenu && (
            <div className="absolute top-full left-0 mt-1 w-40 bg-[var(--panel)] border border-[var(--border)] rounded-md shadow-lg z-30 py-1">
              {formatOptions.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => { opt.action(); setShowFormatMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-[var(--text-primary)] hover:bg-[var(--panel-raised)]"
                >
                  <opt.icon size={13} className="text-[var(--text-muted)]" /> {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="w-px h-4 bg-[var(--border)] mx-1" />
        <EditorToolbarBtn icon={Bold} title="Bold" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} />
        <EditorToolbarBtn icon={Italic} title="Italic" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} />
        <EditorToolbarBtn icon={Strikethrough} title="Strikethrough" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()} />
        <EditorToolbarBtn icon={Underline} title="Underline" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()} />
        <div className="w-px h-4 bg-[var(--border)] mx-1" />
        <EditorToolbarBtn icon={List} title="Bullet list" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()} />
        <EditorToolbarBtn icon={ListOrdered} title="Numbered list" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
        <EditorToolbarBtn icon={IndentIncrease} title="Indent (make sub-item)" onClick={() => editor.chain().focus().sinkListItem("listItem").run()} />
        <EditorToolbarBtn icon={IndentDecrease} title="Outdent" onClick={() => editor.chain().focus().liftListItem("listItem").run()} />
        <div className="relative">
          <EditorToolbarBtn icon={Link2} title="Link" active={editor.isActive("link")} onClick={openLinkInput} />
          {showLinkInput && (
            <div className="absolute top-full left-0 mt-1 bg-[var(--panel)] border border-[var(--border)] rounded-md shadow-xl z-30 p-2 flex items-center gap-1.5 w-64">
              <input
                ref={linkInputRef}
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") confirmLink(); if (e.key === "Escape") setShowLinkInput(false); }}
                placeholder="https://..."
                className="flex-1 bg-[var(--panel-raised)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
              />
              <button onClick={confirmLink} className="text-[var(--accent)] hover:text-[var(--accent-hover)] p-1"><CheckCircle2 size={13} /></button>
            </div>
          )}
        </div>
        <div className="relative">
          <EditorToolbarBtn
            icon={Calendar}
            title="Insert date"
            active={showDatePicker}
            onClick={() => setShowDatePicker((open) => !open)}
          />
          {showDatePicker && (
            <div className="absolute top-full left-0 mt-1 z-30 w-56 rounded-md border border-[var(--border)] bg-[var(--panel)] p-3 shadow-lg">
              <p className="mb-2 text-xs text-[var(--text-secondary)]">Choose a date</p>
              <input
                type="date"
                autoFocus
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    insertSelectedDate();
                  } else if (e.key === "Escape") {
                    setShowDatePicker(false);
                  }
                }}
                className="w-full rounded border border-[var(--border)] bg-[var(--panel-raised)] px-2 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-60)]"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <button type="button" onClick={() => setSelectedDate(localToday())} className="text-xs text-[var(--accent)] hover:text-[var(--accent-hover)]">Today</button>
                <button type="button" onClick={insertSelectedDate} className="rounded bg-[var(--accent)] px-2.5 py-1 text-xs text-white hover:bg-[var(--accent-hover)]">Insert date</button>
              </div>
            </div>
          )}
        </div>
        <EditorToolbarBtn
          icon={Table2}
          title="Insert table"
          active={inTable}
          onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run()}
        />
        <EditorToolbarBtn icon={Code} title="Code block" active={editor.isActive("codeBlock")} onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
        <div className="relative">
          <EditorToolbarBtn
            icon={AtSign}
            title="Mention team member (@)"
            active={showMentionPicker}
            onClick={() => setShowMentionPicker((v) => !v)}
          />
          {showMentionPicker && (
            <div className="absolute top-full left-0 mt-1 z-30 w-64 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-2 shadow-2xl">
              <div className="px-2 py-1 border-b border-[var(--border)] text-[10px] text-[var(--accent)] font-semibold uppercase tracking-wider flex items-center gap-1">
                <AtSign size={12} /> Mention Team Member
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto pt-1">
                {TEAM_MEMBERS_DUMMY.map((member) => (
                  <button
                    key={member.email}
                    type="button"
                    onClick={() => {
                      editor.chain().focus().insertContent(` **@${member.name}** `).run();
                      setShowMentionPicker(false);
                    }}
                    className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--panel-raised)] rounded transition-colors flex items-center justify-between"
                  >
                    <div>
                      <div className="text-[var(--text-primary)] font-medium">{member.name}</div>
                      <div className="text-[var(--text-dim)] text-[10px]">{member.role}</div>
                    </div>
                    <span className="text-[10px] text-[var(--accent)] font-mono">@{member.name.split(" ")[0].toLowerCase()}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="w-px h-4 bg-[var(--border)] mx-1" />
        <EditorToolbarBtn icon={Paperclip} title="Attach files or paste screenshots" onClick={() => fileInputRef.current?.click()} />
        <input ref={fileInputRef} type="file" multiple onChange={handleAttach} className="hidden" />
        {uploading && <Loader2 size={13} className="animate-spin text-[var(--accent)] ml-1" />}
      </div>

      {inTable && (
        <div className="flex-shrink-0 flex items-center gap-0.5 px-1.5 py-1 bg-[var(--panel)] border-x border-[var(--border)] flex-wrap text-xs z-15">
          <span className="text-[var(--text-dim)] px-1.5">Table:</span>
          <button type="button" onClick={() => editor.chain().focus().addRowAfter().run()} className="px-2 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--panel-raised)] rounded">+ Row</button>
          <button type="button" onClick={() => editor.chain().focus().addColumnAfter().run()} className="px-2 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--panel-raised)] rounded">+ Column</button>
          <button type="button" onClick={() => adjustColumnWidth(editor, 30)} className="px-2 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--panel-raised)] rounded" title="Increase column size">+ Col width</button>
          <button type="button" onClick={() => adjustColumnWidth(editor, -30)} className="px-2 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--panel-raised)] rounded" title="Decrease column size">− Col width</button>
          <button type="button" onClick={() => editor.chain().focus().deleteRow().run()} className="px-2 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--panel-raised)] rounded">− Row</button>
          <button type="button" onClick={() => editor.chain().focus().deleteColumn().run()} className="px-2 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--panel-raised)] rounded">− Column</button>
          <button type="button" onClick={openLinkInput} className="px-2 py-1 text-[var(--accent)] hover:bg-[var(--panel-raised)] rounded flex items-center gap-1"><Link2 size={12} /> + Link</button>
          <button type="button" onClick={() => editor.chain().focus().deleteTable().run()} className="px-2 py-1 text-[var(--danger)] hover:bg-[var(--panel-raised)] rounded">Delete table</button>
        </div>
      )}

      {uploadError && <p className="flex-shrink-0 text-[var(--danger)] text-xs mt-1 mb-1">{uploadError}</p>}

      <div
        className="rb-content flex-1 min-h-0 w-full bg-[var(--panel)] border border-[var(--border)] rounded-b-lg p-4 cursor-text overflow-y-auto"
        onClick={() => editor.chain().focus().run()}
      >
        <EditorContent editor={editor} />
      </div>
      <p className="flex-shrink-0 text-[var(--text-dim)] text-xs mt-2">
        Paste screenshots directly with Ctrl+V or drag and drop files into the editor. Use drag handles or +/− Col width to resize table columns.
      </p>
    </div>
  );
}

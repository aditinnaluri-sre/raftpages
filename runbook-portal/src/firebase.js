import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
  sendPasswordResetEmail,
  updatePassword,
  onAuthStateChanged,
  signOut as firebaseSignOut,
} from "firebase/auth";

const apiKey = import.meta.env.VITE_FIREBASE_API_KEY || "";
const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "runbook-86573.firebaseapp.com";
const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || "runbook-86573";
const appId = import.meta.env.VITE_FIREBASE_APP_ID || "";

let app = null;
let fbAuth = null;

if (apiKey && apiKey.length > 10 && !apiKey.startsWith("AIzaSy_placeholder")) {
  try {
    app = initializeApp({ apiKey, authDomain, projectId, appId });
    fbAuth = getAuth(app);
  } catch (err) {
    console.warn("⚠️ Firebase Auth initialization failed:", err.message);
  }
} else {
  console.warn("⚠️ VITE_FIREBASE_API_KEY not configured or using default template. Firebase Auth will run in fallback mode.");
}

export { fbAuth };

const EMAIL_FOR_LINK_KEY = "runbook_pending_email";
let devAuthListeners = [];

function notifyDevAuth(user) {
  devAuthListeners.forEach((cb) => {
    try { cb(user); } catch {}
  });
}

export const googleSignIn = () => {
  if (!fbAuth) throw new Error("Firebase Auth is not configured. Please set VITE_FIREBASE_API_KEY in .env");
  return signInWithPopup(fbAuth, new GoogleAuthProvider());
};

export async function sendMagicLink(email) {
  if (!fbAuth) {
    window.localStorage.setItem("runbook_dev_token", `dev-token:${email}`);
    notifyDevAuth({ email, emailVerified: true, displayName: email.split("@")[0] });
    return;
  }
  await sendSignInLinkToEmail(fbAuth, email, {
    url: window.location.href.split("?")[0],
    handleCodeInApp: true,
  });
  window.localStorage.setItem(EMAIL_FOR_LINK_KEY, email);
}

export async function completeMagicLinkIfPresent() {
  if (!fbAuth) return false;
  if (!isSignInWithEmailLink(fbAuth, window.location.href)) return false;
  let email = window.localStorage.getItem(EMAIL_FOR_LINK_KEY);
  if (!email) {
    email = window.prompt("Confirm your email to finish signing in:");
  }
  if (!email) return false;
  await signInWithEmailLink(fbAuth, email, window.location.href);
  window.localStorage.removeItem(EMAIL_FOR_LINK_KEY);
  window.history.replaceState({}, document.title, window.location.pathname);
  return true;
}

export const onAuthChange = (cb) => {
  if (!fbAuth) {
    devAuthListeners.push(cb);
    const devToken = window.localStorage.getItem("runbook_dev_token");
    if (devToken && devToken.startsWith("dev-token:")) {
      const email = devToken.split("dev-token:")[1];
      setTimeout(() => cb({ email, emailVerified: true, displayName: email.split("@")[0] }), 0);
    } else {
      setTimeout(() => cb(null), 0);
    }
    return () => {
      devAuthListeners = devAuthListeners.filter((fn) => fn !== cb);
    };
  }
  try {
    return onAuthStateChanged(fbAuth, cb, () => cb(null));
  } catch {
    setTimeout(() => cb(null), 0);
    return () => {};
  }
};

export const signOut = () => {
  if (!fbAuth) {
    window.localStorage.removeItem("runbook_dev_token");
    notifyDevAuth(null);
    return Promise.resolve();
  }
  return firebaseSignOut(fbAuth);
};

export const getIdToken = (forceRefresh = false) => {
  if (!fbAuth) {
    return Promise.resolve(window.localStorage.getItem("runbook_dev_token") || null);
  }
  return fbAuth.currentUser ? fbAuth.currentUser.getIdToken(forceRefresh) : Promise.resolve(null);
};

export async function passwordSignUp(email, password, name) {
  if (!fbAuth) {
    const devToken = `dev-token:${email}`;
    window.localStorage.setItem("runbook_dev_token", devToken);
    const mockUser = { email, emailVerified: true, displayName: name || email.split("@")[0] };
    notifyDevAuth(mockUser);
    return mockUser;
  }
  const cred = await createUserWithEmailAndPassword(fbAuth, email, password);
  if (name) {
    await updateProfile(cred.user, { displayName: name });
    await cred.user.getIdToken(true);
  }
  await sendEmailVerification(cred.user);
  return cred.user;
}

export const passwordSignIn = async (email, password) => {
  if (!fbAuth) {
    const devToken = `dev-token:${email}`;
    window.localStorage.setItem("runbook_dev_token", devToken);
    const mockUser = { email, emailVerified: true, displayName: email.split("@")[0] };
    notifyDevAuth(mockUser);
    return { user: mockUser };
  }
  return signInWithEmailAndPassword(fbAuth, email, password);
};

export const resendVerificationEmail = () =>
  fbAuth && fbAuth.currentUser ? sendEmailVerification(fbAuth.currentUser) : Promise.reject(new Error("Not signed in"));

export async function refreshEmailVerified() {
  if (!fbAuth || !fbAuth.currentUser) return false;
  await fbAuth.currentUser.reload();
  await fbAuth.currentUser.getIdToken(true);
  return fbAuth.currentUser.emailVerified;
}

export const sendPasswordReset = (email) => {
  if (!fbAuth) {
    return Promise.resolve(true);
  }
  return sendPasswordResetEmail(fbAuth, email);
};

export async function changeUserPassword(newPassword) {
  if (!fbAuth || !fbAuth.currentUser) {
    return Promise.resolve(true);
  }
  await updatePassword(fbAuth.currentUser, newPassword);
  return true;
}

export function friendlyAuthError(err) {
  const code = err?.code || "";
  const map = {
    "auth/email-already-in-use": "That email already has an account — try signing in instead.",
    "auth/invalid-email": "That doesn't look like a valid email address.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/wrong-password": "Incorrect email or password.",
    "auth/user-not-found": "No account found with that email.",
    "auth/too-many-requests": "Too many attempts — please wait a moment and try again.",
  };
  return map[code] || err?.message || "An authentication error occurred.";
}

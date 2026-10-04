// Lightweight app-settings store (persisted to localStorage).
// The Settings modal (src/components/SettingsModal.tsx) edits these and they
// are read across components (e.g. WorkflowEditor for node-click behaviour and
// auto-save, WorkflowEditor/executor for max log items).
export interface AppSettings {
  /** open a node's config on a single click (off → double click) */
  openNodeOnClick: boolean;
  /** automatically save the workflow shortly after a change */
  autoSave: boolean;
  /** how many items to show per node in the Log console */
  maxLogItems: number;
}

export const SETTINGS_KEY = "bf-settings";
export const DEFAULT_SETTINGS: AppSettings = {
  openNodeOnClick: true,
  autoSave: true,
  maxLogItems: 5,
};

function read(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore corrupted settings */
  }
  return { ...DEFAULT_SETTINGS };
}

let cache: AppSettings | null = null;
const listeners = new Set<() => void>();

export function getSettings(): AppSettings {
  if (!cache) cache = read();
  return cache;
}

export function setSettings(patch: Partial<AppSettings>) {
  cache = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(cache));
  } catch {
    /* private mode etc. */
  }
  listeners.forEach((fn) => fn());
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ----------------------------------------------------------------------------
// Onboarding — whether the first-run "Getting started" wizard has been shown on
// this browser. New users see a short tutorial on first login; it never shows
// again once dismissed.
// ----------------------------------------------------------------------------
const WELCOME_KEY = "bf-welcome-shown";

export function hasSeenWelcome(): boolean {
  try {
    return localStorage.getItem(WELCOME_KEY) === "1";
  } catch {
    return false;
  }
}

export function markWelcomeSeen() {
  try {
    localStorage.setItem(WELCOME_KEY, "1");
  } catch {
    /* private mode etc. */
  }
}
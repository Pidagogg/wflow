/**
 * Workspace URL helpers.
 *
 * Every workspace page lives under the operator-configured prefix (`/cloud` by
 * default) while the workspace hub stays at `/home` and the welcome page at `/`.
 * Components deep inside the app must not hardcode any of those, so they build
 * links through here. The prefix is set once by App when it reads the public
 * config.
 */

let cloud = "cloud";

/** Called by App as soon as `GET /api/auth/config` answers. */
export function setCloudPath(raw?: string) {
  const clean = String(raw || "").trim().replace(/^\/+|\/+$/g, "");
  cloud = clean || "cloud";
}

export function getCloudPath() {
  return cloud;
}

/** Absolute path of a workspace page, e.g. workspaceUrl("subscription"). */
export function workspaceUrl(sub = "") {
  const clean = String(sub || "").replace(/^\/+|\/+$/g, "");
  return clean ? `/${cloud}/${clean}` : `/${cloud}`;
}

/**
 * Client-side navigation to a workspace page: pushes the URL and lets the
 * router in App re-parse it (the same path the Back button takes).
 */
export function navigateWorkspace(sub = "") {
  window.history.pushState({}, "", workspaceUrl(sub));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Rewrite the address bar without navigating (already-rendered state). */
export function syncWorkspaceUrl(sub = "") {
  window.history.replaceState({}, "", workspaceUrl(sub));
}

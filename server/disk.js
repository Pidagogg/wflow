// ============================================================================
// W FLOW — disk helpers for the file-system nodes
// All file nodes operate inside ./data/files so workflows can't touch the rest
// of the machine: paths are resolved relative to that folder and any attempt to
// escape it (absolute paths, "..") is rejected.
//
// Every account gets its own folder, data/files/users/<account id>: on a
// shared instance one account's Read File / List Files must never see what
// another account wrote. Paths are always relative to that folder, so
// workflows never mention it. Runs without an owner (tests, tooling) use
// data/files itself.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Honour BF_DATA_DIR (the same override the JSON store uses) so tests and
// throwaway copies never read or write the real ./data/files folder.
const DATA_DIR = process.env.BF_DATA_DIR || path.join(__dirname, "..", "data");
export const FILES_DIR = path.join(DATA_DIR, "files");

export function ensureFilesDir() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

/** The folder an account's file nodes work in (FILES_DIR without an owner). */
export function filesRoot(owner = "") {
  const id = String(owner || "").replace(/[^A-Za-z0-9_-]/g, "");
  return id ? path.join(FILES_DIR, "users", id) : FILES_DIR;
}

/**
 * Erase an account's whole file folder (account deletion). Never touches the
 * shared root: without a usable account id nothing is removed.
 */
export function removeAccountFolder(owner) {
  const id = String(owner || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return false;
  fs.rmSync(path.join(FILES_DIR, "users", id), { recursive: true, force: true });
  return true;
}

// Resolve a user-supplied relative path safely inside the owner's folder.
// `allowRoot` accepts an empty path as the folder itself (List Files).
// Returns { ok, fullPath, rel } or { ok:false, error }.
export function safeFilePath(rel, owner = "", { allowRoot = false } = {}) {
  const cleaned = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
  if (!cleaned && !allowRoot) return { ok: false, error: "No file path given" };
  if (cleaned.split("/").includes("..")) return { ok: false, error: `Invalid path (must stay inside data/files): ${rel}` };
  const root = path.resolve(filesRoot(owner));
  const full = path.resolve(root, cleaned);
  if (full !== root && !full.startsWith(root + path.sep)) {
    return { ok: false, error: `Invalid path (must stay inside data/files): ${rel}` };
  }
  return { ok: true, fullPath: full, rel: cleaned };
}

function extOf(name) {
  const dot = String(name).lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? String(name).slice(dot + 1).toLowerCase() : "";
}

// List files (and top-level folders) under a folder inside the owner's folder.
// `pattern` is an optional regex matched against the relative path.
export function listFilesOnDisk(relDir, pattern, recursive, owner = "") {
  const { ok, fullPath, error, rel: rootRel } = safeFilePath(relDir || "", owner, { allowRoot: true });
  if (!ok) return { ok: false, error };
  fs.mkdirSync(filesRoot(owner), { recursive: true });
  let re = null;
  if (pattern) {
    try {
      re = new RegExp(String(pattern));
    } catch {
      return { ok: false, error: "Invalid filter regular expression" };
    }
  }
  const files = [];
  const walk = (dir, baseRel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const rel = baseRel ? `${baseRel}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (ent.isDirectory()) {
        if (!recursive && (!re || re.test(rel + "/"))) {
          files.push({ name: ent.name, path: rel, size: 0, modified: stat.mtime.toISOString(), isDir: true });
        }
        if (recursive) walk(full, rel);
      } else if (!re || re.test(rel)) {
        files.push({ name: ent.name, path: rel, size: stat.size, modified: stat.mtime.toISOString(), isDir: false, ext: extOf(ent.name) });
      }
    }
  };
  walk(fullPath, rootRel);
  return { ok: true, files };
}

export function readFileBytes(rel, owner = "") {
  const { ok, fullPath, error } = safeFilePath(rel, owner);
  if (!ok) return { ok: false, error };
  try {
    return { ok: true, buffer: fs.readFileSync(fullPath) };
  } catch {
    return { ok: false, error: `File not found on disk: ${rel}` };
  }
}

/** Delete one file (or an empty folder) from the owner's folder. */
export function deleteFileOnDisk(rel, owner = "") {
  const { ok, fullPath, error, rel: cleaned } = safeFilePath(rel, owner);
  if (!ok) return { ok: false, error };
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) fs.rmdirSync(fullPath);
    else fs.unlinkSync(fullPath);
    return { ok: true, path: cleaned };
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: false, error: `File not found on disk: ${rel}` };
    if (err?.code === "ENOTEMPTY") return { ok: false, error: "That folder is not empty — delete the files in it first." };
    return { ok: false, error: `Could not delete the file: ${String(err.message || err)}` };
  }
}

/** Total bytes stored in the owner's folder (the My files page shows it). */
export function folderBytes(owner = "") {
  const res = listFilesOnDisk("", "", true, owner);
  return res.ok ? res.files.reduce((n, f) => n + (f.size || 0), 0) : 0;
}

/** Whether writing `size` bytes to `rel` keeps the folder within `limitBytes`
 *  (a file being replaced no longer counts). */
export function fitsInFolder(rel, size, owner, limitBytes) {
  const target = safeFilePath(rel, owner);
  let replaced = 0;
  try {
    if (target.ok) replaced = fs.statSync(target.fullPath).size;
  } catch {
    /* new file */
  }
  return folderBytes(owner) - replaced + size <= limitBytes;
}

export function writeFileBytes(rel, data, owner = "") {
  const { ok, fullPath, error, rel: cleaned } = safeFilePath(rel, owner);
  if (!ok) return { ok: false, error };
  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, data);
    return { ok: true, path: cleaned, size: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data) };
  } catch (err) {
    return { ok: false, error: `Could not write the file: ${String(err.message || err)}` };
  }
}

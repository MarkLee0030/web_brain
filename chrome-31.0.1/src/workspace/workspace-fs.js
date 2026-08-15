/**
 * Sandboxed working-directory filesystem operations.
 *
 * Guard layers (all file access flows through this module):
 *   1. OS-level sandbox: every operation starts from the user-picked
 *      FileSystemDirectoryHandle (persisted in IndexedDB). The handle API
 *      cannot reach outside its root — '..' and absolute paths throw.
 *   2. Path validation: normalizeWorkspacePath() rejects absolute paths,
 *      drive letters, '..'/'.' segments and invalid characters before any
 *      handle call. Every tool entry point below uses it.
 *   3. Agent permission gate: mutating tools require a Capability.FILESYSTEM
 *      grant (see permission-gate.js).
 *
 * The picker itself (showDirectoryPicker) is window-only and lives in the
 * side panel; the resulting handle is posted here via background.js
 * ('pick_working_directory') and stored in IndexedDB (handles are
 * structured-cloneable but not JSON-serializable, so chrome.storage cannot
 * hold them).
 */

const DB_NAME = 'webbrain_workspace';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'directory';

const WORKSPACE_READ_MAX_CHARS = 64 * 1024;

let cachedHandle = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveWorkspaceHandle(handle) {
  if (!handle || typeof handle.getDirectoryHandle !== 'function') {
    throw new Error('Not a directory handle');
  }
  cachedHandle = handle;
  await idbSet(HANDLE_KEY, handle);
}

export async function loadWorkspaceHandle() {
  if (cachedHandle) return cachedHandle;
  try {
    cachedHandle = await idbGet(HANDLE_KEY);
  } catch (e) {
    cachedHandle = null;
  }
  return cachedHandle;
}

// Drops the in-memory cache so the next loadWorkspaceHandle() re-reads the
// handle from IndexedDB. Needed because the side panel writes the handle to
// IndexedDB in its own context (chrome.runtime messaging is JSON-only and
// cannot carry FileSystemHandle objects), so this context's cache can be
// stale after a re-pick.
export function resetWorkspaceHandleCache() {
  cachedHandle = null;
}

export async function clearWorkspaceHandle() {
  cachedHandle = null;
  await idbDelete(HANDLE_KEY).catch(() => {});
}

/**
 * Validate + split a workspace-relative path into safe segments.
 * Returns [] for ''/'.' (the workspace root) and null when the path is
 * rejected (absolute, drive letter, '..', empty or invalid segments).
 */
export function normalizeWorkspacePath(path) {
  const raw = String(path ?? '').trim().replace(/\\/g, '/');
  if (!raw) return [];
  if (/^([a-zA-Z]:|\/|~)/.test(raw)) return null;
  const segments = raw.split('/').map((s) => s.trim());
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return null;
    if (/[\u0000-\u001f\u007f<>:"|?*]/.test(seg)) return null;
  }
  return segments;
}

// Permission-style wording for every escape attempt, so the model reads it
// as a sandbox boundary (retry with a relative path) rather than a bug.
function workspaceEscapeError(path) {
  return `Permission denied: "${String(path)}" is outside the working directory — paths must stay relative to it (absolute paths, drive letters, ".." and invalid filename characters are rejected by the sandbox).`;
}

async function requireHandle() {
  const handle = await loadWorkspaceHandle();
  if (!handle) {
    throw new Error(
      'No working directory selected. Ask the user to pick one with the folder button in the WebBrain side panel header.',
    );
  }
  // Chrome revokes the readwrite permission across extension reloads and
  // browser restarts; the handle then exists but every operation throws
  // NotAllowedError. Surface an actionable message instead of a raw error.
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      throw new Error(
        'The working directory permission needs re-authorization (Chrome revokes it when the extension reloads or the browser restarts). Ask the user to click the folder button in the WebBrain side panel header once to re-grant it.',
      );
    }
  } catch (e) {
    if (e && e.message && e.message.includes('needs re-authorization')) throw e;
    // queryPermission unavailable/other error: fall through and let the
    // operation itself report any permission problem.
  }
  return handle;
}

async function resolveDirMaybe(handle, segments, create) {
  let dir = handle;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}

function friendlyPath(segments) {
  return segments.length ? segments.join('/') : '.';
}

export async function workspaceList(path) {
  const handle = await requireHandle();
  const segments = normalizeWorkspacePath(path);
  if (segments === null) throw new Error(workspaceEscapeError(path));
  let dir;
  try {
    dir = await resolveDirMaybe(handle, segments, false);
  } catch {
    throw new Error(`Folder not found in working directory: ${friendlyPath(segments)}`);
  }
  const entries = [];
  for await (const [name, entry] of dir.entries()) {
    const item = { name, kind: entry.kind };
    if (entry.kind === 'file') {
      try {
        const file = await entry.getFile();
        item.size = file.size;
        item.type = file.type || null;
      } catch { /* keep size null */ }
    }
    entries.push(item);
  }
  entries.sort((a, b) => (
    a.kind === b.kind ? a.name.localeCompare(b.name) : (a.kind === 'directory' ? -1 : 1)
  ));
  return { path: friendlyPath(segments), entries };
}

export async function workspaceMkdir(path) {
  const handle = await requireHandle();
  const segments = normalizeWorkspacePath(path);
  if (segments === null || segments.length === 0) {
    throw new Error(workspaceEscapeError(path));
  }
  await resolveDirMaybe(handle, segments, true);
  return { created: friendlyPath(segments) };
}

export async function workspaceDelete(path) {
  const handle = await requireHandle();
  const segments = normalizeWorkspacePath(path);
  if (segments === null) throw new Error(workspaceEscapeError(path));
  if (segments.length === 0) {
    throw new Error('Refusing to delete the working directory root');
  }
  const parent = await resolveDirMaybe(handle, segments.slice(0, -1), false);
  await parent.removeEntry(segments[segments.length - 1], { recursive: true });
  return { deleted: friendlyPath(segments) };
}

function sanitizeFilename(name) {
  const base = String(name ?? '')
    .replace(/[\\/]/g, '')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return base || 'file';
}

async function uniqueName(dir, base) {
  let candidate = base;
  let counter = 0;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  while (true) {
    try {
      await dir.getFileHandle(candidate);
      counter += 1;
      candidate = `${stem}-${counter}${ext}`;
    } catch {
      return candidate;
    }
  }
}

export async function workspaceWriteFile(path, content, opts = {}) {
  const handle = await requireHandle();
  const segments = normalizeWorkspacePath(path);
  if (segments === null || segments.length === 0) {
    throw new Error(workspaceEscapeError(path));
  }
  const text = typeof content === 'string' ? content : String(content ?? '');
  const parent = await resolveDirMaybe(handle, segments.slice(0, -1), true);
  let name = segments[segments.length - 1];
  if (!opts.overwrite) name = await uniqueName(parent, name);
  const fileHandle = await parent.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
  return { path: friendlyPath(segments.slice(0, -1).concat(name)), bytes: new Blob([text]).size };
}

export async function workspaceReadFile(path) {
  const handle = await requireHandle();
  const segments = normalizeWorkspacePath(path);
  if (segments === null || segments.length === 0) {
    throw new Error(workspaceEscapeError(path));
  }
  const dir = await resolveDirMaybe(handle, segments.slice(0, -1), false);
  const fileHandle = await dir.getFileHandle(segments[segments.length - 1]);
  const file = await fileHandle.getFile();
  const text = await file.text().catch(() => null);
  if (text === null) {
    throw new Error(`File is binary and cannot be read as text: ${friendlyPath(segments)}`);
  }
  const truncated = text.length > WORKSPACE_READ_MAX_CHARS;
  return {
    path: friendlyPath(segments),
    truncated,
    content: truncated ? `${text.slice(0, WORKSPACE_READ_MAX_CHARS)}\n[truncated]` : text,
  };
}

/**
 * Read a file from the working directory into an upload payload
 * ({ base64, filename, mimeType }) for upload_file's in-memory injection.
 * Relative paths only — absolute paths, drive letters and ".." are rejected
 * like every other workspace entry point.
 */
export async function workspaceReadUpload(path) {
  const handle = await requireHandle();
  const segments = normalizeWorkspacePath(path);
  if (segments === null || segments.length === 0) {
    throw new Error(workspaceEscapeError(path));
  }
  const dir = await resolveDirMaybe(handle, segments.slice(0, -1), false);
  const fileHandle = await dir.getFileHandle(segments[segments.length - 1]);
  const file = await fileHandle.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return {
    filename: file.name,
    base64: btoa(binary),
    mimeType: file.type || 'application/octet-stream',
  };
}

export function filenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').filter(Boolean).pop() || '';
    return sanitizeFilename(decodeURIComponent(last));
  } catch {
    return 'file';
  }
}

const WORKSPACE_DOWNLOAD_CONCURRENCY = 3;
const WORKSPACE_DOWNLOAD_MAX = 50;

/**
 * Fetch one or more URLs and write the bytes directly INTO the working
 * directory (subfolder created on demand). Bypasses chrome.downloads, so no
 * save-dialog or Downloads-folder routing is involved. Duplicate basenames
 * get a -N suffix instead of overwriting.
 */
export async function workspaceDownload(urls, { subfolder = '' } = {}) {
  const handle = await requireHandle();
  if (!Array.isArray(urls) || urls.length === 0) {
    return { success: false, error: 'urls array is required' };
  }
  if (urls.length > WORKSPACE_DOWNLOAD_MAX) {
    return { success: false, error: `Too many URLs (max ${WORKSPACE_DOWNLOAD_MAX})` };
  }
  const subSegments = normalizeWorkspacePath(subfolder);
  if (subSegments === null) return { success: false, denied: true, error: workspaceEscapeError(subfolder) };
  const targetDir = await resolveDirMaybe(handle, subSegments, true);

  const results = new Array(urls.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= urls.length) return;
      const url = urls[i];
      try {
        const res = await fetch(url);
        if (!res.ok) {
          results[i] = { url, success: false, error: `HTTP ${res.status}` };
          continue;
        }
        const blob = await res.blob();
        const base = filenameFromUrl(url) || `file-${i + 1}`;
        const name = await uniqueName(targetDir, base);
        const fileHandle = await targetDir.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        results[i] = {
          url,
          success: true,
          path: friendlyPath(subSegments.concat(name)),
          bytes: blob.size,
        };
      } catch (e) {
        results[i] = { url, success: false, error: e?.message || String(e) };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(WORKSPACE_DOWNLOAD_CONCURRENCY, urls.length) }, () => worker()),
  );
  return {
    success: results.some((r) => r?.success),
    results,
    savedCount: results.filter((r) => r?.success).length,
    failedCount: results.filter((r) => r && !r.success).length,
  };
}

/**
 * Stream a fetch Response body directly INTO the working directory root
 * (used by skill HTTP download jobs such as download_public_media, so their
 * files land in the working directory instead of the browser Downloads
 * folder). The name is sanitized and uniquified; nothing is overwritten.
 */
export async function workspaceSaveStream(name, response) {
  const handle = await requireHandle();
  const base = sanitizeFilename(name);
  const finalName = await uniqueName(handle, base);
  const fileHandle = await handle.getFileHandle(finalName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await response.body.pipeTo(writable);
  } catch (e) {
    try { await writable.abort(); } catch { /* already closed */ }
    throw e;
  }
  const length = response.headers?.get?.('content-length');
  return { success: true, path: finalName, bytes: length ? Number(length) : null };
}

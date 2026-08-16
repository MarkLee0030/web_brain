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
const WHITELIST_KEY = 'whitelist';

const WORKSPACE_READ_MAX_CHARS = 64 * 1024;

let cachedHandle = null;
let cachedWhitelist = null;

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

// ─── Whitelisted directories ────────────────────────────────────────────────
// Extra user-granted local folders (Settings → 白名单工作目录) that the agent
// may READ and copy files OUT of — e.g. Chrome's default Downloads folder,
// where virtual-click downloads on blocker sites land. Handles persist in the
// same IndexedDB store as the working directory; storage.local mirrors only
// the names. Writes into these directories are limited to removing a source
// file after a verified copy (workspaceCopyIn move:true).

export async function saveWhitelistHandle(handle) {
  if (!handle || typeof handle.getDirectoryHandle !== 'function') {
    throw new Error('Not a directory handle');
  }
  const list = await loadWhitelistHandles();
  const name = String(handle.name || '');
  const idx = list.findIndex((w) => w.name.toLowerCase() === name.toLowerCase());
  if (idx >= 0) list[idx] = { name, handle };
  else list.push({ name, handle });
  cachedWhitelist = list;
  await idbSet(WHITELIST_KEY, list);
}

export async function loadWhitelistHandles() {
  if (cachedWhitelist) return cachedWhitelist;
  try {
    cachedWhitelist = (await idbGet(WHITELIST_KEY)) || [];
  } catch (e) {
    cachedWhitelist = [];
  }
  return cachedWhitelist;
}

// Same cross-context reason as resetWorkspaceHandleCache: the settings page
// writes to IndexedDB in its own context, so re-read instead of trusting this
// context's cache.
export function resetWhitelistHandlesCache() {
  cachedWhitelist = null;
}

export async function removeWhitelistHandle(name) {
  const list = await loadWhitelistHandles();
  const target = String(name ?? '').trim().toLowerCase();
  cachedWhitelist = list.filter((w) => w.name.toLowerCase() !== target);
  await idbSet(WHITELIST_KEY, cachedWhitelist);
}

/** Names + current FSA permission state, for the settings UI and messages. */
export async function whitelistHandlesState() {
  const list = await loadWhitelistHandles();
  const out = [];
  for (const w of list) {
    let permission = 'none';
    try {
      if (w.handle && typeof w.handle.queryPermission === 'function') {
        permission = await w.handle.queryPermission({ mode: 'readwrite' });
      }
    } catch { permission = 'unknown'; }
    out.push({ name: w.name, permission });
  }
  return out;
}

async function findWhitelistHandle(name) {
  const list = await loadWhitelistHandles();
  const target = String(name ?? '').trim().toLowerCase();
  const w = list.find((x) => x.name.toLowerCase() === target);
  if (!w) {
    const names = list.map((x) => x.name).join(', ') || '(none)';
    throw new Error(
      `No whitelisted directory named "${name}". Whitelisted directories: ${names}. The user adds them in Settings → 白名单工作目录 (Display tab).`,
    );
  }
  try {
    const perm = await w.handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      throw new Error(
        `The whitelisted directory "${w.name}" needs re-authorization (Chrome revokes it when the extension reloads or the browser restarts). Ask the user to click "重新授权" next to it in Settings → 白名单工作目录.`,
      );
    }
  } catch (e) {
    if (e && e.message && e.message.includes('needs re-authorization')) throw e;
  }
  return w;
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

async function listDirEntries(dir) {
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
  return entries;
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
  return { path: friendlyPath(segments), entries: await listDirEntries(dir) };
}

/**
 * List whitelisted directories (no `dir` argument), or the contents of one
 * (`dir` + optional relative `path`). Read-only; the whitelist is the user's
 * explicit grant in Settings, so no capability gate is required.
 */
export async function workspaceWhitelistList(dir = null, path = '') {
  if (dir == null || String(dir).trim() === '') {
    const list = await loadWhitelistHandles();
    return { directories: list.map((w) => ({ name: w.name })) };
  }
  const w = await findWhitelistHandle(dir);
  const segments = normalizeWorkspacePath(path);
  if (segments === null) throw new Error(workspaceEscapeError(path));
  let sub;
  try {
    sub = await resolveDirMaybe(w.handle, segments, false);
  } catch {
    throw new Error(`Folder not found in whitelisted directory "${w.name}": ${friendlyPath(segments)}`);
  }
  return { directory: w.name, path: friendlyPath(segments), entries: await listDirEntries(sub) };
}

/**
 * Copy a single file from a whitelisted directory INTO the working directory.
 * `destPath` defaults to the file's own name at the workspace root; pass a
 * relative subfolder path (e.g. "page-title/name.zip") to land it in a folder
 * the agent created. move:true (default) removes the source file only AFTER
 * the copy completed — a failed remove is reported, never silent data loss.
 */
export async function workspaceCopyIn({ dir, path, destPath = '', move = true }) {
  const handle = await requireHandle();
  const dirName = String(dir ?? '').trim();
  if (!dirName) {
    throw new Error('workspace_copy_in needs "dir": the name of a whitelisted directory (see workspace_whitelist_list).');
  }
  const w = await findWhitelistHandle(dirName);
  const srcSegments = normalizeWorkspacePath(path);
  if (srcSegments === null || srcSegments.length === 0) throw new Error(workspaceEscapeError(path));
  const srcParent = await resolveDirMaybe(w.handle, srcSegments.slice(0, -1), false);
  const srcName = srcSegments[srcSegments.length - 1];
  let srcHandle;
  try {
    srcHandle = await srcParent.getFileHandle(srcName);
  } catch {
    throw new Error(`File not found in whitelisted directory "${w.name}": ${friendlyPath(srcSegments)}`);
  }
  const file = await srcHandle.getFile();
  const destRaw = String(destPath ?? '').trim();
  const destSegments = destRaw ? normalizeWorkspacePath(destRaw) : [file.name];
  if (destSegments === null) throw new Error(workspaceEscapeError(destRaw));
  const destParent = await resolveDirMaybe(handle, destSegments.slice(0, -1), true);
  const finalName = await uniqueName(destParent, destSegments[destSegments.length - 1]);
  const outHandle = await destParent.getFileHandle(finalName, { create: true });
  const writable = await outHandle.createWritable();
  await writable.write(file);
  await writable.close();
  let removed = false;
  let note = null;
  if (move) {
    try {
      await srcParent.removeEntry(srcName);
      removed = true;
    } catch (e) {
      note = `Copied successfully, but the source file could not be removed from "${w.name}" (${e?.message || String(e)}). You may delete it manually later.`;
    }
  }
  return {
    success: true,
    sourceDir: w.name,
    path: friendlyPath(destSegments.slice(0, -1).concat(finalName)),
    bytes: file.size,
    moved: move === true,
    removed,
    ...(note ? { note } : {}),
  };
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

// ─── ZIP extraction (workspace_extract) ─────────────────────────────────────
// Dependency-free ZIP reader: central-directory parsing + the platform's
// native DecompressionStream('deflate-raw') for method-8 entries (ZIP stores
// raw DEFLATE bitstreams, which is exactly the 'deflate-raw' format). Stored
// entries (method 0) are copied verbatim. RAR/7z/tar are refused — their
// formats have no browser-native decoder.

const EXTRACT_MAX_ENTRIES = 3000;
const EXTRACT_MAX_TOTAL_BYTES = 3 * 1024 * 1024 * 1024;
const EXTRACT_MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;

function readU16(u8, o) { return u8[o] | (u8[o + 1] << 8); }
function readU32(u8, o) { return ((u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0); }

function parseZipCentral(u8) {
  // End-of-central-directory record: scan backwards from the end (comment
  // may trail it, up to 64K).
  let eocd = -1;
  const min = Math.max(0, u8.length - 65557);
  for (let i = u8.length - 22; i >= min; i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a valid ZIP archive (missing end-of-central-directory record)');
  if (readU16(u8, eocd + 4) !== 0 || readU16(u8, eocd + 6) !== 0) {
    throw new Error('Multi-disk ZIP archives are not supported');
  }
  const entriesTotal = readU16(u8, eocd + 10);
  const cdSize = readU32(u8, eocd + 12);
  const cdOffset = readU32(u8, eocd + 16);
  if (entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < entriesTotal; n++) {
    if (p + 46 > u8.length || readU32(u8, p) !== 0x02014b50) {
      throw new Error('Corrupt ZIP central directory');
    }
    const flags = readU16(u8, p + 8);
    const method = readU16(u8, p + 10);
    const csize = readU32(u8, p + 20);
    const usize = readU32(u8, p + 24);
    const nameLen = readU16(u8, p + 28);
    const extraLen = readU16(u8, p + 30);
    const commentLen = readU16(u8, p + 32);
    const localOffset = readU32(u8, p + 42);
    if (csize === 0xffffffff || usize === 0xffffffff) {
      throw new Error('ZIP64 entries are not supported');
    }
    const name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.push({
      name,
      flags,
      method,
      csize,
      usize,
      localOffset,
      encrypted: (flags & 1) === 1,
      isDir: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Convert a raw archive entry name to safe relative segments. Rejects
// absolute/escaping paths and sanitizes invalid filename characters.
function sanitizeEntryPath(name) {
  const raw = String(name ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  const out = [];
  for (const seg of segments) {
    if (seg === '..') throw new Error('entry escapes its folder (".." segment)');
    out.push(sanitizeFilename(seg));
  }
  return out;
}

async function inflateRawDeflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(out);
}

async function readZipEntryData(u8, entry) {
  const p = entry.localOffset;
  if (p + 30 > u8.length || readU32(u8, p) !== 0x04034b50) {
    throw new Error('corrupt local header');
  }
  const nameLen = readU16(u8, p + 26);
  const extraLen = readU16(u8, p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.csize;
  if (dataEnd > u8.length) throw new Error('truncated entry data');
  const raw = u8.slice(dataStart, dataEnd);
  if (entry.method === 0) return raw;
  return inflateRawDeflate(raw);
}

/**
 * Extract a .zip archive that lives INSIDE the working directory.
 * `destPath` defaults to the archive's own folder; internal structure is
 * preserved, entry names are sanitized, existing files are never overwritten
 * (-N suffix), and unsafe/encrypted/oversized entries are skipped with a
 * per-entry reason. RAR/7z/tar are refused with a clear error.
 */
export async function workspaceExtract(path, destPath = null) {
  const handle = await requireHandle();
  const archSegments = normalizeWorkspacePath(path);
  if (archSegments === null || archSegments.length === 0) throw new Error(workspaceEscapeError(path));
  const archDir = await resolveDirMaybe(handle, archSegments.slice(0, -1), false);
  const archName = archSegments[archSegments.length - 1];
  let archHandle;
  try {
    archHandle = await archDir.getFileHandle(archName);
  } catch {
    throw new Error(`Archive not found in working directory: ${friendlyPath(archSegments)}`);
  }
  const lower = archName.toLowerCase();
  if (/\.(rar|7z|tar|gz|tgz|bz2|xz)$/.test(lower)) {
    throw new Error(`Unsupported archive format "${archName}" — workspace_extract only supports .zip archives. Ask the user to extract it manually (or re-download as .zip) and copy the files into the working directory.`);
  }
  const u8 = new Uint8Array(await (await archHandle.getFile()).arrayBuffer());
  if (!(u8[0] === 0x50 && u8[1] === 0x4b)) {
    throw new Error(`"${archName}" is not a ZIP archive`);
  }
  const destRaw = destPath == null ? '' : String(destPath).trim();
  const destSegments = destRaw ? normalizeWorkspacePath(destRaw) : archSegments.slice(0, -1);
  if (destSegments === null) throw new Error(workspaceEscapeError(destRaw));
  const destRoot = await resolveDirMaybe(handle, destSegments, true);

  const entries = parseZipCentral(u8);
  if (entries.length === 0) throw new Error('ZIP archive is empty');
  if (entries.length > EXTRACT_MAX_ENTRIES) {
    throw new Error(`ZIP has ${entries.length} entries (max ${EXTRACT_MAX_ENTRIES})`);
  }
  const skipped = [];
  const files = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.encrypted) { skipped.push({ name: entry.name, reason: 'encrypted' }); continue; }
    if (entry.method !== 0 && entry.method !== 8) {
      skipped.push({ name: entry.name, reason: `compression method ${entry.method}` });
      continue;
    }
    if (entry.usize > EXTRACT_MAX_ENTRY_BYTES) {
      skipped.push({ name: entry.name, reason: 'too large' });
      continue;
    }
    let segs;
    try {
      segs = sanitizeEntryPath(entry.name);
    } catch (e) {
      skipped.push({ name: entry.name, reason: e.message });
      continue;
    }
    if (entry.isDir || segs.length === 0) {
      if (segs.length > 0) await resolveDirMaybe(destRoot, segs, true).catch(() => {});
      continue;
    }
    total += entry.usize;
    if (total > EXTRACT_MAX_TOTAL_BYTES) {
      throw new Error(`ZIP contents exceed ${EXTRACT_MAX_TOTAL_BYTES} bytes in total — extract a subset instead`);
    }
    try {
      const data = await readZipEntryData(u8, entry);
      const parent = await resolveDirMaybe(destRoot, segs.slice(0, -1), true);
      const finalName = await uniqueName(parent, segs[segs.length - 1]);
      const outHandle = await parent.getFileHandle(finalName, { create: true });
      const writable = await outHandle.createWritable();
      await writable.write(data);
      await writable.close();
      files.push({
        path: friendlyPath(destSegments.concat(segs.slice(0, -1).concat(finalName))),
        bytes: data.byteLength,
      });
    } catch (e) {
      skipped.push({ name: entry.name, reason: e?.message || String(e) });
    }
  }
  return {
    success: files.length > 0,
    destPath: friendlyPath(destSegments),
    extractedCount: files.length,
    files,
    skipped,
  };
}

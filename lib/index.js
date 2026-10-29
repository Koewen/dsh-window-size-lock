/**
 * dsh-window-size-lock
 *
 * Persists & locks the DeepSeek Harness (DSH) main window size across sessions.
 *
 * WHY Win32 from a host plugin (architecture notes)
 * -------------------------------------------------
 * DSH host plugins run in a plain-Node child process (the Electron main
 * process spawns @deepseek-ai/dsh-desktop-host with ELECTRON_RUN_AS_NODE=1),
 * so `import 'electron'` is impossible and there are no BrowserWindow objects
 * here. But this child process:
 *   - runs in the same interactive desktop session as the main window, so
 *     user32.dll window APIs work on the DSH window from here, and
 *   - is a DIRECT child of the Electron main process, so `process.ppid` is
 *     exactly the PID that owns the main window — no process-name guessing.
 *
 * Strategy: enumerate top-level windows of the parent PID, take the largest
 * visible one (the product window), then:
 *   1. On (re)appearance of the window: restore the saved size, and keep
 *      re-asserting it for a short grace period to beat DSH's default layout.
 *   2. While running: when the size changes and stays stable, adopt it as the
 *      new lock and persist it.
 *
 * Persistence: %APPDATA%\@deepseek-ai\dsh-desktop\window-size-lock.json
 * (DSH's own userData directory), stable across sessions.
 *
 * Limitation: Electron enforces a minimum window size (~520x600) at the
 * Chromium message layer; no external caller can go below that floor.
 *
 * @module dsh-window-size-lock
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const name = 'window-size-lock';
// No cordis services required — user32.dll is loaded via koffi from this
// package's own node_modules (koffi ships prebuilt win32-x64 binaries).
export const inject = [];

/** Resolve koffi from this package's physical location (symlink-proof). */
function loadKoffi() {
  const realLibDir = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
  const pkgRoot = dirname(realLibDir);
  const requireFromPkg = createRequire(join(pkgRoot, 'package.json'));
  return requireFromPkg('koffi');
}

const GW_HWNDNEXT = 2;
const POLL_DEFAULT = 500;
const GRACE_DEFAULT = 3000;

function storePath() {
  const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(base, '@deepseek-ai', 'dsh-desktop', 'window-size-lock.json');
}

export function apply(ctx, config) {
  const log = (...a) => {
    try { ctx.logger?.info?.('[window-size-lock]', ...a); }
    catch { /* keep going */ }
    try { console.log('[window-size-lock]', ...a); } catch { /* ignore */ }
  };
  const warn = (...a) => {
    try { ctx.logger?.warn?.('[window-size-lock]', ...a); }
    catch { /* keep going */ }
    try { console.warn('[window-size-lock]', ...a); } catch { /* ignore */ }
  };

  if (config?.enabled === false) {
    log('disabled by config; staying inactive');
    return;
  }

  let koffi;
  try {
    koffi = loadKoffi();
  } catch (e) {
    warn(`koffi failed to load — plugin inactive. Run "npm install" in the plugin folder. (${e?.message ?? e})`);
    return;
  }

  // ---- user32 bindings (HWND as void*, plain Buffers for out-params) ----
  let user32;
  try {
    user32 = koffi.load('user32.dll');
  } catch (e) {
    warn(`user32.dll failed to load — plugin inactive. (${e?.message ?? e})`);
    return;
  }
  const GetTopWindow = user32.func('void* __stdcall GetTopWindow(void *hWnd)');
  const GetWindow = user32.func('void* __stdcall GetWindow(void *hWnd, uint32 cmd)');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hWnd)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hWnd, void *rect)');        // rect: 16-byte Buffer, int32 l,t,r,b
  const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, void *pid)'); // pid: 4-byte Buffer
  const MoveWindow = user32.func('bool __stdcall MoveWindow(void *hWnd, int32 x, int32 y, int32 w, int32 h, bool repaint)');

  // Test override: config.ownerPid pins the owning process explicitly; in
  // production this is always the Electron main process (our direct parent).
  const ownerPid = Number(config?.ownerPid) > 0 ? Number(config.ownerPid) : process.ppid;
  const pidBuf = Buffer.alloc(4);
  const rectBuf = Buffer.alloc(16);

  // NOTE: in koffi, a NULL void* result comes back as an opaque object, NOT
  // JS null — the Z-order walk must terminate via koffi.address() === 0n.
  function hwndAddr(hwnd) {
    try { return koffi.address(hwnd); } catch { return 0n; }
  }

  /** Largest visible top-level window owned by the parent process. */
  function findMainWindow() {
    let best = null;
    let bestArea = 0;
    try {
      let hwnd = GetTopWindow(null);
      let guard = 0;
      while (guard++ < 4096) {
        if (hwndAddr(hwnd) <= 0n) break; // NULL: end of the Z-order chain
        try {
          if (IsWindowVisible(hwnd)) {
            pidBuf.writeUInt32LE(0, 0);
            GetWindowThreadProcessId(hwnd, pidBuf);
            if (pidBuf.readUInt32LE(0) === ownerPid) {
              if (GetWindowRect(hwnd, rectBuf)) {
                const l = rectBuf.readInt32LE(0);
                const t = rectBuf.readInt32LE(4);
                const r = rectBuf.readInt32LE(8);
                const b = rectBuf.readInt32LE(12);
                const w = r - l;
                const h = b - t;
                if (w > 0 && h > 0 && w * h > bestArea) {
                  bestArea = w * h;
                  best = { hwnd, l, t, w, h };
                }
              }
            }
          }
        } catch { /* skip this window */ }
        hwnd = GetWindow(hwnd, GW_HWNDNEXT);
      }
    } catch (e) {
      warn(`window enumeration failed: ${e?.message ?? e}`);
    }
    return best;
  }

  // ---- persistence ----
  function loadLock() {
    const p = storePath();
    if (!existsSync(p)) return null;
    try {
      const o = JSON.parse(readFileSync(p, 'utf8'));
      if (Number.isInteger(o.width) && Number.isInteger(o.height) && o.width > 0 && o.height > 0) {
        return { width: o.width, height: o.height };
      }
    } catch (e) {
      warn(`corrupt size file ignored: ${e?.message ?? e}`);
    }
    return null;
  }

  function saveLock(lock) {
    try {
      const p = storePath();
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ ...lock, updatedAt: new Date().toISOString() }, null, 2));
      log(`SAVED lock ${lock.width}x${lock.height}`);
    } catch (e) {
      warn(`cannot save size: ${e?.message ?? e}`);
    }
  }

  // ---- watch loop ----
  const pollMs = Number(config?.pollMs) > 0 ? Number(config.pollMs) : POLL_DEFAULT;
  const graceMs = Number(config?.graceMs) >= 0 ? Number(config.graceMs) : GRACE_DEFAULT;

  let lock = loadLock();
  if (lock) log(`LOADED lock ${lock.width}x${lock.height}`);
  else log('no saved size yet; the first stable resize becomes the lock');

  let seenWindow = false;   // was a window found in the previous poll?
  let lastApplied = null;   // size we last set (to ignore our own writes)
  let lastSeen = null;      // previous-poll size (debounce: need 2 equal reads)
  let graceUntil = 0;

  function applyLock(win) {
    try {
      MoveWindow(win.hwnd, win.l, win.t, lock.width, lock.height, true);
      lastApplied = { width: lock.width, height: lock.height };
      log(`applied lock ${lock.width}x${lock.height}`);
    } catch (e) {
      warn(`MoveWindow failed: ${e?.message ?? e}`);
    }
  }

  let pollCount = 0;
  const timer = setInterval(() => {
    pollCount++;
    if (pollCount % 240 === 1) log(`watcher alive (poll #${pollCount})`);
    const win = findMainWindow();
    if (!win) {
      seenWindow = false;
      lastApplied = null;
      lastSeen = null;
      return;
    }

    // Window (re)appeared: restart the grace period and restore the lock.
    if (!seenWindow) {
      seenWindow = true;
      graceUntil = Date.now() + graceMs;
      lastApplied = null;
      lastSeen = null;
      if (lock) applyLock(win);
      return;
    }

    const cur = { width: win.w, height: win.h };
    if (lastApplied && cur.width === lastApplied.width && cur.height === lastApplied.height) return;

    // During the grace window DSH is still settling its default layout — keep forcing our lock.
    if (Date.now() < graceUntil && lock) {
      applyLock(win);
      return;
    }

    // Debounce: adopt only when the same foreign size is seen twice in a row.
    // Never adopt the DSH factory default (1280x820): if DSH re-asserts its
    // default layout after our grace period, adopting it would destroy the
    // user's saved lock.
    const isFactoryDefault = cur.width === 1280 && cur.height === 820;
    if (!isFactoryDefault && lastSeen && lastSeen.width === cur.width && lastSeen.height === cur.height) {
      lock = cur;
      lastApplied = { ...cur };
      saveLock(lock);
    } else {
      lastSeen = cur;
    }
  }, pollMs);

  // Proven cordis disposal pattern (same as @michengai/dsh-cost-meter):
  // the setup callback must RETURN the dispose function.
  ctx.effect(() => () => {
    clearInterval(timer);
    log(`watcher stopped after ${pollCount} polls`);
  }, 'window-size-lock: watcher');
}

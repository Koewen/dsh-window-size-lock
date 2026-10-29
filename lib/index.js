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
 *   2. While running: when the size stays stable across several polls, adopt
 *      it as the new lock and persist it.
 *   3. Minimized / maximized / borderless-fullscreen states are NEVER
 *      recorded. While the window is in any of them all recording pauses;
 *      on restore the saved non-fullscreen size is re-asserted.
 *
 * Robustness (v1.3.0 audit fixes):
 *   - IsIconic: a minimized window reports the classic offscreen rect
 *     (-32000,-32000, ~199x34) with IsWindowVisible still true; it used to be
 *     adoptable as a "size" and its offscreen origin could be fed into
 *     MoveWindow (window lost off-screen after restore). Now frozen like
 *     maximized.
 *   - Borderless fullscreen (F11 / setFullScreen) is not WS_MAXIMIZE, so
 *     IsZoomed misses it; a monitor-cover heuristic freezes it too.
 *   - Per-monitor DPI awareness v2 is requested at startup (best effort) so
 *     coordinates are physical pixels — mixed-DPI multi-monitor restores no
 *     longer drift by the scale factor.
 *   - The whole poll body is wrapped in try/catch: an unexpected throw must
 *     never take down the host child process.
 *   - Re-asserts are skipped while the size is still changing between polls
 *     (user dragging), so we never fight the pointer.
 *   - Adoption requires 3 consecutive equal reads (was 2), and the factory
 *     default 1280x820 is never adopted unless config.adoptFactoryDefault.
 *   - koffi/unload on dispose; state-transition logs are throttled.
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
const ZOOM_GRACE_DEFAULT = 2000;
const STABLE_POLLS = 3;            // consecutive equal reads before adopting
const STATE_LOG_THROTTLE_MS = 10000;

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
  const IsZoomed = user32.func('bool __stdcall IsZoomed(void *hWnd)');
  const IsIconic = user32.func('bool __stdcall IsIconic(void *hWnd)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hWnd, void *rect)');        // rect: 16-byte Buffer, int32 l,t,r,b
  const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, void *pid)'); // pid: 4-byte Buffer
  const MoveWindow = user32.func('bool __stdcall MoveWindow(void *hWnd, int32 x, int32 y, int32 w, int32 h, bool repaint)');
  const MonitorFromWindow = user32.func('void* __stdcall MonitorFromWindow(void *hwnd, uint32 flags)');
  const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(void *hMonitor, void *lpmi)'); // MONITORINFO: 40-byte Buffer

  // Per-monitor DPI awareness v2, best effort. Must run before the first
  // window-coordinate call; fails silently if the process already has a
  // DPI context (that keeps the previous behavior, just less precise).
  try {
    const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
    if (SetProcessDpiAwarenessContext(-4)) {
      log('per-monitor DPI awareness v2 enabled (physical-pixel coordinates)');
    } else {
      log('DPI awareness context unchanged (already set); mixed-DPI displays may restore with a scale offset');
    }
  } catch {
    log('SetProcessDpiAwarenessContext unavailable on this Windows version; keeping default DPI behavior');
  }

  // Test override: config.ownerPid pins the owning process explicitly; in
  // production this is always the Electron main process (our direct parent).
  const ownerPid = Number(config?.ownerPid) > 0 ? Number(config.ownerPid) : process.ppid;
  const adoptFactoryDefault = config?.adoptFactoryDefault === true;
  const pollMs = Number(config?.pollMs) > 0 ? Number(config.pollMs) : POLL_DEFAULT;
  const graceMs = Number(config?.graceMs) >= 0 ? Number(config.graceMs) : GRACE_DEFAULT;
  const zoomGraceMs = Number(config?.zoomGraceMs) >= 0 ? Number(config.zoomGraceMs) : ZOOM_GRACE_DEFAULT;

  const pidBuf = Buffer.alloc(4);
  const rectBuf = Buffer.alloc(16);
  const monBuf = Buffer.alloc(40); // MONITORINFO {cbSize, rcMonitor, rcWork, dwFlags}

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
                  best = { hwnd, l, t, r, b, w, h };
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

  /**
   * Borderless fullscreen heuristic: the window covers its monitor's full
   * rect (taskbar included). Maximized windows cover only the work area, so
   * they don't trip this; F11-style fullscreen does.
   */
  function isFullscreenCover(win) {
    try {
      const mon = MonitorFromWindow(win.hwnd, 2); // MONITOR_DEFAULTTONEAREST
      if (hwndAddr(mon) <= 0n) return false;
      monBuf.writeUInt32LE(40, 0);
      if (!GetMonitorInfoW(mon, monBuf)) return false;
      const ml = monBuf.readInt32LE(4);
      const mt = monBuf.readInt32LE(8);
      const mr = monBuf.readInt32LE(12);
      const mb = monBuf.readInt32LE(16);
      return win.l <= ml && win.t <= mt && win.r >= mr && win.b >= mb;
    } catch {
      return false;
    }
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
  let lock = loadLock();
  if (lock) log(`LOADED lock ${lock.width}x${lock.height}`);
  else log('no saved size yet; the first stable resize becomes the lock');

  let seenWindow = false;   // was a window found in the previous poll?
  let lastApplied = null;   // size we last set (to ignore our own writes)
  let stableSize = null;    // size from the previous poll (debounce anchor)
  let stableCount = 0;      // how many consecutive equal reads so far
  let graceUntil = 0;
  let lastFrozen = null;    // minimize/maximize/fullscreen state of previous poll
  let zoomGraceUntil = 0;   // brief re-assert window right after un-freezing
  let lastPollSize = null;  // previous-poll size for drag detection
  let lastStateLog = 0;     // throttle timestamp for state-transition logs

  function resetTransient() {
    lastApplied = null;
    stableSize = null;
    stableCount = 0;
    lastPollSize = null;
  }

  function throttledStateLog(msg) {
    const now = Date.now();
    if (now - lastStateLog >= STATE_LOG_THROTTLE_MS) {
      lastStateLog = now;
      log(msg);
    }
  }

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
    try { // an unexpected throw here must never take down the host process
      const win = findMainWindow();
      if (!win) {
        seenWindow = false;
        lastFrozen = null;
        resetTransient();
        return;
      }

      // Minimized, maximized, and borderless-fullscreen windows are all
      // "frozen": their size is NEVER recorded, and we don't fight the
      // user/Windows while they hold the window.
      const frozen = IsIconic(win.hwnd) || IsZoomed(win.hwnd) || isFullscreenCover(win);

      // Window (re)appeared: restart the grace period and restore the lock —
      // unless it came up frozen, in which case leave it alone until it is
      // restored (the transition below handles the lock then).
      if (!seenWindow) {
        seenWindow = true;
        graceUntil = Date.now() + graceMs;
        resetTransient();
        lastFrozen = frozen;
        if (lock && !frozen) applyLock(win);
        return;
      }

      // Freeze-state transitions.
      if (frozen !== lastFrozen) {
        lastFrozen = frozen;
        resetTransient();
        if (frozen) {
          throttledStateLog('window minimized/maximized/fullscreen — size recording paused');
        } else if (lock) {
          // Just restored: briefly re-assert the saved (non-fullscreen) size
          // so a double-click restore lands on the locked size, not on
          // whatever DSH re-applies afterwards.
          zoomGraceUntil = Date.now() + zoomGraceMs;
          throttledStateLog('window restored — re-asserting saved size');
        }
        return;
      }

      // Still frozen: ignore every size change.
      if (frozen) return;

      const cur = { width: win.w, height: win.h };
      if (lastApplied && cur.width === lastApplied.width && cur.height === lastApplied.height) {
        lastPollSize = cur;
        return;
      }

      // User is actively dragging (size changed again since the previous
      // poll): never assert while the pointer is moving, and don't count
      // moving sizes toward adoption.
      if (lastPollSize && (lastPollSize.width !== cur.width || lastPollSize.height !== cur.height)) {
        lastPollSize = cur;
        stableSize = null;
        stableCount = 0;
        return;
      }
      lastPollSize = cur;

      // Right after un-freezing: bring the window back to the saved size.
      if (Date.now() < zoomGraceUntil && lock) {
        if (cur.width !== lock.width || cur.height !== lock.height) applyLock(win);
        return;
      }

      // During the grace window DSH is still settling its default layout — keep forcing our lock.
      if (Date.now() < graceUntil && lock) {
        applyLock(win);
        return;
      }

      // Adopt only after STABLE_POLLS consecutive equal reads. Never adopt
      // the DSH factory default (1280x820) unless explicitly allowed: if DSH
      // re-asserts its default layout after our grace period, adopting it
      // would destroy the user's saved lock.
      const isFactoryDefault = cur.width === 1280 && cur.height === 820;
      const adoptable = adoptFactoryDefault || !isFactoryDefault;
      if (adoptable && stableSize && stableSize.width === cur.width && stableSize.height === cur.height) {
        stableCount++;
        if (stableCount >= STABLE_POLLS - 1) { // current read + prior equals
          lock = cur;
          lastApplied = { ...cur };
          stableSize = null;
          stableCount = 0;
          saveLock(lock);
        }
      } else {
        stableSize = cur;
        stableCount = 0;
      }
    } catch (e) {
      warn(`poll error ignored: ${e?.message ?? e}`);
    }
  }, pollMs);

  // Proven cordis disposal pattern (same as @michengai/dsh-cost-meter):
  // the setup callback must RETURN the dispose function.
  ctx.effect(() => () => {
    clearInterval(timer);
    try { koffi.unload(user32); } catch { /* ignore */ }
    log(`watcher stopped after ${pollCount} polls`);
  }, 'window-size-lock: watcher');
}

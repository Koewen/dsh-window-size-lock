/**
 * dsh-window-size-lock
 *
 * Persists & locks the DeepSeek Harness (DSH) main window size AND position
 * across sessions.
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
 *   1. On (re)appearance of the window: restore the saved rect (position +
 *      size), and keep re-asserting it for a short grace period, so DSH's
 *      default layout never wins.
 *   2. While running: when the rect stays stable across several polls, adopt
 *      it as the new lock automatically (this covers both resizes and moves).
 *   3. Minimized / maximized / borderless-fullscreen states are NEVER
 *      recorded. While the window is in any of them all recording pauses;
 *      on restore the saved non-fullscreen rect is re-applied.
 *
 * Fix history
 * -----------
 * v1.4.2 — NEVER ADOPT DSH'S OWN PLACEMENT; a finished drag cancels grace
 *   (#bug: after opening, dragging snapped back to the default size and the
 *   window jumped back to a fixed coordinate)
 *   rc.5 re-asserts its own default layout repeatedly — not only during
 *   boot — and every rect that sat still for STABLE_POLLS was ADOPTED as the
 *   new lock, including DSH's default placement. The lock was thereby
 *   poisoned with the default size / fixed origin, after which the plugin
 *   faithfully restored that poisoned lock and fought the user's drags:
 *     - the rect DSH itself places the window at ("boot rect") is captured
 *       at every (re)appearance and on every unfreeze, and is NEVER adopted;
 *       whenever the window is found sitting exactly there again, the saved
 *       lock is re-applied instead,
 *     - finishing a drag during the grace period now CANCELS the grace (the
 *       user visibly won the race) instead of snapping back to the old lock,
 *     - the post-unfreeze re-assert now covers position, not just size.
 *
 * v1.4.0 — POSITION DRIFT (#bug: window reopened slightly down-right)
 *   The old code restored the saved SIZE only and passed the window's CURRENT
 *   origin (`win.l`, `win.t`) to MoveWindow. Position was therefore never
 *   persisted: every launch the origin came from Windows' default placement
 *   (CW_USEDEFAULT cascades each new top-level window down-right), so the
 *   window crept toward the bottom-right corner on every reopen.
 *   Now x/y are persisted, restored, adopted and validated like the size:
 *     - saved rect is `{x, y, width, height}` (old size-only files are still
 *       read; x/y are filled in on the first stable read — no data loss),
 *     - a saved origin whose rect no longer intersects any monitor (monitor
 *       unplugged / resolution changed) is ignored and the current origin is
 *       kept, so the window can never be restored off-screen,
 *     - moving the window is adopted with the same stability rule as resizes,
 *       and re-asserts are skipped while the rect is still changing (dragging).
 *
 * v1.3.0 audit fixes (still in force):
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
const GRACE_DEFAULT = 12000;
const ZOOM_GRACE_DEFAULT = 2000;
const STABLE_POLLS = 3;            // consecutive equal reads before adopting
const STATE_LOG_THROTTLE_MS = 10000;
const MONITOR_DEFAULTTONULL = 0;   // MonitorFromRect returns NULL if no monitor intersects

function storePath() {
  const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(base, '@deepseek-ai', 'dsh-desktop', 'window-size-lock.json');
}

/** Structural equality for rects (position + size). */
function sameRect(a, b) {
  return !!a && !!b
    && a.x === b.x && a.y === b.y
    && a.width === b.width && a.height === b.height;
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
  const MonitorFromRect = user32.func('void* __stdcall MonitorFromRect(void *rect, uint32 flags)');
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

  // Report the awareness we actually ended up with. Anything below
  // per-monitor-aware means Win32 rects are DPI-virtualized: they still round
  // trip on the same monitor, but a saved rect restored under a different
  // scaling/monitor can land offset. Knowing the level turns that class of
  // drift from a mystery into a one-line log.
  try {
    const GetThreadDpiAwarenessContext = user32.func('void* __stdcall GetThreadDpiAwarenessContext()');
    const GetAwarenessFromDpiAwarenessContext = user32.func('int __stdcall GetAwarenessFromDpiAwarenessContext(void *ctx)');
    const level = GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext());
    const label = ['invalid', 'unaware', 'system-DPI aware', 'per-monitor aware'][level] ?? `unknown(${level})`;
    if (level >= 3) log(`DPI awareness: ${label} — rects are physical pixels`);
    else if (level === 2) log(`DPI awareness: ${label} — rects are logical pixels; stable while the display scaling is unchanged`);
    else log(`DPI awareness: ${label} — rects are DPI-virtualized; a saved rect restored under different scaling may be rescaled`);
  } catch {
    log('DPI awareness level unavailable on this Windows version');
  }

  // Test override: config.ownerPid pins the owning process explicitly; in
  // production this is always the Electron main process (our direct parent).
  const ownerPid = Number(config?.ownerPid) > 0 ? Number(config.ownerPid) : process.ppid;
  const adoptFactoryDefault = config?.adoptFactoryDefault === true;
  // persistPosition: remember and restore the window origin too (default on).
  // Set false to get the v1.3.0 behaviour (size only, position left to DSH).
  const persistPosition = config?.persistPosition !== false;
  const pollMs = Number(config?.pollMs) > 0 ? Number(config.pollMs) : POLL_DEFAULT;
  const graceMs = Number(config?.graceMs) >= 0 ? Number(config.graceMs) : GRACE_DEFAULT;
  const zoomGraceMs = Number(config?.zoomGraceMs) >= 0 ? Number(config.zoomGraceMs) : ZOOM_GRACE_DEFAULT;

  const pidBuf = Buffer.alloc(4);
  const rectBuf = Buffer.alloc(16);
  const probeBuf = Buffer.alloc(16); // scratch rect for monitor-intersection probes
  const monBuf = Buffer.alloc(40); // MONITORINFO {cbSize, rcMonitor, rcWork, dwFlags}

  // NOTE: in koffi, a NULL void* result comes back as an opaque object, NOT
  // JS null — the Z-order walk must terminate via koffi.address() === 0n.
  function hwndAddr(hwnd) {
    try { return koffi.address(hwnd); } catch { return 0n; }
  }

  /**
   * True when the given rect does not intersect ANY monitor — i.e. the saved
   * origin belongs to a monitor that was unplugged, or the display layout
   * changed. Restoring such a rect would park the window off-screen, so the
   * caller keeps the current origin instead.
   */
  function isOffscreen(x, y, width, height) {
    try {
      probeBuf.writeInt32LE(x, 0);
      probeBuf.writeInt32LE(y, 4);
      probeBuf.writeInt32LE(x + width, 8);
      probeBuf.writeInt32LE(y + height, 12);
      const mon = MonitorFromRect(probeBuf, MONITOR_DEFAULTTONULL);
      return hwndAddr(mon) <= 0n;
    } catch {
      return false; // probe failed: don't block the restore on an API hiccup
    }
  }

  /**
   * Sanity check: is the saved rect larger than the monitor it lives on?
   * A saved size that cannot fit (e.g. 1685px tall on a 1440px screen) is a
   * symptom of a display/DPI change, or of coordinates captured in a
   * different DPI-awareness context — worth surfacing instead of silently
   * restoring a window that hangs off every edge.
   */
  function rectExceedsMonitor(win, width, height) {
    try {
      const mon = MonitorFromWindow(win.hwnd, 2); // MONITOR_DEFAULTTONEAREST
      if (hwndAddr(mon) <= 0n) return null;
      monBuf.writeUInt32LE(40, 0);
      if (!GetMonitorInfoW(mon, monBuf)) return null;
      const mw = monBuf.readInt32LE(12) - monBuf.readInt32LE(4);
      const mh = monBuf.readInt32LE(16) - monBuf.readInt32LE(8);
      if (width > mw + 8 || height > mh + 8) return { mw, mh };
      return null;
    } catch {
      return null;
    }
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
        // Backward compatible: v1.3.0 files carry no x/y (null until the first
        // stable read fills them in — the size is still honoured meanwhile).
        return {
          width: o.width,
          height: o.height,
          x: Number.isInteger(o.x) ? o.x : null,
          y: Number.isInteger(o.y) ? o.y : null,
        };
      }
    } catch (e) {
      warn(`corrupt size file ignored: ${e?.message ?? e}`);
    }
    return null;
  }

  function saveLock(l) {
    try {
      const p = storePath();
      mkdirSync(dirname(p), { recursive: true });
      const payload = {
        width: l.width,
        height: l.height,
        x: Number.isInteger(l.x) ? l.x : null,
        y: Number.isInteger(l.y) ? l.y : null,
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(p, JSON.stringify(payload, null, 2));
      log(`SAVED lock ${l.width}x${l.height} at (${payload.x ?? '?'},${payload.y ?? '?'})`);
    } catch (e) {
      warn(`cannot save size: ${e?.message ?? e}`);
    }
  }

  // ---- watch loop ----
  let lock = loadLock();
  if (lock) {
    log(`LOADED lock ${lock.width}x${lock.height}` + (Number.isInteger(lock.x) ? ` at (${lock.x},${lock.y})` : ' (position not saved yet)'));
  } else {
    log('no saved size yet; the first stable resize becomes the lock');
  }

  let seenWindow = false;   // was a window found in the previous poll?
  let lastApplied = null;   // rect we last set (to ignore our own writes)
  let stableRect = null;    // rect from the previous poll (debounce anchor)
  let stableCount = 0;      // how many consecutive equal reads so far
  let graceUntil = 0;
  let lastFrozen = null;    // minimize/maximize/fullscreen state of previous poll
  let zoomGraceUntil = 0;   // brief re-assert window right after un-freezing
  let lastPollRect = null;  // previous-poll rect for drag detection
  let lastStateLog = 0;     // throttle timestamp for state-transition logs
  let bootRect = null;      // the rect DSH itself placed the window at — never adopted, always fought

  function resetTransient() {
    lastApplied = null;
    stableRect = null;
    stableCount = 0;
    lastPollRect = null;
  }

  function throttledStateLog(msg) {
    const now = Date.now();
    if (now - lastStateLog >= STATE_LOG_THROTTLE_MS) {
      lastStateLog = now;
      log(msg);
    }
  }

  /**
   * Restore the saved rect. The origin comes from the lock when it is known
   * and still on-screen; otherwise the window's current origin is kept (first
   * run after an upgrade from a size-only file, or a monitor that is gone).
   */
  function applyLock(win) {
    try {
      let x = win.l;
      let y = win.t;
      const haveOrigin = persistPosition && Number.isInteger(lock.x) && Number.isInteger(lock.y);
      if (haveOrigin && !isOffscreen(lock.x, lock.y, lock.width, lock.height)) {
        x = lock.x;
        y = lock.y;
      } else if (haveOrigin) {
        warn(`saved origin (${lock.x},${lock.y}) is off-screen — keeping the current position`);
      }
      MoveWindow(win.hwnd, x, y, lock.width, lock.height, true);
      lastApplied = { x, y, width: lock.width, height: lock.height };
      log(`applied lock ${lock.width}x${lock.height} at (${x},${y})`);
    } catch (e) {
      warn(`MoveWindow failed: ${e?.message ?? e}`);
    }
  }

  let pollCount = 0;
  let noWindowPolls = 0;
  const timer = setInterval(() => {
    pollCount++;
    if (pollCount % 240 === 1) log(`watcher alive (poll #${pollCount})`);
    try { // an unexpected throw here must never take down the host process
      const win = findMainWindow();
      if (!win) {
        seenWindow = false;
        lastFrozen = null;
        resetTransient();
        // Silent no-op guard: if the owning PID never yields a window the
        // plugin does nothing at all, which is impossible to diagnose from
        // the outside. Speak up (throttled) instead of staying quiet.
        if (++noWindowPolls === 40 || noWindowPolls % 240 === 0) {
          warn(`no visible window found for pid ${ownerPid} after ${noWindowPolls} polls — plugin is inactive (is the window owned by a different process?)`);
        }
        return;
      }
      if (noWindowPolls) {
        noWindowPolls = 0;
      }

      // Minimized, maximized, and borderless-fullscreen windows are all
      // "frozen": their rect is NEVER recorded, and we don't fight the
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
        if (!frozen) {
          // Whatever DSH placed the window at is its own layout choice. From
          // now on, a stable rect equal to this one means "DSH did that",
          // never "the user did that": it must not be adopted and must be
          // fought with the saved lock (see the adoption guard below).
          bootRect = { x: win.l, y: win.t, width: win.w, height: win.h };
          log(`DSH placed its window at ${win.w}x${win.h} @ (${win.l},${win.t}) — this rect is never adopted`);
        }
        if (lock && !frozen) {
          // Diagnostics: a saved rect that cannot fit the monitor means the
          // display layout or DPI changed since it was recorded.
          const tooBig = rectExceedsMonitor(win, lock.width, lock.height);
          if (tooBig) {
            warn(`saved rect ${lock.width}x${lock.height} is larger than the current monitor ${tooBig.mw}x${tooBig.mh} — display/DPI changed since it was saved?`);
          }
          applyLock(win);
        } else if (lock) {
          // Frozen at startup: the lock is deliberately NOT applied yet. Say
          // so, otherwise a "plugin did nothing" report is undebuggable.
          const why = IsIconic(win.hwnd) ? 'minimized'
            : IsZoomed(win.hwnd) ? 'maximized'
              : 'covering a whole monitor (borderless fullscreen)';
          throttledStateLog(`window came up ${why} — restore deferred until it is restored`);
        }
        return;
      }

      // Freeze-state transitions.
      if (frozen !== lastFrozen) {
        lastFrozen = frozen;
        resetTransient();
        if (frozen) {
          throttledStateLog('window minimized/maximized/fullscreen — rect recording paused');
        } else if (lock) {
          // Whatever DSH restored the window to is its own placement choice —
          // same treatment as the boot rect: never adopt it.
          bootRect = { x: win.l, y: win.t, width: win.w, height: win.h };
          // Just restored: briefly re-assert the saved (non-fullscreen) rect
          // so a double-click restore lands on the locked size, not on
          // whatever DSH re-applies afterwards.
          zoomGraceUntil = Date.now() + zoomGraceMs;
          throttledStateLog('window restored — re-asserting saved rect');
        }
        return;
      }

      // Still frozen: ignore every rect change.
      if (frozen) return;

      const cur = {
        x: persistPosition ? win.l : 0,
        y: persistPosition ? win.t : 0,
        width: win.w,
        height: win.h,
      };
      // Ignore our own writes — EXCEPT while the saved origin is still unknown
      // (first run after upgrading from a size-only v1.3.0 file). In that case
      // the rect we ourselves applied is the only source of the position, so
      // it must reach the adoption branch or x/y would never be learned.
      const positionKnown = !persistPosition
        || (Number.isInteger(lock?.x) && Number.isInteger(lock?.y));
      if (lastApplied && sameRect(cur, lastApplied) && positionKnown) {
        lastPollRect = cur;
        return;
      }

      // User is actively dragging/moving (rect changed again since the
      // previous poll): never assert while the pointer is moving, and don't
      // count moving rects toward adoption.
      if (lastPollRect && !sameRect(lastPollRect, cur)) {
        lastPollRect = cur;
        stableRect = null;
        stableCount = 0;
        return;
      }
      lastPollRect = cur;

      // Right after un-freezing: bring the window back to the saved rect
      // (position as well as size).
      if (Date.now() < zoomGraceUntil && lock) {
        const posOff = persistPosition && Number.isInteger(lock.x)
          && (cur.x !== lock.x || cur.y !== lock.y);
        if (cur.width !== lock.width || cur.height !== lock.height || posOff) applyLock(win);
        return;
      }

      // During the grace window DSH is still settling its default layout —
      // keep forcing our lock. Exception: if the window has now settled on a
      // rect that is NOT DSH's own placement, the user just finished a drag
      // and visibly won the race — cancel the grace and let adoption record
      // their rect, instead of snapping back to the old lock.
      if (Date.now() < graceUntil && lock) {
        if (bootRect && !sameRect(cur, bootRect)) {
          graceUntil = 0;
          throttledStateLog('user drag during grace — grace cancelled, rect will be adopted');
        } else {
          applyLock(win);
          return;
        }
      }

      // A stable rect that exactly matches the placement DSH itself chose for
      // this window is DSH's doing (rc.5 re-asserts its default layout long
      // after boot), not the user's: NEVER adopt it — that is what used to
      // poison the lock with the default size / a fixed origin. Instead pull
      // the window back to the saved lock.
      if (bootRect && sameRect(cur, bootRect)) {
        if (lock && !sameRect(lock, bootRect)) {
          applyLock(win);
        } else {
          stableRect = null;
          stableCount = 0;
        }
        return;
      }

      // Adopt only after STABLE_POLLS consecutive equal reads.
      //
      // Position and size are adopted INDEPENDENTLY:
      //   - POSITION is always adopted when the rect is stable, even if the
      //     window happens to sit at the factory-default size — otherwise a
      //     user who never resizes (i.e. runs at DSH's default 1280x820)
      //     could never save a position at all, which is precisely the
      //     "reopens slightly down-right" report.
      //   - SIZE is never adopted when it equals the factory default 1280x820
      //     (unless adoptFactoryDefault), so DSH's late default-layout reset
      //     cannot destroy the user's saved lock.
      const isFactoryDefault = cur.width === 1280 && cur.height === 820;
      if (sameRect(stableRect, cur)) {
        stableCount++;
        if (stableCount >= STABLE_POLLS - 1) { // current read + prior equals
          const next = { ...lock };
          let changed = false;
          if (persistPosition && (cur.x !== next.x || cur.y !== next.y)) {
            next.x = cur.x;
            next.y = cur.y;
            changed = true;
          }
          if ((adoptFactoryDefault || !isFactoryDefault)
              && (cur.width !== next.width || cur.height !== next.height)) {
            next.width = cur.width;
            next.height = cur.height;
            changed = true;
          }
          if (changed) {
            lock = next;
            saveLock(lock);
            throttledStateLog(`adopted rect ${lock.width}x${lock.height} at (${lock.x},${lock.y})`);
          }
          lastApplied = { ...cur };
          stableRect = null;
          stableCount = 0;
        }
      } else {
        stableRect = cur;
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

# dsh-window-size-lock

A DeepSeek Harness (DSH) host plugin that remembers your main-window **size and
position**: restore both on every launch, lock them against the default layout,
and persist them across sessions.

## What it does

1. **Restore on launch** — when the DSH main window appears, the last saved
   rect (x, y, width, height) is applied immediately and re-asserted for a
   short grace period, so neither DSH's default `1280×820` layout nor Windows'
   default window placement wins. This is what stops the window from creeping
   down-right on every reopen.
2. **Adopt on resize** — after you drag the window edge/corner and the new size
   stays stable, it is saved as the new lock automatically.
3. **Maximize-safe** — a maximized (double-click fullscreen) window is never
   recorded. While the window is zoomed all size recording pauses; when you
   restore it, the saved non-fullscreen size is re-applied. The same freeze
   applies to minimized windows (which report the classic offscreen
   `-32000,-32000` rect) and borderless fullscreen (F11-style, detected by a
   monitor-cover heuristic since it is not `WS_MAXIMIZE`).
4. **Persist** — the rect is stored in
   `%APPDATA%\@deepseek-ai\dsh-desktop\window-size-lock.json` as
   `{x, y, width, height}` and survives restarts. Files written by v1.3.0
   (size only) are still read; the position is learned on the first stable
   read after upgrading.

The factory default size (`1280×820`) is never adopted as a lock, so a late
default-layout reset cannot silently overwrite your saved size.

## Install

Via the DSH plugin CLI (replace the exe path with your DSH install location):

```bat
set ELECTRON_RUN_AS_NODE=1
"D:\WorkStation\DeepSeek Harness\DeepSeek Harness.exe" --expose-internals ^
  "D:\WorkStation\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" ^
  plugin --profile desktop add https://github.com/Koewen/dsh-window-size-lock
```

Then restart DeepSeek Harness. (The CLI runs pnpm, which installs the plugin's
`koffi` dependency automatically.)

## Configure

Edit the `config:` block in `cordis.patch.yml`, then reinstall/restart:

| Key       | Default | Meaning                                                        |
|-----------|---------|----------------------------------------------------------------|
| `enabled` | `true`  | Master switch. `false` = DSH default behavior, no lock.        |
| `pollMs`  | `500`   | Watch-loop interval in milliseconds.                           |
| `graceMs` | `3000`  | How long after the window appears the saved rect is re-asserted. Raise it (e.g. `6000`) if DSH re-applies its own layout later than 3s. |
| `adoptFactoryDefault` | `false` | Allow `1280×820` (DSH factory default) to be adopted as a **size** lock. Position is always adopted regardless of this flag. |
| `persistPosition` | `true`  | Remember and restore the window origin too. `false` restores the v1.3.0 behavior (size only). |

## Reset

Delete the stored rect file and restart DSH:

```
del "%APPDATA%\@deepseek-ai\dsh-desktop\window-size-lock.json"
```

## How it works

DSH host plugins run in a plain-Node child process (spawned with
`ELECTRON_RUN_AS_NODE=1`), so the Electron API is unavailable. This plugin
loads the window handle from the OS instead:

- runs in the same interactive desktop session as the main window, and
- is a **direct child** of the Electron main process, so `process.ppid` is
  exactly the PID that owns the main window.

It binds `user32.dll` through [koffi](https://koffi.dev) (bundled as a
dependency), walks the Z-order for the largest visible top-level window owned
by the parent PID, and applies/observes sizes with `MoveWindow` /
`GetWindowRect` on a `pollMs` interval.

## Limitation

Electron enforces a minimum window size (~`520×600`) at the Chromium message
layer. No external caller can shrink the window below that floor — this plugin
locks sizes within the allowed range only.

DPI: the plugin requests per-monitor DPI awareness v2 at startup (best effort)
so coordinates are physical pixels. If the host process already fixed its DPI
context before this call, mixed-DPI multi-monitor setups may restore sizes
with a scale offset.

## Compatibility

Built and tested against DeepSeek Harness **0.2.1-rc.3**. Optional
`peerDependencies` are declared with that exact version so the compatibility
gate passes.

## Tests

`test/wsl-edge-tests.mjs` drives the real plugin against real Win32 windows
created in the test process (`ownerPid: process.pid`), with an isolated
`APPDATA` and a message pump so minimize/maximize states are genuine:

```
node test/wsl-edge-tests.mjs     # 21 checks, exit code 1 on any failure
```

Covered: adoption, move-only, resize-only, minimize (`-32000` rect must never
be recorded), maximize, off-screen saved origin, legacy size-only store,
`persistPosition:false`, drag (no mid-drag adoption), close & reopen,
multi-window (largest wins), corrupt store, dispose, monitor-cover freeze,
factory-default size, and the v1.3.0 → v1.4.0 upgrade path.

## Changelog

### v1.4.0 — remember the position too

Fixes "the window reopens slightly down-right": the old code restored the
saved **size** only and passed the window's *current* origin to `MoveWindow`,
so the position was never persisted and every launch fell back to Windows'
default placement (which cascades down-right).

- save/restore `{x, y, width, height}`; a saved origin that no longer
  intersects any monitor (unplugged display) is ignored instead of dragging
  the window off-screen,
- position and size are adopted **independently**: the factory-default
  `1280×820` guard blocks size adoption only, so a user who never resizes
  can still save a position,
- a size-only v1.3.0 store is upgraded in place — the origin is learned on
  the first stable read (previously `lastApplied` swallowed it forever),
- diagnostics: window-too-large-for-monitor warning, freeze reason at
  startup, "no window found for pid" warning, DPI-awareness level.

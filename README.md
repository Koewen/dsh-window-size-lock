# dsh-window-size-lock

A DeepSeek Harness (DSH) host plugin that remembers your main-window size:
restore it on every launch, lock it against the default layout, and persist it
across sessions.

## What it does

1. **Restore on launch** — when the DSH main window appears, the last saved
   size is applied immediately and re-asserted for a short grace period, so
   DSH's default `1280×820` layout never wins.
2. **Adopt on resize** — after you drag the window edge/corner and the new size
   stays stable, it is saved as the new lock automatically.
3. **Maximize-safe** — a maximized (double-click fullscreen) window is never
   recorded. While the window is zoomed all size recording pauses; when you
   restore it, the saved non-fullscreen size is re-applied. The same freeze
   applies to minimized windows (which report the classic offscreen
   `-32000,-32000` rect) and borderless fullscreen (F11-style, detected by a
   monitor-cover heuristic since it is not `WS_MAXIMIZE`).
4. **Persist** — the size is stored in
   `%APPDATA%\@deepseek-ai\dsh-desktop\window-size-lock.json` and survives
   restarts.

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
| `graceMs` | `3000`  | How long after the window appears the saved size is re-asserted. |
| `adoptFactoryDefault` | `false` | Allow `1280×820` (DSH factory default) to be adopted as a lock. Keep `false` unless you really want that exact size. |

## Reset

Delete the stored size file and restart DSH:

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

/**
 * v1.3.0 audit-fix tests: minimize & borderless-fullscreen must never be
 * recorded, and restore must land on the locked size at the normal position.
 * Persistence isolated via temp APPDATA.
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const koffi = createRequire('C:/Users/Maste/dsh-window-size-lock/package.json')('koffi');
const user32 = koffi.load('user32.dll');
const CreateWindowExW = user32.func('void* __stdcall CreateWindowExW(uint32 exStyle, void *cls, void *title, uint32 style, int32 x, int32 y, int32 w, int32 h, void *parent, void *menu, void *inst, void *param)');
const DestroyWindow = user32.func('bool __stdcall DestroyWindow(void *hWnd)');
const MoveWindow = user32.func('bool __stdcall MoveWindow(void *hWnd, int32 x, int32 y, int32 w, int32 h, bool repaint)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(void *hWnd, int32 cmd)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hWnd, void *rect)');
const IsIconic = user32.func('bool __stdcall IsIconic(void *hWnd)');
const SW_MINIMIZE = 6, SW_RESTORE = 9;
const rectBuf = Buffer.alloc(16);
const readRect = () => { GetWindowRect(hwnd, rectBuf); return { l: rectBuf.readInt32LE(0), t: rectBuf.readInt32LE(4), r: rectBuf.readInt32LE(8), b: rectBuf.readInt32LE(12) }; };

const { apply } = await import('file:///C:/Users/Maste/dsh-window-size-lock/lib/index.js');

const storeFile = join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'window-size-lock.json');
const readStore = () => existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, 'utf8')) : null;
try { rmSync(storeFile); } catch { /* first run */ }

let disposeFn = null;
const logs = [];
const ctx = {
  logger: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')) },
  effect: (setup) => { disposeFn = setup(); },
};

const WS_OVERLAPPEDWINDOW = 0x00CF0000, WS_VISIBLE = 0x10000000, WS_POPUP = 0x80000000;
const cls = Buffer.from('Static\0', 'utf16le');
const title = Buffer.from('wsl-audit-fix-test\0', 'utf16le');
const hwnd = CreateWindowExW(0, cls, title, WS_OVERLAPPEDWINDOW | WS_VISIBLE, 100, 100, 500, 400, null, null, null, null);
if (!hwnd || koffi.address(hwnd) === 0n) { console.log('FAIL: could not create test window'); process.exit(1); }

const config = { ownerPid: process.pid, pollMs: 200, graceMs: 0 };
apply(ctx, config);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failed = false;
const check = (name, cond, detail) => { console.log(`${cond ? 'PASS' : (failed = true, 'FAIL')} | ${name} | ${detail}`); };

// 1. baseline adoption of 500x400
await sleep(1200);
let s = readStore();
check('S1 baseline adopt 500x400', s?.width === 500 && s?.height === 400, JSON.stringify(s));

// 2. MINIMIZE: offscreen 199x34 must NOT be recorded
ShowWindow(hwnd, SW_MINIMIZE);
await sleep(400);
const iconic = IsIconic(hwnd);
await sleep(1800); // several polls while minimized
s = readStore();
check('S2 minimized (IsIconic confirmed)', iconic === true, `IsIconic=${iconic}`);
check('S3 minimized size NOT recorded', s?.width === 500 && s?.height === 400, `store=${JSON.stringify(s)}`);

// 3. RESTORE from minimize: window must land at the locked size, on-screen
ShowWindow(hwnd, SW_RESTORE);
await sleep(2500); // cover 2s post-restore grace
const rr = readRect();
s = readStore();
check('S4 restore lands on 500x400', (rr.r - rr.l) === 500 && (rr.b - rr.t) === 400, JSON.stringify(rr));
check('S5 window back on-screen (not -32000)', rr.l > -1000 && rr.t > -1000, `l=${rr.l} t=${rr.t}`);
check('S6 store still 500x400', s?.width === 500 && s?.height === 400, JSON.stringify(s));

// 4. BORDERLESS FULLSCREEN (F11-style): monitor-cover window, not WS_MAXIMIZE
const fsRect = readRect();
MoveWindow(hwnd, 0, 0, 1920, 1080, true); // cover typical monitor rect
await sleep(200);
MoveWindow(hwnd, 0, 0, 4096, 2160, true); // cover any monitor in CI/desktops
await sleep(2000); // 3+ stable polls at fullscreen size
s = readStore();
const fs = readRect();
check('S7 borderless fullscreen NOT recorded', s?.width === 500 && s?.height === 400,
  `store=${JSON.stringify(s)} windowRect=${fs.r - fs.l}x${fs.b - fs.t} (monitor-cover)`);
// Note: this window may not exactly cover the real monitor rect on all rigs;
// a FAIL here with store=4096x2160 means the heuristic missed — see S7 note.
console.log('S7-NOTE: if S7 failed with the fullscreen size recorded, verify monitor rect coverage on this display.');

disposeFn?.();
DestroyWindow(hwnd);
console.log('--- plugin logs (tail) ---');
for (const l of logs.slice(-8)) console.log('  ', l);
process.exit(failed ? 1 : 0);

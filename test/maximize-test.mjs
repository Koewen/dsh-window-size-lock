/**
 * Maximize-safety test for dsh-window-size-lock v1.2.0.
 * Verifies: maximized size is never recorded, and after un-maximizing the
 * saved (non-fullscreen) size is re-asserted on the window.
 * Persistence is isolated via a temp APPDATA.
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
const IsZoomed = user32.func('bool __stdcall IsZoomed(void *hWnd)');
const SW_MAXIMIZE = 3, SW_RESTORE = 9;
const rectBuf = Buffer.alloc(16);
const readRect = () => { GetWindowRect(hwnd, rectBuf); return { w: rectBuf.readInt32LE(8) - rectBuf.readInt32LE(0), h: rectBuf.readInt32LE(12) - rectBuf.readInt32LE(4) }; };

const { apply } = await import('file:///C:/Users/Maste/dsh-window-size-lock/lib/index.js');

const storeFile = join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'window-size-lock.json');
const readStore = () => {
  if (!existsSync(storeFile)) return null;
  return JSON.parse(readFileSync(storeFile, 'utf8'));
};
try { rmSync(storeFile); } catch { /* first run */ }

let disposeFn = null;
const logs = [];
const ctx = {
  logger: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')) },
  effect: (setup) => { disposeFn = setup(); },
};

const WS_OVERLAPPEDWINDOW = 0x00CF0000, WS_VISIBLE = 0x10000000;
const cls = Buffer.from('Static\0', 'utf16le');
const title = Buffer.from('wsl-maximize-test\0', 'utf16le');
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
check('STEP1 baseline adopt 500x400', s?.width === 500 && s?.height === 400, JSON.stringify(s));

// 2. maximize: size must NOT be recorded
ShowWindow(hwnd, SW_MAXIMIZE);
await sleep(600);
if (!IsZoomed(hwnd)) console.log('WARN: window did not report zoomed; test environment may not support maximize');
await sleep(1600); // give several polls while zoomed
s = readStore();
const maxRect = readRect();
check('STEP2 maximized size NOT recorded', s?.width === 500 && s?.height === 400, `store=${JSON.stringify(s)} maximizedRect=${maxRect.w}x${maxRect.h}`);

// 3. restore: plugin re-asserts the saved non-fullscreen size
ShowWindow(hwnd, SW_RESTORE);
await sleep(2000); // cover the 2s post-restore grace
const restored = readRect();
s = readStore();
check('STEP3 restore lands on locked 500x400', restored.w === 500 && restored.h === 400, `rect=${restored.w}x${restored.h} store=${JSON.stringify(s)}`);
check('STEP4 store still the pre-maximize size', s?.width === 500 && s?.height === 400, JSON.stringify(s));

disposeFn?.();
DestroyWindow(hwnd);
console.log('--- plugin logs ---');
for (const l of logs) console.log('  ', l);
process.exit(failed ? 1 : 0);

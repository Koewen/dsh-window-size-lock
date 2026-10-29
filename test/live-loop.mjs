/**
 * Live-loop test for dsh-window-size-lock.
 * Creates an owned test window, runs the plugin's real apply() against it,
 * and verifies: discovery -> adoption -> persistence -> re-adoption.
 * Persistence is isolated via a temp APPDATA (see spawn env in run command).
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const koffi = createRequire('C:/Users/Maste/dsh-window-size-lock/package.json')('koffi');
const user32 = koffi.load('user32.dll');
const CreateWindowExW = user32.func('void* __stdcall CreateWindowExW(uint32 exStyle, void *cls, void *title, uint32 style, int32 x, int32 y, int32 w, int32 h, void *parent, void *menu, void *inst, void *param)');
const DestroyWindow = user32.func('bool __stdcall DestroyWindow(void *hWnd)');
const MoveWindow = user32.func('bool __stdcall MoveWindow(void *hWnd, int32 x, int32 y, int32 w, int32 h, bool repaint)');

const { apply } = await import('file:///C:/Users/Maste/dsh-window-size-lock/lib/index.js');

const storeFile = join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'window-size-lock.json');
const readStore = () => {
  if (!existsSync(storeFile)) return null;
  return JSON.parse(readFileSync(storeFile, 'utf8'));
};

// mock cordis ctx: effect(setup) -> call setup now, keep returned dispose
let disposeFn = null;
const logs = [];
const ctx = {
  logger: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')) },
  effect: (setup, name) => { disposeFn = setup(); },
};

// visible top-level window owned by THIS process
const WS_OVERLAPPEDWINDOW = 0x00CF0000, WS_VISIBLE = 0x10000000;
const cls = Buffer.from('Static\0', 'utf16le');
const title = Buffer.from('wsl-live-test\0', 'utf16le');
const hwnd = CreateWindowExW(0, cls, title, WS_OVERLAPPEDWINDOW | WS_VISIBLE, 100, 100, 500, 400, null, null, null, null);
if (!hwnd || koffi.address(hwnd) === 0n) { console.log('FAIL: could not create test window'); process.exit(1); }

const config = { ownerPid: process.pid, pollMs: 200, graceMs: 0 };
apply(ctx, config);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 1. adoption of initial 500x400
await sleep(1200);
let s = readStore();
console.log('STEP1 store after initial adopt:', JSON.stringify(s));
console.log('STEP1', s && s.width === 500 && s.height === 400 ? 'PASS' : 'FAIL');

// 2. resize window -> re-adoption of 640x480
MoveWindow(hwnd, 120, 120, 640, 480, true);
await sleep(1200);
s = readStore();
console.log('STEP2 store after resize adopt:', JSON.stringify(s));
console.log('STEP2', s && s.width === 640 && s.height === 480 ? 'PASS' : 'FAIL');

// 3. factory-default size must NOT be adopted
MoveWindow(hwnd, 130, 130, 1280, 820, true);
await sleep(1200);
s = readStore();
console.log('STEP3 store after default-size move (must stay 640x480):', JSON.stringify(s));
console.log('STEP3', s && s.width === 640 && s.height === 480 ? 'PASS' : 'FAIL');

// 4. dispose stops the watcher
disposeFn?.();
const logsBefore = logs.length;
await sleep(800);
console.log('STEP4 no new logs after dispose:', logs.length === logsBefore ? 'PASS' : 'FAIL');

DestroyWindow(hwnd);
console.log('--- plugin logs ---');
for (const l of logs) console.log('  ', l);

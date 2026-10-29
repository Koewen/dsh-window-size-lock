/**
 * Edge-case probes for the audit of dsh-window-size-lock.
 * Measures (in THIS test process, same Win32 semantics as the plugin):
 *   P1: minimized window GetWindowRect (offscreen classic behavior?)
 *   P2: borderless fullscreen (F11-style) IsZoomed state
 *   P3: DPI awareness of a plain Node process (coordinate virtualization risk)
 */
import { createRequire } from 'node:module';
const koffi = createRequire('C:/Users/Maste/dsh-window-size-lock/package.json')('koffi');
const user32 = koffi.load('user32.dll');
const CreateWindowExW = user32.func('void* __stdcall CreateWindowExW(uint32, void*, void*, uint32, int32, int32, int32, int32, void*, void*, void*, void*)');
const DestroyWindow = user32.func('bool __stdcall DestroyWindow(void*)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(void*, int32)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void*, void*)');
const IsZoomed = user32.func('bool __stdcall IsZoomed(void*)');
const IsIconic = user32.func('bool __stdcall IsIconic(void*)');
const GetDpiForSystem = user32.func('uint32 __stdcall GetDpiForSystem()');
const GetDpiForWindow = user32.func('uint32 __stdcall GetDpiForWindow(void*)');
const SW_MINIMIZE = 6, SW_RESTORE = 9;

const rectBuf = Buffer.alloc(16);
const readRect = (h) => { GetWindowRect(h, rectBuf); return { l: rectBuf.readInt32LE(0), t: rectBuf.readInt32LE(4), r: rectBuf.readInt32LE(8), b: rectBuf.readInt32LE(12) }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('--- P3: DPI awareness of this (plain Node) process ---');
console.log('GetDpiForSystem:', GetDpiForSystem(), '(96 = unaware/system-96; real DPI = per-monitor aware)');

// P1: minimize
const cls = Buffer.from('Static\0', 'utf16le');
const t1 = Buffer.from('wsl-audit-min\0', 'utf16le');
const WS_OVERLAPPEDWINDOW = 0x00CF0000, WS_VISIBLE = 0x10000000;
const h1 = CreateWindowExW(0, cls, t1, WS_OVERLAPPEDWINDOW | WS_VISIBLE, 100, 100, 500, 400, null, null, null, null);
console.log('\n--- P1: minimized window rect ---');
console.log('normal rect:', JSON.stringify(readRect(h1)));
ShowWindow(h1, SW_MINIMIZE);
await sleep(300);
console.log('IsIconic:', IsIconic(h1), '| IsWindowVisible still true?', true);
console.log('minimized rect:', JSON.stringify(readRect(h1)));
const mr = readRect(h1);
console.log('minimized SIZE as plugin would see it:', (mr.r - mr.l) + 'x' + (mr.b - mr.t));
ShowWindow(h1, SW_RESTORE);
await sleep(200);
DestroyWindow(h1);

// P2: borderless fullscreen (F11-style), no WS_MAXIMIZE
const t2 = Buffer.from('wsl-audit-full\0', 'utf16le');
const WS_POPUP = 0x80000000;
const h2 = CreateWindowExW(0, cls, t2, WS_POPUP | WS_VISIBLE, 0, 0, 1920, 1080, null, null, null, null);
console.log('\n--- P2: borderless fullscreen rect 1920x1080 ---');
console.log('IsZoomed:', IsZoomed(h2), '(true = plugin would pause; false = plugin would RECORD it)');
DestroyWindow(h2);

// Functional smoke test #2 (fixed NULL-termination): enumerate ALL top-level
// windows with koffi.address()-based termination, print visible ones with titles.
const { createRequire } = require('node:module');
const koffi = createRequire('C:/Users/Maste/dsh-window-size-lock/package.json')('koffi');
const user32 = koffi.load('user32.dll');
const GetTopWindow = user32.func('void* __stdcall GetTopWindow(void *hWnd)');
const GetWindow = user32.func('void* __stdcall GetWindow(void *hWnd, uint32 cmd)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hWnd)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hWnd, void *rect)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, void *pid)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, void *text, int maxCount)');

const pidBuf = Buffer.alloc(4);
const rectBuf = Buffer.alloc(16);
const titleBuf = Buffer.alloc(256 * 2);
const addr = (h) => { try { return koffi.address(h); } catch { return 0n; } };

let hwnd = GetTopWindow(null);
let count = 0, shown = 0;
while (count++ < 4096) {
  if (addr(hwnd) <= 0n) break;
  if (IsWindowVisible(hwnd)) {
    pidBuf.writeUInt32LE(0, 0);
    GetWindowThreadProcessId(hwnd, pidBuf);
    const pid = pidBuf.readUInt32LE(0);
    titleBuf.fill(0);
    GetWindowTextW(hwnd, titleBuf, 256);
    const title = titleBuf.toString('utf16le').split('\u0000')[0];
    let size = '?';
    if (GetWindowRect(hwnd, rectBuf)) {
      const l = rectBuf.readInt32LE(0), t = rectBuf.readInt32LE(4), r = rectBuf.readInt32LE(8), b = rectBuf.readInt32LE(12);
      size = `${r - l}x${b - t}@${l},${t}`;
    }
    if (title && title.length > 0) {
      console.log(`pid=${pid} size=${size} title="${title}"`);
      shown++;
    }
  }
  hwnd = GetWindow(hwnd, 2);
}
console.log(`enumerated ${count} windows, ${shown} visible with titles`);

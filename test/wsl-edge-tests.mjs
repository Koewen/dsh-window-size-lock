/**
 * Edge-case suite for dsh-window-size-lock v1.4.0.
 *
 * Real Win32 windows are created in THIS process (ownerPid = process.pid),
 * the plugin's real apply() runs against them, and persistence is isolated
 * with a temp APPDATA. A message pump is installed so ShowWindow(min/max)
 * actually changes IsIconic/IsZoomed state.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PLUGIN = 'C:/Users/Maste/.dsh/profiles/desktop/node_modules/dsh-window-size-lock/lib/index.js';
const APPDATA = join(tmpdir(), 'wsl-test-appdata-' + Date.now());
mkdirSync(join(APPDATA, '@deepseek-ai', 'dsh-desktop'), { recursive: true });
process.env.APPDATA = APPDATA;
const STORE = join(APPDATA, '@deepseek-ai', 'dsh-desktop', 'window-size-lock.json');

const koffi = createRequire('C:/Users/Maste/.dsh/profiles/desktop/node_modules/dsh-window-size-lock/package.json')('koffi');
const user32 = koffi.load('user32.dll');
const CreateWindowExW = user32.func('void* __stdcall CreateWindowExW(uint32 exStyle, void *cls, void *title, uint32 style, int32 x, int32 y, int32 w, int32 h, void *parent, void *menu, void *inst, void *param)');
const DestroyWindow = user32.func('bool __stdcall DestroyWindow(void *hWnd)');
const MoveWindow = user32.func('bool __stdcall MoveWindow(void *hWnd, int32 x, int32 y, int32 w, int32 h, bool repaint)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(void *hWnd, int32 cmd)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hWnd, void *rect)');
const IsZoomed = user32.func('bool __stdcall IsZoomed(void *hWnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(void *hWnd)');
const PeekMessageW = user32.func('bool __stdcall PeekMessageW(void *msg, void *hwnd, uint32 min, uint32 max, uint32 remove)');
const TranslateMessage = user32.func('bool __stdcall TranslateMessage(void *msg)');
const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(void *msg)');

const WS_OVERLAPPEDWINDOW = 0x00CF0000, WS_VISIBLE = 0x10000000;
const SW_MINIMIZE = 6, SW_MAXIMIZE = 3, SW_RESTORE = 9;
const rb = Buffer.alloc(16);
const msgBuf = Buffer.alloc(48); // MSG (x64)

// --- message pump so ShowWindow state transitions are actually processed ---
const pump = setInterval(() => {
  while (PeekMessageW(msgBuf, null, 0, 0, 1)) {
    TranslateMessage(msgBuf);
    DispatchMessageW(msgBuf);
  }
}, 25);

const rectOf = (h) => {
  if (!GetWindowRect(h, rb)) return null;
  return { x: rb.readInt32LE(0), y: rb.readInt32LE(4), w: rb.readInt32LE(8) - rb.readInt32LE(0), h: rb.readInt32LE(12) - rb.readInt32LE(4) };
};
const addr = (h) => { try { return koffi.address(h); } catch { return 0n; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const readStore = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : null);
const writeStore = (o) => writeFileSync(STORE, JSON.stringify(o, null, 2));

function makeWindow(x, y, w, h, title = 'wsl-edge') {
  const cls = Buffer.from('Static\0', 'utf16le');
  const t = Buffer.from(title + '\0', 'utf16le');
  const hwnd = CreateWindowExW(0, cls, t, WS_OVERLAPPEDWINDOW | WS_VISIBLE, x, y, w, h, null, null, null, null);
  if (!hwnd || addr(hwnd) === 0n) throw new Error('CreateWindowExW failed');
  return hwnd;
}

/** Start a fresh plugin instance with an isolated ctx (loads the store at start). */
async function startPlugin(config) {
  const mod = await import('file:///' + PLUGIN + '?t=' + Date.now());
  const logs = [];
  let dispose = null;
  const ctx = {
    logger: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')) },
    effect: (setup) => { if (typeof setup === 'function') dispose = setup(); },
  };
  mod.apply(ctx, { pollMs: 150, graceMs: 0, ...config });
  return { logs, dispose: () => { try { dispose?.(); } catch { /* ignore */ } }, };
}

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
};

// ============ T1: baseline adoption of position + size ============
// v1.4.2: the rect the window is BORN at is treated as DSH's own placement
// and is never adopted; the first lock forms from a real user move/resize.
try { rmSync(STORE); } catch { /* none */ }
let win = makeWindow(100, 100, 500, 400, 'wsl-t1');
let p = await startPlugin({ ownerPid: process.pid });
await sleep(600);
MoveWindow(win, 120, 140, 640, 480, true);
await sleep(1400);
let s = readStore();
check('T1 首次采用 位置+尺寸（拖动后）', s?.x === 120 && s?.y === 140 && s?.width === 640 && s?.height === 480, JSON.stringify(s));
p.dispose(); DestroyWindow(win);

// ============ T2: move only (the reported bug scenario) ============
writeStore({ x: 100, y: 100, width: 500, height: 400, updatedAt: new Date().toISOString() });
win = makeWindow(100, 100, 500, 400, 'wsl-t2');
p = await startPlugin({ ownerPid: process.pid });
await sleep(600);
MoveWindow(win, 900, 350, 500, 400, true);   // pure move, size unchanged
await sleep(1400);
s = readStore();
check('T2 只移动窗口 → 位置被采用', s?.x === 900 && s?.y === 350 && s?.width === 500 && s?.height === 400, JSON.stringify(s));
p.dispose(); DestroyWindow(win);

// ============ T3: resize only ============
writeStore({ x: 900, y: 350, width: 500, height: 400, updatedAt: new Date().toISOString() });
win = makeWindow(900, 350, 500, 400, 'wsl-t3');
p = await startPlugin({ ownerPid: process.pid });
await sleep(600);
MoveWindow(win, 900, 350, 720, 520, true);
await sleep(1400);
s = readStore();
check('T3 只改尺寸 → 尺寸被采用且位置保持', s?.width === 720 && s?.height === 520 && s?.x === 900 && s?.y === 350, JSON.stringify(s));
p.dispose(); DestroyWindow(win);

// ============ T4: factory-default size + moved window ============
// 1280x820 is DSH's factory default: size adoption is blocked by design.
// Question under test: does the block also kill POSITION adoption?
writeStore({ x: 200, y: 200, width: 900, height: 700, updatedAt: new Date().toISOString() });
win = makeWindow(200, 200, 1280, 820, 'wsl-t4');
p = await startPlugin({ ownerPid: process.pid });
await sleep(600);
MoveWindow(win, 640, 410, 1280, 820, true);  // moved while at factory-default size
await sleep(1600);
s = readStore();
check('T4 默认尺寸下移动窗口 → 位置仍被采用', s?.x === 640 && s?.y === 410, `store=${JSON.stringify(s)} (size 应仍为 900x700)`);
p.dispose(); DestroyWindow(win);

// ============ T5: minimize then restore ============
writeStore({ x: 300, y: 300, width: 600, height: 450, updatedAt: new Date().toISOString() });
win = makeWindow(300, 300, 600, 450, 'wsl-t5');
p = await startPlugin({ ownerPid: process.pid });
await sleep(700);
ShowWindow(win, SW_MINIMIZE);
await sleep(700);
const iconic = IsIconic(win);
s = readStore();
check('T5a 最小化期间不记录 -32000 离屏坐标', !iconic || (s?.x === 300 && s?.y === 300), `IsIconic=${iconic} store=${JSON.stringify(s)}`);
ShowWindow(win, SW_RESTORE);
await sleep(1200);
const r5 = rectOf(win);
check('T5b 恢复后重新套用已存矩形', !!r5 && Math.abs(r5.x - 300) <= 2 && Math.abs(r5.y - 300) <= 2 && Math.abs(r5.w - 600) <= 2 && Math.abs(r5.h - 450) <= 2, JSON.stringify(r5));
p.dispose(); DestroyWindow(win);

// ============ T6: maximize then restore ============
writeStore({ x: 400, y: 250, width: 640, height: 480, updatedAt: new Date().toISOString() });
win = makeWindow(400, 250, 640, 480, 'wsl-t6');
p = await startPlugin({ ownerPid: process.pid });
await sleep(700);
ShowWindow(win, SW_MAXIMIZE);
await sleep(900);
const zoomed = IsZoomed(win);
s = readStore();
check('T6a 最大化尺寸不被记录', !zoomed || (s?.width === 640 && s?.height === 480), `IsZoomed=${zoomed} store=${JSON.stringify(s)}`);
ShowWindow(win, SW_RESTORE);
await sleep(1300);
const r6 = rectOf(win);
check('T6b 取消最大化后恢复锁定矩形', !!r6 && Math.abs(r6.x - 400) <= 2 && Math.abs(r6.y - 250) <= 2 && Math.abs(r6.w - 640) <= 2 && Math.abs(r6.h - 480) <= 2, JSON.stringify(r6));
p.dispose(); DestroyWindow(win);

// ============ T7: saved origin is off-screen (monitor unplugged) ============
writeStore({ x: -40000, y: -40000, width: 600, height: 450, updatedAt: new Date().toISOString() });
win = makeWindow(500, 400, 600, 450, 'wsl-t7');
p = await startPlugin({ ownerPid: process.pid });
await sleep(900);
const r7 = rectOf(win);
check('T7 保存原点离屏 → 保留当前位置不外拽', !!r7 && r7.x === 500 && r7.y === 400, `rect=${JSON.stringify(r7)} warn=${p.logs.filter(l => l.startsWith('WARN') && l.includes('off-screen')).length}`);
p.dispose(); DestroyWindow(win);

// ============ T8: legacy v1.3.0 store (size only) ============
// v1.4.2: x/y are learned from the first USER move, never from the rect DSH
// placed the window at (that would freeze DSH's default origin as the lock).
writeStore({ width: 800, height: 600, updatedAt: '2026-10-29T00:00:00.000Z' });
win = makeWindow(250, 180, 800, 600, 'wsl-t8');
p = await startPlugin({ ownerPid: process.pid });
await sleep(700);
MoveWindow(win, 260, 190, 800, 600, true);   // user moves; size unchanged
await sleep(1400);
s = readStore();
check('T8 旧版 size-only 文件 → 用户拖动后补齐 x/y', s?.x === 260 && s?.y === 190 && s?.width === 800 && s?.height === 600, JSON.stringify(s));
p.dispose(); DestroyWindow(win);

// ============ T9: persistPosition:false ============
writeStore({ x: 111, y: 222, width: 700, height: 500, updatedAt: new Date().toISOString() });
win = makeWindow(600, 300, 700, 500, 'wsl-t9');
p = await startPlugin({ ownerPid: process.pid, persistPosition: false });
await sleep(900);
const r9 = rectOf(win);
check('T9 persistPosition=false → 不恢复原点', !!r9 && r9.x === 600 && r9.y === 300, JSON.stringify(r9));
p.dispose(); DestroyWindow(win);

// ============ T10: dragging must not be adopted mid-drag ============
writeStore({ x: 100, y: 100, width: 500, height: 400, updatedAt: new Date().toISOString() });
win = makeWindow(100, 100, 500, 400, 'wsl-t10');
p = await startPlugin({ ownerPid: process.pid });
await sleep(600);
for (let i = 1; i <= 6; i++) { MoveWindow(win, 100 + i * 40, 100 + i * 20, 500, 400, true); await sleep(120); }
s = readStore();
check('T10a 拖拽过程中不采纳中间态', s?.x === 100 && s?.y === 100, JSON.stringify(s));
await sleep(1400);
s = readStore();
check('T10b 松手静止后采纳终点位置', s?.x === 340 && s?.y === 220, JSON.stringify(s));
p.dispose(); DestroyWindow(win);

// ============ T11: close & reopen (the user's actual scenario) ============
writeStore({ x: 820, y: 260, width: 1000, height: 760, updatedAt: new Date().toISOString() });
win = makeWindow(820, 260, 1000, 760, 'wsl-t11');
p = await startPlugin({ ownerPid: process.pid });
await sleep(700);
DestroyWindow(win);                       // "close"
await sleep(500);
win = makeWindow(120, 90, 700, 520, 'wsl-t11-reopen'); // "reopen" somewhere else
await sleep(900);
const r11 = rectOf(win);
check('T11 关闭再打开 → 回到保存的位置+尺寸', !!r11 && Math.abs(r11.x - 820) <= 2 && Math.abs(r11.y - 260) <= 2 && Math.abs(r11.w - 1000) <= 2 && Math.abs(r11.h - 760) <= 2, JSON.stringify(r11));
p.dispose(); DestroyWindow(win);

// ============ T12: two owned windows → largest wins ============
writeStore({ x: 50, y: 50, width: 900, height: 700, updatedAt: new Date().toISOString() });
const small = makeWindow(1400, 800, 300, 200, 'wsl-t12-small');
const big = makeWindow(60, 60, 900, 700, 'wsl-t12-big');
p = await startPlugin({ ownerPid: process.pid });
await sleep(1500);
const rBig = rectOf(big), rSmall = rectOf(small);
check('T12 多窗口时锁定最大的那个', !!rBig && Math.abs(rBig.x - 50) <= 2 && Math.abs(rBig.y - 50) <= 2 && rSmall?.x === 1400, `big=${JSON.stringify(rBig)} small=${JSON.stringify(rSmall)}`);
p.dispose(); DestroyWindow(small); DestroyWindow(big);

// ============ T13: corrupt store file ============
writeFileSync(STORE, '{ this is not json ');
win = makeWindow(300, 300, 600, 400, 'wsl-t13');
p = await startPlugin({ ownerPid: process.pid });
await sleep(1400);
// v1.4.2: the rect DSH placed the window at is NEVER adopted as the lock
// (that poisoned the lock with the default size / fixed origin), so the
// lock only re-forms once the window is actually moved — user intent.
MoveWindow(win, 350, 320, 640, 440, true);
await sleep(1400);
s = readStore();
check('T13 损坏的存储文件被忽略；拖动后重建锁', !!s && s.width === 640 && s.height === 440 && s.x === 350, JSON.stringify(s));
p.dispose(); DestroyWindow(win);

// ============ T14: dispose stops everything ============
writeStore({ x: 500, y: 500, width: 600, height: 400, updatedAt: new Date().toISOString() });
win = makeWindow(500, 500, 600, 400, 'wsl-t14');
p = await startPlugin({ ownerPid: process.pid });
await sleep(500);
p.dispose();
const before = JSON.stringify(readStore());
MoveWindow(win, 1000, 700, 800, 600, true);
await sleep(1200);
const after = JSON.stringify(readStore());
check('T14 dispose 后不再写入/干预', before === after, `before=${before} after=${after}`);
DestroyWindow(win);

// ============ T15: window covering the whole monitor (fullscreen heuristic) ============
writeStore({ x: 100, y: 100, width: 500, height: 400, updatedAt: new Date().toISOString() });
win = makeWindow(0, 0, 2560, 1440, 'wsl-t15');   // covers the entire monitor rect
p = await startPlugin({ ownerPid: process.pid });
await sleep(1500);
s = readStore();
check('T15 全屏遮挡窗口被冻结（不记录）', s?.width === 500 && s?.height === 400, `store=${JSON.stringify(s)} (应仍是 500x400)`);
p.dispose(); DestroyWindow(win);

// ============ T16: factory-default SAVED size, close & reopen ============
writeStore({ x: 640, y: 410, width: 1280, height: 820, updatedAt: new Date().toISOString() });
win = makeWindow(200, 150, 1280, 820, 'wsl-t16');
p = await startPlugin({ ownerPid: process.pid });
await sleep(700);
DestroyWindow(win);
await sleep(400);
win = makeWindow(300, 200, 1280, 820, 'wsl-t16-reopen');
await sleep(900);
const r16 = rectOf(win);
check('T16 保存的正是默认尺寸 → 重启仍回原位', !!r16 && Math.abs(r16.x - 640) <= 2 && Math.abs(r16.y - 410) <= 2, JSON.stringify(r16));
p.dispose(); DestroyWindow(win);

// ============ T17: v1.3.0 legacy file, two consecutive launches ============
writeStore({ width: 800, height: 600, updatedAt: '2026-10-29T00:00:00.000Z' }); // size-only
win = makeWindow(250, 180, 800, 600, 'wsl-t17');
p = await startPlugin({ ownerPid: process.pid });
await sleep(600);
MoveWindow(win, 400, 300, 800, 600, true);   // user move teaches x/y
await sleep(1400);
s = readStore();
const gotXY = Number.isInteger(s?.x) && Number.isInteger(s?.y);
check('T17a 旧存档首启 → 用户拖动后学到并写入 x/y', gotXY && s?.x === 400 && s?.y === 300, JSON.stringify(s));
DestroyWindow(win);
await sleep(400);
win = makeWindow(700, 500, 800, 600, 'wsl-t17-reopen');
await sleep(900);
const r17 = rectOf(win);
check('T17b 旧存档二次启动 → 位置被恢复', gotXY && !!r17 && Math.abs(r17.x - s.x) <= 2 && Math.abs(r17.y - s.y) <= 2, JSON.stringify(r17));
p.dispose(); DestroyWindow(win);

// ============ T18: DSH re-asserts its default layout AFTER boot ============
// (the v1.4.2 poison bug: rc.5 yanks the window back to its default rect
// long after boot; the old code ADOPTED it and the lock was destroyed)
writeStore({ x: 400, y: 300, width: 900, height: 700, updatedAt: new Date().toISOString() });
win = makeWindow(60, 60, 1280, 829, 'wsl-t18');     // DSH default placement
p = await startPlugin({ ownerPid: process.pid });
await sleep(800);
let r18 = rectOf(win);
check('T18a 启动即恢复锁', !!r18 && Math.abs(r18.x - 400) <= 2 && Math.abs(r18.y - 300) <= 2 && Math.abs(r18.w - 900) <= 2, JSON.stringify(r18));
MoveWindow(win, 60, 60, 1280, 829, true);            // rc.5's late default-layout reset
await sleep(2000);
r18 = rectOf(win);
s = readStore();
check('T18b 迟到重置被夺回且锁不被污染', !!r18 && Math.abs(r18.x - 400) <= 2 && Math.abs(r18.y - 300) <= 2 && s?.width === 900 && s?.height === 700 && s?.x === 400, `rect=${JSON.stringify(r18)} store=${JSON.stringify(s)}`);
p.dispose(); DestroyWindow(win);

// ============ T19: finishing a drag during grace cancels the grace ============
// (the v1.4.2 "drag snaps back" bug: the old code re-applied the old lock
// the moment the user's drag ended inside the grace window)
writeStore({ x: 200, y: 200, width: 800, height: 600, updatedAt: new Date().toISOString() });
win = makeWindow(50, 50, 600, 400, 'wsl-t19');       // DSH default placement
p = await startPlugin({ ownerPid: process.pid, graceMs: 4000 });
await sleep(500);                                     // plugin applies the lock
MoveWindow(win, 500, 450, 900, 700, true);            // user drags during grace
await sleep(1600);
s = readStore();
const r19 = rectOf(win);
check('T19 宽限期内拖拽获胜 → 取消宽限期并采纳', s?.width === 900 && s?.height === 700 && s?.x === 500 && s?.y === 450 && !!r19 && Math.abs(r19.x - 500) <= 2, `store=${JSON.stringify(s)} rect=${JSON.stringify(r19)}`);
p.dispose(); DestroyWindow(win);

// ============ summary ============
clearInterval(pump);
const failed = results.filter(r => !r.ok);
console.log('\n================ 汇总 ================');
console.log(`通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) failed.forEach(f => console.log('  ✗ ' + f.name + ' | ' + f.detail));
try { rmSync(APPDATA, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed.length ? 1 : 0);

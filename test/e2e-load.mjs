// End-to-end load test: import the plugin THROUGH the profile symlink (the
// exact path the DSH host will use) and run apply() with a fake cordis ctx.
const mod = await import('file:///C:/Users/Maste/.dsh/profiles/desktop/node_modules/dsh-window-size-lock/lib/index.js');
console.log('module loaded; exports:', Object.keys(mod).join(', '));

const disposers = [];
const ctx = {
  logger: {
    info: (...a) => console.log('[log]', ...a),
    warn: (...a) => console.log('[warn]', ...a),
  },
  effect: (fn, name) => disposers.push({ fn, name }),
};
mod.apply(ctx, { enabled: true, pollMs: 400, graceMs: 1000 });

// let the watch loop tick a few times (no DSH running => no window found),
// then dispose and exit cleanly.
setTimeout(() => {
  for (const d of disposers) { try { d.fn(); } catch {} }
  console.log('dispose hooks run:', disposers.length, '| clean exit');
  process.exit(0);
}, 1500);

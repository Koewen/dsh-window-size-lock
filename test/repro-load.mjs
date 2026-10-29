import { loadProfileDirectory } from 'file:///C:/Users/Maste/AppData/Local/Temp/dsh-asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';

const profileDir = 'C:/Users/Maste/.dsh/profiles/desktop';
const installAnchor = 'D:/WorkStation/DeepSeek Harness/resources/app.asar/package.json';

const result = loadProfileDirectory('TEST', profileDir, installAnchor, {});
console.log('=== layers (successfully loaded bundles) ===');
for (const l of result.layers) {
  console.log(`- ${l.packageName}  patches=${l.patchPaths.length}`);
}
console.log('\n=== skippedBundles ===');
if (result.skippedBundles.length === 0) console.log('(none)');
for (const s of result.skippedBundles) {
  console.log(`- ${s.packageName}\n    reason: ${s.reason}`);
}

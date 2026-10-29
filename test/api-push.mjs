/**
 * Push the plugin repo to GitHub via the Git Data API (github.com is
 * unreachable from this network; api.github.com works).
 * Creates: blobs -> tree -> commit -> refs/heads/main
 */
import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const TOKEN = process.argv[2];
if (!TOKEN) { console.error('usage: node api-push.mjs <token>'); process.exit(1); }
const REPO = 'Koewen/dsh-window-size-lock';
const ROOT = 'C:/Users/Maste/dsh-window-size-lock';
const BRANCH = 'main';
const MESSAGE = 'dsh-window-size-lock v1.1.1: persist and lock the DSH main window size';

const FILES = [
  '.gitignore', 'README.md', 'cordis.patch.yml', 'lib/index.js',
  'package.json', 'package-lock.json',
  'test/e2e-load.mjs', 'test/live-loop.mjs', 'test/repro-load.mjs',
  'test/smoke-koffi.cjs', 'test/fake-profile/cordis.yml', 'test/fake-profile/package.json',
];

const api = async (path, body, method = 'GET') => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'wsl-push',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
};

// 1. blobs
const tree = [];
for (const f of FILES) {
  const content = readFileSync(join(ROOT, f));
  const blob = await api(`/repos/${REPO}/git/blobs`, { content: content.toString('base64'), encoding: 'base64' }, 'POST');
  tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
  console.log('blob ok:', f, blob.sha.slice(0, 8));
}

// 2. tree
const treeRes = await api(`/repos/${REPO}/git/trees`, { tree }, 'POST');
console.log('tree ok:', treeRes.sha.slice(0, 8));

// 3. commit
const commit = await api(`/repos/${REPO}/git/commits`, {
  message: MESSAGE,
  tree: treeRes.sha,
  author: { name: 'Koewen', email: 'Koewen@users.noreply.github.com', date: new Date().toISOString() },
}, 'POST');
console.log('commit ok:', commit.sha.slice(0, 8));

// 4. ref
try {
  await api(`/repos/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha }, 'POST');
  console.log('ref refs/heads/main created');
} catch (e) {
  if (String(e).includes('422')) {
    await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true }, 'PATCH');
    console.log('ref refs/heads/main updated');
  } else throw e;
}

// verify
const head = await api(`/repos/${REPO}/commits/${BRANCH}`);
console.log('VERIFIED head on GitHub:', head.sha.slice(0, 8), '| files:', head.commit.tree.sha === treeRes.sha ? 'tree matches' : 'TREE MISMATCH');

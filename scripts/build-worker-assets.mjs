import { readFile, realpath, stat, mkdir, copyFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIC } from '../application.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, '.worker-assets');
await mkdir(out, { recursive: true });
const names = new Set([...STATIC.values()].map(asset => asset[0]));
for (const name of await readdir(out)) if (!names.has(name)) throw new Error(`Unexpected file in public build: ${name}`);
// Explicit allowlist only. Never copy the repository, data, secrets or server source.
for (const name of new Set([...STATIC.values()].map(asset => asset[0]))) {
  const source = resolve(root, name);
  if (await realpath(source) !== source || !(await stat(source)).isFile()) throw new Error(`Unsafe asset: ${name}`);
  if ((await readFile(source)).byteLength > 2 * 1024 * 1024) throw new Error(`Asset too large: ${name}`);
  await copyFile(source, resolve(out, name));
}
console.log(`Prepared ${new Set([...STATIC.values()].map(asset => asset[0])).size} public files; backend and secrets excluded.`);

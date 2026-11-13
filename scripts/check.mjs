import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
async function walk(directory) {
  const files = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.data', '.local', '.cache', 'test-results'].includes(item.name)) continue;
    const file = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...await walk(file)); else files.push(file);
  }
  return files;
}
const files = await walk(root); let checked = 0;
for (const file of files) {
  if (file.endsWith('.mjs')) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(1); checked++;
  }
  if (file.endsWith('.json')) JSON.parse(await fs.readFile(file, 'utf8'));
  if (file.endsWith('.mjs') && !file.includes(`${path.sep}tests${path.sep}`)) {
    const source = await fs.readFile(file, 'utf8');
    if (/from\s+['"](?:[^'"]*cursorblinking|[^'"]*codeup\/)/.test(source)) throw new Error(`Source repository dependency in ${file}`);
  }
}
console.log(`Checked syntax for ${checked} modules; JSON and extraction boundaries are valid.`);

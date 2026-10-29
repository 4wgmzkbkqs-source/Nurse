// Builds the static site for Vercel into dist/: the page plus the shared
// scheduling modules it imports from /shared/.
import { cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(ROOT, 'dist');
rmSync(out, { recursive: true, force: true });
cpSync(join(ROOT, 'public'), out, { recursive: true });
cpSync(join(ROOT, 'shared'), join(out, 'shared'), { recursive: true });
console.log('Built dist/');

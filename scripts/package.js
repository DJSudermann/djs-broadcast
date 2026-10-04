#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const versionFile = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();

if (versionFile !== packageJson.version) {
  throw new Error(`VERSION (${versionFile}) und package.json (${packageJson.version}) stimmen nicht überein.`);
}

const releases = path.join(root, 'releases');
fs.mkdirSync(releases, { recursive: true });
const archive = path.join(releases, `${packageJson.name}-v${packageJson.version}.zip`);
if (fs.existsSync(archive)) fs.unlinkSync(archive);
execFileSync('zip', ['-r', archive, 'dist', '-x', '*.map', '*.DS_Store'], { cwd: root, stdio: 'inherit' });
console.log(`Release erstellt: ${archive}`);

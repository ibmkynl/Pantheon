#!/usr/bin/env node
// Pantheon post-install: create ~/.pantheon/{pantheon.yaml,data/} on first install.
// Idempotent — safe to re-run. Never overwrites existing files.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME       = os.homedir();
const HOME_DIR   = process.env.PANTHEON_HOME || path.join(HOME, '.pantheon');
const CONFIG     = path.join(HOME_DIR, 'pantheon.yaml');
const DATA_DIR   = path.join(HOME_DIR, 'data');
const WORKSPACES = path.join(HOME_DIR, 'workspaces');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function copyTemplate() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // package layout: <pkg>/scripts/install.js → <pkg>/pantheon.yaml.example
  const template = path.resolve(__dirname, '..', 'pantheon.yaml.example');
  if (!fs.existsSync(template)) {
    return false;
  }
  fs.copyFileSync(template, CONFIG);
  return true;
}

try {
  ensureDir(HOME_DIR);
  ensureDir(DATA_DIR);
  ensureDir(WORKSPACES);

  if (!fs.existsSync(CONFIG)) {
    if (copyTemplate()) {
      console.log(`✓ Pantheon installed.`);
      console.log(`  Config: ${CONFIG}`);
      console.log(`  Edit it to add your API key, then run: pantheon`);
    } else {
      console.log(`✓ Pantheon installed. Run 'pantheon' to start (you'll be prompted for setup).`);
    }
  } else {
    console.log(`✓ Pantheon updated. Existing config at ${CONFIG} preserved.`);
  }
} catch (err) {
  // Non-fatal — first run of `pantheon` will retry setup.
  console.warn(`Pantheon post-install warning: ${err.message}`);
  process.exit(0);
}

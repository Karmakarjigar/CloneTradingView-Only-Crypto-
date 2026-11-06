'use strict';

const fs = require('fs');
const path = require('path');

const DIR = process.env.TVFREE_CACHE_DIR || path.join(__dirname, '..', '.cache');

/** @type {Map<string, {at:number, value:any}>} */
const mem = new Map();
let dirReady = false;

function ensureDir() {
  if (dirReady) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
  } catch {
    /* non-fatal */
  }
  dirReady = true;
}

function fileFor(key) {
  const safe = Buffer.from(key).toString('base64url').slice(0, 160);
  return path.join(DIR, safe + '.json');
}

function get(key, ttlMs) {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at <= ttlMs) return hit.value;
  return null;
}

function set(key, value) {
  const entry = { at: Date.now(), value };
  mem.set(key, entry);
  ensureDir();
  try {
    fs.writeFileSync(fileFor(key), JSON.stringify(entry));
  } catch {
    /* non-fatal */
  }
  return value;
}

/** Last known good value, from memory or disk, regardless of age. */
function stale(key) {
  const hit = mem.get(key);
  if (hit) return hit.value;
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
    if (parsed && parsed.value) {
      mem.set(key, parsed);
      return parsed.value;
    }
  } catch {
    /* miss */
  }
  return null;
}

module.exports = { get, set, stale };

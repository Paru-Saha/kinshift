// Simple JSON-file store. Good enough for a hackathon demo: one family, a few hundred records.
import fs from 'node:fs';
import path from 'node:path';
import { buildSeed } from './seed.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const DATA_FILE = path.join(DATA_DIR, 'kinshift.json');

let state = null;

export function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    state = buildSeed();
    save();
  }
  return state;
}

export function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

export function reset() {
  state = buildSeed();
  save();
  return state;
}

export function db() {
  return load();
}

export function newId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

export function log(kind, text, extra = {}) {
  const s = load();
  s.activity.unshift({ id: newId('act'), at: new Date().toISOString(), kind, text, ...extra });
  s.activity = s.activity.slice(0, 200);
}

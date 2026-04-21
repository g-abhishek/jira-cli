'use strict';

/**
 * assigneeMemory.js
 * Lightweight local memory for assignee name -> accountId/email.
 *
 * Stored at ~/.jira-cli/assignees.json
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const CONFIG_DIR = path.join(os.homedir(), '.jira-cli');
const STORE_PATH = path.join(CONFIG_DIR, 'assignees.json');

function readStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    }
  } catch {}
  return { entries: [] };
}

function writeStore(store) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch {}
}

function normalise(str) {
  return String(str || '').trim().toLowerCase();
}

function listEntries() {
  const store = readStore();
  return store.entries || [];
}

function findMatches(query) {
  const q = normalise(query);
  if (!q) return [];
  const store = readStore();
  return (store.entries || []).filter((e) => {
    const name = normalise(e.displayName);
    const aliases = (e.aliases || []).map(normalise);
    return name.includes(q) || aliases.some((a) => a.includes(q));
  });
}

function upsertEntry({ displayName, accountId, email, alias }) {
  if (!displayName || !accountId) return;
  const store = readStore();
  const entries = store.entries || [];

  let entry = entries.find((e) => e.accountId === accountId);
  if (!entry) {
    entry = { displayName, accountId, email: email || null, aliases: [] };
    entries.push(entry);
  } else {
    if (displayName) entry.displayName = displayName;
    if (email) entry.email = email;
  }

  if (alias) {
    const a = normalise(alias);
    if (a && !(entry.aliases || []).map(normalise).includes(a)) {
      entry.aliases = entry.aliases || [];
      entry.aliases.push(alias);
    }
  }

  store.entries = entries;
  writeStore(store);
}

function removeEntryByName(name) {
  const q = normalise(name);
  if (!q) return 0;
  const store = readStore();
  const before = store.entries || [];
  const after = before.filter((e) => {
    const display = normalise(e.displayName);
    const aliases = (e.aliases || []).map(normalise);
    return !(display === q || aliases.includes(q));
  });
  store.entries = after;
  writeStore(store);
  return before.length - after.length;
}

function clearEntries() {
  writeStore({ entries: [] });
}

module.exports = { listEntries, findMatches, upsertEntry, removeEntryByName, clearEntries };

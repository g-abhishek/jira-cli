'use strict';

/**
 * cache.js
 * JSON file-based local cache for Jira metadata.
 * Stores project fields, fix versions, components, transitions, sprints, users.
 * Prevents repeat API calls and enables offline reads.
 *
 * Cache file: ~/.jira-cli/cache.json
 * Pure JavaScript — no native dependencies. Works everywhere including pkg binaries.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const CACHE_DIR = path.join(os.homedir(), '.jira-cli');
const CACHE_PATH = path.join(CACHE_DIR, 'cache.json');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const DEFAULT_TTL = parseInt(process.env.CACHE_TTL || '86400', 10); // 24h default

// ── Internal read/write ────────────────────────────────────────────────────────

function readStore() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function writeStore(store) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(store, null, 2));
  } catch {}
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get a value from cache. Returns null if missing or expired.
 */
function get(key) {
  try {
    const store = readStore();
    const entry = store[key];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      del(key);
      return null;
    }
    return entry.value;
  } catch {
    return null;
  }
}

/**
 * Store a value in cache with optional TTL in seconds.
 */
function set(key, value, ttl = DEFAULT_TTL) {
  try {
    const store = readStore();
    store[key] = {
      value,
      expiresAt: Date.now() + ttl * 1000,
      createdAt: Date.now(),
    };
    writeStore(store);
  } catch {
    // Cache write failure is non-fatal
  }
}

/**
 * Delete a key from cache.
 */
function del(key) {
  try {
    const store = readStore();
    delete store[key];
    writeStore(store);
  } catch {}
}

/**
 * Clear all cache entries for a specific project prefix.
 */
function clearProject(projectKey) {
  try {
    const store = readStore();
    Object.keys(store)
      .filter((k) => k.startsWith(`${projectKey}:`))
      .forEach((k) => delete store[k]);
    writeStore(store);
  } catch {}
}

/**
 * Get cache metadata — for `jira sync` status display.
 */
function getMeta(projectKey) {
  try {
    const store = readStore();
    const entry = store[`${projectKey}:sync_meta`];
    if (!entry) return null;
    return {
      expiresAt: entry.expiresAt,
      isStale: Date.now() > entry.expiresAt,
      lastSynced: new Date(entry.createdAt).toLocaleString(),
    };
  } catch {
    return null;
  }
}

/**
 * Check if sync data is stale (older than TTL)
 */
function isSyncStale(projectKey) {
  const meta = getMeta(projectKey);
  if (!meta) return true;
  return meta.isStale;
}

module.exports = { get, set, del, clearProject, getMeta, isSyncStale };

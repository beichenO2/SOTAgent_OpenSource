/**
 * api-cache.ts — On-demand cache with disk persistence.
 *
 * Design:
 *  - No background timers — data is fetched only when the frontend requests it.
 *  - Frontend polls the API endpoint every ~10s; the backend rate-limits
 *    upstream fetches to at most once per LIVE_FETCH_COOLDOWN_MS (60s).
 *  - Disk is written every DISK_WRITE_INTERVAL fetches (5th fetch) to survive restarts.
 *  - If no one is requesting, nothing happens (zero background load).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_DIR = join(process.env.HOME ?? '/tmp', 'Polarisor', 'SOTAgent', 'data', 'api-cache');
const LIVE_FETCH_COOLDOWN_MS = 60_000;
const DISK_WRITE_INTERVAL = 5;

interface CacheEntry {
  data: unknown;
  updatedAt: string;
}

interface CacheSlot {
  mem: CacheEntry | null;
  fetcher: (() => Promise<unknown>) | null;
  lastFetchAt: number;
  fetchesSinceDiskWrite: number;
  fetching: boolean;
}

const slots = new Map<string, CacheSlot>();

try { mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ok */ }

function cacheFilePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

function loadFromDisk(key: string): CacheEntry | null {
  try {
    const raw = readFileSync(cacheFilePath(key), 'utf-8');
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

function saveToDisk(key: string, entry: CacheEntry): void {
  try {
    writeFileSync(cacheFilePath(key), JSON.stringify(entry));
  } catch { /* best effort */ }
}

function getSlot(key: string): CacheSlot {
  let slot = slots.get(key);
  if (!slot) {
    slot = { mem: null, fetcher: null, lastFetchAt: 0, fetchesSinceDiskWrite: 0, fetching: false };
    slots.set(key, slot);
  }
  return slot;
}

/**
 * Register a fetcher for a cache key. No timers are started.
 * The fetcher is called on-demand when `getOrFetch` is invoked.
 */
export function registerFetcher(key: string, fetcher: () => Promise<unknown>): void {
  const slot = getSlot(key);
  slot.fetcher = fetcher;
}

/** Backward-compat alias — same as registerFetcher (timers removed). */
export function startCacheRefresh(key: string, fetcher: () => Promise<unknown>, _intervalMs?: number): void {
  registerFetcher(key, fetcher);
}

export function stopAllCacheRefresh(): void {
  // No-op: no timers to stop. Kept for backward compatibility.
}

/**
 * Get cached data. Returns mem > disk > null. Does NOT trigger a fetch.
 */
export function getCached(key: string): unknown | null {
  const slot = getSlot(key);
  if (slot.mem) return slot.mem.data;
  const disk = loadFromDisk(key);
  if (disk) {
    slot.mem = disk;
    return disk.data;
  }
  return null;
}

/**
 * Force-update the in-memory cache for a key. Conditionally writes to disk.
 */
export function updateCache(key: string, data: unknown): void {
  const slot = getSlot(key);
  const entry: CacheEntry = { data, updatedAt: new Date().toISOString() };
  slot.mem = entry;
  slot.fetchesSinceDiskWrite++;
  if (slot.fetchesSinceDiskWrite >= DISK_WRITE_INTERVAL) {
    saveToDisk(key, entry);
    slot.fetchesSinceDiskWrite = 0;
  }
}

/**
 * Core method for API handlers: returns fresh or cached data.
 *
 * - If a fetcher is registered and cooldown has elapsed, fetches live data.
 * - Otherwise returns memory cache, falling back to disk cache.
 * - Non-blocking: if a fetch is already in progress, returns stale data.
 */
export async function getOrFetch(key: string): Promise<unknown | null> {
  const slot = getSlot(key);
  const now = Date.now();
  const cooldownOk = now - slot.lastFetchAt >= LIVE_FETCH_COOLDOWN_MS;

  if (slot.fetcher && cooldownOk && !slot.fetching) {
    slot.fetching = true;
    slot.lastFetchAt = now;
    try {
      const data = await slot.fetcher();
      if (data !== null && data !== undefined) {
        updateCache(key, data);
      }
    } catch { /* silent */ }
    finally { slot.fetching = false; }
  }

  return getCached(key);
}

/**
 * Force a disk write for a specific key (e.g. on graceful shutdown).
 */
export function flushToDisk(key: string): void {
  const slot = getSlot(key);
  if (slot.mem) {
    saveToDisk(key, slot.mem);
    slot.fetchesSinceDiskWrite = 0;
  }
}

/**
 * Flush all cached keys to disk.
 */
export function flushAllToDisk(): void {
  for (const key of slots.keys()) {
    flushToDisk(key);
  }
}

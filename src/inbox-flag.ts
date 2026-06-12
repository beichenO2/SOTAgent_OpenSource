/**
 * inbox-flag.ts — Centralized .sotagent-inbox-flag writer
 *
 * Writes ~/Polarisor/.sotagent-inbox-flag to signal agents (PolarCopilot Hub, etc.)
 * that SOTAgent has new cross-device or cross-project information to check.
 *
 * Consumers poll this file on session start; a fresh timestamp means
 * "go read ~/.sotagent/outbox/ or SOTAgent/you/ for updates".
 */

import fs from 'node:fs';
import path from 'node:path';

const POLARISOR_ROOT = path.join(process.env.HOME ?? '~', 'Polarisor');
const FLAG_PATH = path.join(POLARISOR_ROOT, '.sotagent-inbox-flag');

export type FlagReason =
  | 'you_changed'
  | 'inbox_processed'
  | 'peer_notification'
  | 'sync_suggestion'
  | 'outbox_response'
  | 'ssot_audit_alert';

export interface IInboxFlag {
  timestamp: string;
  reason: FlagReason;
  /** Backward-compat: files that changed (for you_changed reason) */
  changedFiles?: string[];
  project?: string;
  detail?: string;
}

let _lastWriteMs = 0;
const MIN_INTERVAL_MS = 5_000;

/**
 * Write the inbox flag file. Debounced to avoid thrashing during
 * batch operations (e.g. processing multiple inbox messages at once).
 */
export function writeInboxFlag(reason: FlagReason, opts?: {
  changedFiles?: string[];
  project?: string;
  detail?: string;
}): void {
  const now = Date.now();
  if (now - _lastWriteMs < MIN_INTERVAL_MS) return;

  const flag: IInboxFlag = {
    timestamp: new Date().toISOString(),
    reason,
    ...opts,
  };

  try {
    fs.writeFileSync(FLAG_PATH, JSON.stringify(flag, null, 2));
    _lastWriteMs = now;
  } catch {
    // Non-critical — don't crash the caller
  }
}

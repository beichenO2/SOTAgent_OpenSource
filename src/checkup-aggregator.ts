/**
 * checkup-aggregator.ts — Append-only ingestor for cross-project checkup events.
 *
 * Receives events forwarded from PolarCopilot Hub's `POST /api/checkup-event`
 * (which itself validates them against
 * `Agent_core/contracts/checkup-event.schema.json`).
 *
 * Storage: line-delimited JSON at `data/checkup-events.jsonl` so downstream
 * SOTA trend analysis can stream-read without parsing a full array.
 *
 * Per 任务书/260505_compiled/SOTAgent.md §6 工作项 C — append-only by design,
 * no mutation, no compaction. Rotation belongs to a separate ops task.
 */

import { mkdirSync, appendFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR = path.join(
  process.env.SOTAGENT_DATA_DIR ?? path.join(process.env.HOME ?? '', 'Polarisor', 'SOTAgent', 'data'),
);
const DEFAULT_FILE = process.env.SOTAGENT_CHECKUP_FILE ?? path.join(DEFAULT_DIR, 'checkup-events.jsonl');

export interface CheckupEvent {
  event_id: string;
  project: string;
  agent_target: string;
  page_url: string;
  page_title?: string;
  user_text: string;
  screenshot_b64?: string;
  screenshot_clip?: { x: number; y: number; width: number; height: number };
  annotations?: Array<{ kind: string; geometry?: unknown; text?: string }>;
  user_session?: Record<string, unknown>;
  timestamp: string;
}

export interface AggregatorEnvelope {
  /** ISO 8601 UTC time when the aggregator received the event. */
  received_at: string;
  /** Source of the forward (e.g., "polarcop-hub"). */
  source: string;
  /** The verbatim event payload. */
  event: CheckupEvent;
}

export interface CheckupAggregatorOptions {
  /** Override the jsonl file location (used by tests). */
  filePath?: string;
}

export class CheckupAggregator {
  readonly filePath: string;

  constructor(options: CheckupAggregatorOptions = {}) {
    this.filePath = options.filePath ?? DEFAULT_FILE;
    this.ensureDir();
  }

  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /**
   * Append one event envelope as a single JSON line.
   * Returns the envelope that was written.
   */
  append(event: CheckupEvent, source = 'polarcop-hub'): AggregatorEnvelope {
    const envelope: AggregatorEnvelope = {
      received_at: new Date().toISOString(),
      source,
      event,
    };
    appendFileSync(this.filePath, JSON.stringify(envelope) + '\n', 'utf-8');
    return envelope;
  }

  /** Returns size of the jsonl file in bytes (0 if absent). */
  size(): number {
    try {
      return statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }
}

let _singleton: CheckupAggregator | undefined;

/** Lazily-constructed default aggregator that targets `data/checkup-events.jsonl`. */
export function getCheckupAggregator(): CheckupAggregator {
  if (!_singleton) _singleton = new CheckupAggregator();
  return _singleton;
}

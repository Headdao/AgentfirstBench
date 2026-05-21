import { createWriteStream, type WriteStream } from 'node:fs';

export type EventType =
  | 'run_started'
  | 'worker_scheduled'
  | 'worker_started'
  | 'worker_completed'
  | 'worker_failed'
  | 'worker_retried'
  | 'rate_limited'
  | 'coordinator_started'
  | 'coordinator_completed'
  | 'evaluation_started'
  | 'evaluation_completed'
  | 'run_completed';

export interface BaseEvent {
  timestamp: string;
  run_id: string;
  event: EventType;
  active_workers?: number;
  [key: string]: unknown;
}

/** JSONL writer for the run event log. Append-only, one event per line. */
export class EventLog {
  private stream: WriteStream;
  private active = 0;
  private peak = 0;

  constructor(
    path: string,
    private readonly runId: string,
  ) {
    this.stream = createWriteStream(path, { flags: 'a' });
  }

  emit(event: EventType, fields: Record<string, unknown> = {}): void {
    if (event === 'worker_started') {
      this.active += 1;
      if (this.active > this.peak) this.peak = this.active;
    } else if (event === 'worker_completed' || event === 'worker_failed') {
      this.active = Math.max(0, this.active - 1);
    }

    const record: BaseEvent = {
      timestamp: new Date().toISOString(),
      run_id: this.runId,
      event,
      active_workers: this.active,
      ...fields,
    };
    this.stream.write(JSON.stringify(record) + '\n');
  }

  get peakConcurrency(): number {
    return this.peak;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

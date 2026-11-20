import { gzipSync } from 'node:zlib';
import type { PromptsterConfig, PromptsterEvent } from '../types';
import { log, logError } from '../utils/logger';

const MAX_CONCURRENT = 3;
const REQUEST_TIMEOUT_MS = 10_000;

export class HttpSender {
  /**
   * Requests in flight, counted on the INSTANCE and not per call.
   *
   * The cap exists because `/v1/hooks/ingest` is 100 req/min per API key and
   * this sender uses one request per event, sharing that bucket with the CLI's
   * hook binary on the same candidate key. A cap that reset per invocation
   * would be no cap at all the moment a second caller appears — and the fix
   * this class exists to carry is about not losing events to that bucket.
   */
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly config: PromptsterConfig) {}

  private async acquire(): Promise<void> {
    if (this.active >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  /**
   * Send a batch of events, at most MAX_CONCURRENT in flight across the sender.
   *
   * Returns THE EVENTS THAT FAILED — not a count of the ones that did not.
   *
   * Sends complete out of order, so a success count says nothing about WHICH
   * events landed. The caller requeues whatever comes back from here; given a
   * count it could only requeue an arbitrary suffix, which both re-sends events
   * already delivered and drops the ones that actually needed retrying. The
   * re-send half is not harmless: `raw_events` is idempotent on the event id,
   * but `timeline_events` inserts with a fresh id and has no unique constraint
   * on the source event, so a duplicate POST writes a second row and the
   * replay's attention counts and dwell totals come out wrong.
   *
   * Failures come back in the order they were given, so a retry preserves the
   * order the candidate produced them in.
   */
  async sendBatch(events: PromptsterEvent[]): Promise<PromptsterEvent[]> {
    const failed: (PromptsterEvent | undefined)[] = new Array(events.length);

    await Promise.all(
      events.map(async (event, i) => {
        await this.acquire();
        try {
          if (!(await this.sendOne(event))) failed[i] = event;
        } finally {
          this.release();
        }
      }),
    );

    const out = failed.filter((e): e is PromptsterEvent => e !== undefined);
    if (out.length > 0) {
      log(`Sent ${events.length - out.length}/${events.length} events`);
    }
    return out;
  }

  /**
   * Set once a gzipped resend is refused with 400/415: this backend doesn't
   * inflate ingest bodies, so further resends would only spend the shared
   * 100 req/min bucket.
   */
  private gzipRefused = false;

  /**
   * POST one event to `/v1/hooks/ingest`.
   *
   * Render's edge WAF 403s some bodies before they reach the API, with an HTML
   * "Blocked" page: a terminal command like `source .venv/bin/activate
   * 2>/dev/null; python -m pytest -q` was one, so the test run never reached the
   * timeline. The WAF doesn't read compressed bodies, so a blocked event is sent
   * once more, gzipped, under the same deadline. Plain goes first so a backend
   * that doesn't inflate ingest bodies (self-hosted, or older) keeps working.
   * The API answers in JSON, so its own 403 (a real refusal) is not retried.
   */
  private async sendOne(event: PromptsterEvent): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const body = JSON.stringify(event);
      const label = `${event.kind}/${(event.data as Record<string, unknown> | null)?.subKind ?? ''}`;

      let response = await this.post(body, false, controller.signal);
      if (isEdgeBlock(response) && !this.gzipRefused) {
        await discard(response);
        log(`Ingest blocked at the edge (HTTP 403), resending gzipped: ${label}`);
        response = await this.post(gzipSync(body), true, controller.signal);
        if (response.status === 400 || response.status === 415) this.gzipRefused = true;
      }
      await discard(response);

      if (!response.ok) {
        logError(`Ingest failed (${response.status}): ${label}`);
        return false;
      }

      return true;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        logError('Ingest request timed out', err);
      } else {
        logError('Ingest request failed', err);
      }
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private post(body: string | Uint8Array, gzipped: boolean, signal: AbortSignal): Promise<Response> {
    return fetch(`${this.config.apiUrl}/v1/hooks/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(gzipped ? { 'Content-Encoding': 'gzip' } : {}),
        'X-API-Key': this.config.apiKey,
      },
      body,
      signal,
    });
  }
}

/** Release the connection: nothing reads ingest response bodies. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** A 403 with an HTML body is Render's edge block page; the API answers in JSON. */
function isEdgeBlock(response: Response): boolean {
  return response.status === 403 &&
    (response.headers?.get('content-type') ?? '').toLowerCase().includes('text/html');
}

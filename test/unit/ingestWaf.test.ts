import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';

vi.mock('vscode', () => import('../fakes/vscode'));

import { HttpSender } from '../../src/transport/httpSender';
import type { PromptsterEvent } from '../../src/types';

/**
 * Render's edge WAF answers some plain ingest bodies with an HTML 403 before
 * they reach the API. A terminal command running the tests was one, so the
 * replay showed no test run. These run the real fetch against a local server
 * standing in for the edge and the API behind it.
 */

const BLOCKED_COMMAND = 'source .venv/bin/activate 2>/dev/null; python -m pytest -q';

function terminalEvent(id: string, command: string): PromptsterEvent {
  return {
    id,
    sessionId: 'sess_test',
    ts: new Date().toISOString(),
    source: { channel: 'ide-extension', integration: 'vscode', emitter: 'promptster-vscode' },
    actor: { type: 'human', role: 'candidate' },
    provenance: { attribution: 'likely_human', confidence: 1, observability: 'high', methods: ['ide-extension'] },
    v: 1,
    kind: 'terminal',
    data: { subKind: 'command', command },
  } as unknown as PromptsterEvent;
}

interface Seen { encoding: string | undefined; event: PromptsterEvent | undefined }

let server: Server | undefined;

async function serve(handle: (req: IncomingMessage, raw: Buffer, res: ServerResponse) => void): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handle(req, Buffer.concat(chunks), res));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The edge blocks plain bodies holding the test command; gzipped ones reach an API that inflates them. */
async function wafInFrontOfApi(seen: Seen[]): Promise<string> {
  return serve((req, raw, res) => {
    const encoding = req.headers['content-encoding'];
    const text = (encoding === 'gzip' ? gunzipSync(raw) : raw).toString('utf8');
    if (encoding !== 'gzip' && text.includes('python -m pytest')) {
      seen.push({ encoding, event: undefined });
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><title>Blocked</title>');
      return;
    }
    seen.push({ encoding, event: JSON.parse(text) as PromptsterEvent });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
}

function sender(apiUrl: string): HttpSender {
  return new HttpSender({ apiUrl, apiKey: 'PST-test-key', sessionId: 'sess_test' });
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('HttpSender edge-block resend', () => {
  it('sends an unblocked event once, plain', async () => {
    const seen: Seen[] = [];
    const failed = await sender(await wafInFrontOfApi(seen)).sendBatch([terminalEvent('e1', 'ls -la')]);

    expect(failed).toEqual([]);
    expect(seen.map((s) => s.encoding)).toEqual([undefined]);
    expect(seen[0].event?.id).toBe('e1');
  });

  it('resends an HTML-403 event gzipped, and the API gets the same event', async () => {
    const seen: Seen[] = [];
    const event = terminalEvent('e2', BLOCKED_COMMAND);
    const failed = await sender(await wafInFrontOfApi(seen)).sendBatch([event]);

    expect(failed).toEqual([]);
    expect(seen.map((s) => s.encoding)).toEqual([undefined, 'gzip']);
    expect(seen[1].event).toEqual(event);
  });

  it('does not retry a JSON 403 from the API itself', async () => {
    const encodings: (string | undefined)[] = [];
    const apiUrl = await serve((req, _raw, res) => {
      encodings.push(req.headers['content-encoding']);
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"error":"session_scope"}');
    });

    const event = terminalEvent('e3', BLOCKED_COMMAND);
    const failed = await sender(apiUrl).sendBatch([event]);

    expect(failed).toEqual([event]);
    expect(encodings).toEqual([undefined]);
  });

  it('reports the event failed when the gzipped resend is refused too', async () => {
    // A backend that doesn't inflate ingest bodies: its JSON parser sees gzip bytes.
    const encodings: (string | undefined)[] = [];
    const apiUrl = await serve((req, _raw, res) => {
      encodings.push(req.headers['content-encoding']);
      if (req.headers['content-encoding'] !== 'gzip') {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<title>Blocked</title>');
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"invalid_json"}');
    });

    const event = terminalEvent('e4', BLOCKED_COMMAND);
    const failed = await sender(apiUrl).sendBatch([event]);

    expect(failed).toEqual([event]);
    expect(encodings).toEqual([undefined, 'gzip']);
  });
});

describe('HttpSender against a backend that refuses gzip', () => {
  it('stops resending gzipped once a resend gets a 400', async () => {
    const encodings: (string | undefined)[] = [];
    const apiUrl = await serve((req, _raw, res) => {
      encodings.push(req.headers['content-encoding']);
      if (req.headers['content-encoding'] !== 'gzip') {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<title>Blocked</title>');
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"invalid_json"}');
    });

    const s = sender(apiUrl);
    await s.sendBatch([terminalEvent('e5', BLOCKED_COMMAND)]);
    await s.sendBatch([terminalEvent('e5', BLOCKED_COMMAND)]);

    expect(encodings).toEqual([undefined, 'gzip', undefined]);
  });
});

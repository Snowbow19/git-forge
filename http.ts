// HTTP plumbing: router, JSON body parsing, Bearer auth, and the reply
// envelope (JSON content type + deterministic per-request X-GitHub-Request-Id
// on every reply). No business logic lives here; rest.ts registers routes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Per-process request counter: request ids are `req-<n>`, never wall-clock or random. */
let requestCounter = 0;

export interface Ctx {
  method: string;
  /** Decoded path segments (no leading/trailing empties). */
  segments: string[];
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  /** Parsed JSON body, or undefined when there is no body. */
  body: unknown;
  /** Route params captured from the pattern. */
  params: Record<string, string>;
  /** Origin of this request, e.g. `http://127.0.0.1:1234` (for absolute Link URLs). */
  origin: string;
}

export interface Resp {
  status: number;
  /** Omitted for 204. */
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (ctx: Ctx, store: Store) => Resp | Promise<Resp>;

type Segment =
  | { kind: 'literal'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'rest'; name: string };

interface Route {
  method: string;
  segments: Segment[];
  handler: Handler;
}

function compilePattern(pattern: string): Segment[] {
  const parts = pattern.split('/').filter((part) => part !== '');
  return parts.map((part) => {
    if (part.startsWith('*')) return { kind: 'rest', name: part.slice(1) };
    if (part.startsWith(':')) return { kind: 'param', name: part.slice(1) };
    return { kind: 'literal', value: part };
  });
}

function matchSegments(pattern: Segment[], segments: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const segment = pattern[i]!;
    if (segment.kind === 'rest') {
      params[segment.name] = segments.slice(i).join('/');
      return params;
    }
    if (i >= segments.length) return null;
    const actual = segments[i]!;
    if (segment.kind === 'literal') {
      if (segment.value !== actual) return null;
    } else {
      params[segment.name] = actual;
    }
  }
  return segments.length === pattern.length ? params : null;
}

/** Decode one path segment; a bad escape keeps the raw text (never throws). */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Bearer check. When MAKEFUN_SHOP_TOKEN is set the token must match it
 * exactly; when unset, any non-empty Bearer token is accepted (local dev).
 * /healthz is exempt and handled before this is consulted.
 */
export function isAuthenticated(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return false;
  const token = match[1]!.trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return token === expected;
  return true;
}

/** Read the whole request body as text (drains the stream even when the caller ignores it). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, segments: compilePattern(pattern), handler });
  }

  match(method: string, segments: string[]): { handler: Handler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, segments);
      if (params !== null) return { handler: route.handler, params };
    }
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  requestCounter += 1;
  const requestId = `req-${requestCounter}`;
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

function errJson(status: number, message: string): Resp {
  return { status, body: { message } };
}

/**
 * Build the request handler for a store + router. Order: /healthz (no auth)
 * -> drain body -> Bearer auth for /api/v3 -> malformed JSON is 400 -> route
 * or JSON 404. Every reply carries X-GitHub-Request-Id.
 */
export function createRequestHandler(store: Store, router: Router): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        let pathname = '/';
        let query = new URLSearchParams();
        try {
          const url = new URL(req.url ?? '/', 'http://entry');
          pathname = url.pathname;
          query = url.searchParams;
        } catch {
          // Keep pathname '/' and an empty query; routing below answers 404.
        }
        const segments = pathname.split('/').filter((part) => part !== '').map(decodeSegment);
        const host = req.headers.host ?? '127.0.0.1';
        const origin = `http://${host}`;

        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const rawBody = await readBody(req);
        const underApi = segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3';
        if (underApi && !isAuthenticated(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }

        let body: unknown;
        if (rawBody.trim() !== '') {
          try {
            body = JSON.parse(rawBody) as unknown;
          } catch {
            sendJson(res, 400, { message: 'Invalid JSON in request body' });
            return;
          }
        }

        const matched = router.match(method, segments);
        if (matched === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const ctx: Ctx = { method, segments, query, headers: req.headers, body, params: matched.params, origin };
        const result = await matched.handler(ctx, store);
        if (result.body === undefined && result.status !== 204) {
          sendJson(res, result.status, {}, result.headers);
        } else {
          sendJson(res, result.status, result.body, result.headers);
        }
      } catch (err) {
        process.stderr.write(`[http] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  };
}

/** Build an http.Server from a store + router. */
export function createHttpServer(store: Store, router: Router): Server {
  return createServer(createRequestHandler(store, router));
}

export { errJson };

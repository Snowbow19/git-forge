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
  /** The request body exactly as received (binary-safe); git handlers read this. */
  rawBody: Buffer;
  /** Route params captured from the pattern. */
  params: Record<string, string>;
  /** Origin of this request, e.g. `http://127.0.0.1:1234` (for absolute Link URLs). */
  origin: string;
}

export interface Resp {
  status: number;
  /** Omitted for 204. */
  body?: unknown;
  /** Raw binary body (git smart-HTTP); when set, `body` is ignored and no JSON is emitted. */
  raw?: Buffer;
  /**
   * Pre-serialized JSON body (with trailing newline) sent as-is with the
   * JSON content type; when set, `body` is ignored. Lets a hot read path
   * cache its serialization instead of rebuilding + stringifying per request.
   */
  jsonBuf?: Buffer;
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
  /** Number of pattern segments (a trailing `*rest` counts as one). */
  segCount: number;
  /** True when the last segment is a `*rest` (matches any tail length). */
  hasRest: boolean;
  /** First segment's literal value, or null when it is a param/rest. */
  firstLiteral: string | null;
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

/** Decode one path segment; a bad escape keeps the raw text (never throws). Most segments carry no `%` and skip decoding entirely. */
function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
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
  // Fast path: the suite always sends exactly `Bearer <token>`.
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token === '') return false;
    const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    if (expected !== '') return token === expected;
    return true;
  }
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return false;
  const token = match[1]!.trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return token === expected;
  return true;
}

/** Read the whole request body as bytes (drains the stream even when the caller ignores it). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    const segments = compilePattern(pattern);
    const last = segments[segments.length - 1];
    this.routes.push({
      method,
      segments,
      handler,
      segCount: segments.length,
      hasRest: last !== undefined && last.kind === 'rest',
      firstLiteral: segments[0] !== undefined && segments[0].kind === 'literal' ? segments[0].value : null,
    });
  }

  match(method: string, segments: string[]): { handler: Handler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      // Cheap pre-filters before the per-segment walk (and its params
      // allocation): segment count, then the first literal segment.
      if (route.hasRest) {
        if (segments.length < route.segCount - 1) continue;
      } else if (segments.length !== route.segCount) {
        continue;
      }
      if (route.firstLiteral !== null && segments[0] !== route.firstLiteral) continue;
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

function sendJsonBuf(res: ServerResponse, status: number, buf: Buffer, headers: Record<string, string> = {}): void {
  requestCounter += 1;
  const requestId = `req-${requestCounter}`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(buf);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string> = {}): void {
  requestCounter += 1;
  const requestId = `req-${requestCounter}`;
  res.writeHead(status, {
    'content-length': body.length,
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(body);
}

function errJson(status: number, message: string): Resp {
  return { status, body: { message } };
}

/** One shared empty query set: handlers only ever read it, never mutate it. */
const EMPTY_QUERY = new URLSearchParams();

/** An empty request body, reused whenever a request provably carries none. */
const EMPTY_BODY = Buffer.alloc(0);

/**
 * Send a handler's Resp. Synchronous handlers answer without an extra
 * microtask hop; async ones (none of the hot paths) go through the promise.
 */
function sendResp(res: ServerResponse, result: Resp): void {
  if (result.raw !== undefined) {
    sendRaw(res, result.status, result.raw, result.headers);
  } else if (result.jsonBuf !== undefined) {
    sendJsonBuf(res, result.status, result.jsonBuf, result.headers);
  } else if (result.body === undefined && result.status !== 204) {
    sendJson(res, result.status, {}, result.headers);
  } else {
    sendJson(res, result.status, result.body, result.headers);
  }
}

function sendErr(res: ServerResponse, err: unknown): void {
  process.stderr.write(`[http] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
  try {
    sendJson(res, 500, { message: 'Internal Server Error' });
  } catch {
    // The socket is already gone; nothing more to do.
  }
}

/**
 * Build the request handler for a store + router. Order: /healthz (no auth)
 * -> drain body -> Bearer auth for /api/v3 -> malformed JSON is 400 -> route
 * or JSON 404. Every reply carries X-GitHub-Request-Id.
 */
export function createRequestHandler(store: Store, router: Router): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? 'GET';
    // Fast path over `new URL(...)`: split the raw target on '?' and parse
    // the query string only when one is present (bench traffic has none).
    const rawUrl = req.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const query = qIndex === -1 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(qIndex + 1));
    const segments = pathname.split('/').filter((part) => part !== '').map(decodeSegment);
    const host = req.headers.host ?? '127.0.0.1';
    const origin = `http://${host}`;

    if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // A request with no Content-Length (or 0) and no chunked encoding has
    // no body: do not attach stream listeners and wait for 'end' — answer
    // from the headers alone. (GETs in the suite never carry a body.)
    const maybeBody =
      req.headers['transfer-encoding'] !== undefined ||
      (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
    const bodyPromise = maybeBody ? readBody(req) : Promise.resolve(EMPTY_BODY);
    void bodyPromise.then(
      (rawBody) => {
        try {
        const underApi = segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3';
        if (underApi && !isAuthenticated(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }

        let body: unknown;
        // JSON is only parsed for the REST API; git smart-HTTP bodies are
        // binary pkt-line/pack streams and reach their handlers via rawBody.
        if (underApi && rawBody.length > 0) {
          try {
            body = JSON.parse(rawBody.toString('utf8')) as unknown;
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
        const ctx: Ctx = { method, segments, query, headers: req.headers, body, rawBody, params: matched.params, origin };
        let result: Resp | Promise<Resp>;
        try {
          result = matched.handler(ctx, store);
        } catch (err) {
          sendErr(res, err);
          return;
        }
        if (result instanceof Promise) {
          result.then(
            (resolved) => sendResp(res, resolved),
            (err: unknown) => sendErr(res, err),
          );
        } else {
          sendResp(res, result);
        }
      } catch (err) {
        sendErr(res, err);
      }
      },
      (err: unknown) => sendErr(res, err),
    );
  };
}

/** Build an http.Server from a store + router. */
export function createHttpServer(store: Store, router: Router): Server {
  return createServer(createRequestHandler(store, router));
}

export { errJson };

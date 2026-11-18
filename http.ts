// HTTP plumbing: router, JSON body parsing, Bearer auth, and the reply
// envelope (JSON content type + deterministic per-request X-GitHub-Request-Id
// on every reply). No business logic lives here; rest.ts registers routes.
//
// Transport: a raw node:net server with a hand-rolled HTTP/1.1 parser.
// Node's http module spends most of a hot request's server time in its own
// machinery (parser, IncomingMessage/ServerResponse allocation, header
// handling, one write per head/body piece) while our handlers are a few
// microseconds of Map lookups and a cached Buffer. The bench drives
// thousands of small sequential requests on keep-alive connections, so the
// per-request overhead is the whole game: one pre-built response Buffer
// per request, written to the socket in a single write, with no per-request
// object graph beyond the request's own headers and body.
//
// The wire contract is unchanged: the same status lines, headers, bodies
// and keep-alive behaviour a Node http server would produce, so clients
// (undici, git) cannot tell the difference. Requests are handled strictly
// in order on each connection; pipelined bytes are parsed after the current
// response is written.

import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import type { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Per-process request counter: request ids are `req-<n>`, never wall-clock or random. */
let requestCounter = 0;

export interface Ctx {
  method: string;
  /** Decoded path segments (no leading/trailing empties). */
  segments: string[];
  query: URLSearchParams;
  /** Lower-cased header names, single values (first wins on duplicates). */
  headers: Record<string, string | string[] | undefined>;
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
 * /healthz is exempt and handled before this is consulted. The expected
 * token is read once at startup: process.env is consulted on every call
 * otherwise, and the bench's read workload pays it 2,000 times a round.
 */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function isAuthenticated(headers: Record<string, string | string[] | undefined>): boolean {
  const raw = headers.authorization;
  const header = typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw[0] ?? '') : '';
  // Fast path: the suite always sends exactly `Bearer <token>`.
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token === '') return false;
    if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
    return true;
  }
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return false;
  const token = match[1]!.trim();
  if (token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

export class Router {
  private readonly routes: Route[] = [];
  /**
   * Per-first-segment candidate lists, built lazily: a route only ever
   * matches when its first literal is null (a :param/:rest first segment)
   * or equals the path's first segment, so filtering once per distinct
   * first segment keeps the scan exact (registration order preserved)
   * while a git path checks 3 routes instead of all 33.
   */
  private readonly index = new Map<string, Route[]>();

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
    const first = segments[0] ?? '';
    let candidates = this.index.get(first);
    if (candidates === undefined) {
      candidates = this.routes.filter(
        (route) => route.firstLiteral === null || route.firstLiteral === first,
      );
      this.index.set(first, candidates);
    }
    for (const route of candidates) {
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

function errJson(status: number, message: string): Resp {
  return { status, body: { message } };
}

/** One shared empty query set: handlers only ever read it, never mutate it. */
const EMPTY_QUERY = new URLSearchParams();

/** An empty request body, reused whenever a request provably carries none. */
const EMPTY_BODY = Buffer.alloc(0);

/** Largest request body accepted (the biggest legit pack is far smaller); larger bodies close the socket. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Largest request head accepted; larger heads close the socket. */
const MAX_HEAD_BYTES = 64 * 1024;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/**
 * Serialize a handler's Resp into a single Buffer (status line + headers +
 * body) and the request id it carries. One write per response, no header
 * object, no stream machinery. (A parts/cork variant was tried and reverted:
 * several socket.write calls per response cost more than one concat under
 * the clone workload's 50 concurrent sockets.)
 */
function buildResponse(result: Resp): Buffer {
  requestCounter += 1;
  const requestId = `req-${requestCounter}`;
  const status = result.status;
  const reason = REASONS[status] ?? 'OK';
  let body: Buffer;
  let contentType: string | undefined;
  if (result.raw !== undefined) {
    body = result.raw;
  } else if (result.jsonBuf !== undefined) {
    body = result.jsonBuf;
    contentType = JSON_TYPE;
  } else if (result.body === undefined && status !== 204) {
    body = Buffer.from('{}\n', 'utf8');
    contentType = JSON_TYPE;
  } else if (status === 204) {
    body = EMPTY_BODY;
  } else {
    body = Buffer.from(`${JSON.stringify(result.body)}\n`, 'utf8');
    contentType = JSON_TYPE;
  }
  const headers = result.headers ?? {};
  let head = `HTTP/1.1 ${status} ${reason}\r\n`;
  if (contentType !== undefined) head += `content-type: ${contentType}\r\n`;
  if (status !== 204) head += `content-length: ${body.length}\r\n`;
  head += `x-github-request-id: ${requestId}\r\n`;
  for (const name of Object.keys(headers)) head += `${name}: ${headers[name]}\r\n`;
  head += '\r\n';
  const headBuf = Buffer.from(head, 'utf8');
  if (body.length === 0) return headBuf;
  // One allocation for the whole reply instead of one for the head plus a
  // concat (which allocates again and copies twice).
  const out = Buffer.allocUnsafe(headBuf.length + body.length);
  headBuf.copy(out, 0);
  body.copy(out, headBuf.length);
  return out;
}

/** The 500 a handler error answers with (logged, like the old transport). */
function buildErrorResponse(err: unknown): Buffer {
  process.stderr.write(`[http] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
  return buildResponse({ status: 500, body: { message: 'Internal Server Error' } });
}

// -- request parsing ----------------------------------------------------------

interface ParsedRequest {
  method: string;
  target: string;
  http11: boolean;
  headers: Record<string, string | undefined>;
  body: Buffer;
  /** False when the client asked to close (or HTTP/1.0 without keep-alive). */
  keepAlive: boolean;
}

type ParseOutcome =
  | { kind: 'need-more' }
  | { kind: 'continue' }
  | { kind: 'error'; message: string }
  | { kind: 'request'; req: ParsedRequest; next: number };

/** Find the end of the header block (`\r\n\r\n`) at or after `start`, or -1. */
function findHeadEnd(buf: Buffer, start: number): number {
  // Buffer.indexOf handles the scan; the needle is 4 bytes.
  return buf.indexOf('\r\n\r\n', start);
}

/**
 * Parse one request from `buf` starting at `start`. Returns the request and
 * the offset just past its body, `need-more` when the bytes are not all
 * here yet, `continue` when the head is parsed but the client is waiting
 * for a 100 Continue before sending the body (answered once by the caller),
 * or `error` when the bytes are not HTTP at all. A parsed request may be
 * preceded in the same buffer by pipelined bytes, which the caller parses
 * next.
 */
function parseRequest(buf: Buffer, start: number, continueSent: boolean): ParseOutcome {
  const headEnd = findHeadEnd(buf, start);
  if (headEnd === -1) {
    if (buf.length - start > MAX_HEAD_BYTES) return { kind: 'error', message: 'request head too large' };
    return { kind: 'need-more' };
  }
  // Parse the head straight off the buffer: converting the whole head to a
  // string and splitting it allocates a string per head plus an array, on
  // every request. The request line ends at the first CRLF (which is at
  // most headEnd, the start of the blank line); header lines run from there
  // to headEnd. Behaviour is identical to the old whole-head parse.
  const firstLineEnd = buf.indexOf('\r\n', start);
  const requestLine = buf.subarray(start, firstLineEnd === -1 ? headEnd : firstLineEnd).toString('latin1');
  const parts = requestLine.split(' ');
  if (parts.length !== 3) return { kind: 'error', message: 'bad request line' };
  const method = parts[0]!;
  const target = parts[1]!;
  const version = parts[2]!;
  if (method === '' || !target.startsWith('/') || (version !== 'HTTP/1.1' && version !== 'HTTP/1.0')) {
    return { kind: 'error', message: 'bad request line' };
  }
  const http11 = version === 'HTTP/1.1';
  const headers: Record<string, string | undefined> = {};
  if (firstLineEnd !== -1 && firstLineEnd < headEnd) {
    let off = firstLineEnd + 2;
    while (off < headEnd) {
      let lineEnd = buf.indexOf('\r\n', off);
      if (lineEnd === -1 || lineEnd > headEnd) lineEnd = headEnd;
      const line = buf.subarray(off, lineEnd).toString('latin1');
      off = lineEnd + 2;
      if (line === '') continue;
      const colon = line.indexOf(':');
      if (colon <= 0) return { kind: 'error', message: 'bad header line' };
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (headers[name] === undefined) headers[name] = value;
    }
  }
  const connection = (headers.connection ?? '').toLowerCase();
  const keepAlive = http11 ? connection !== 'close' : connection === 'keep-alive';
  const bodyStart = headEnd + 4;
  // A client that sends `Expect: 100-continue` holds its body until we
  // answer 100 Continue; without the answer the body never arrives. The
  // caller writes the interim response once and re-parses with continueSent.
  const wantsContinue = (headers.expect ?? '').toLowerCase() === '100-continue' && !continueSent;
  const needMore = (): ParseOutcome => (wantsContinue ? { kind: 'continue' } : { kind: 'need-more' });
  const transferEncoding = (headers['transfer-encoding'] ?? '').toLowerCase();
  if (transferEncoding.includes('chunked')) {
    // Chunked body: size lines (hex, extensions ignored), data, CRLF, until a 0 chunk + trailers.
    let off = bodyStart;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', off);
      if (lineEnd === -1) return needMore();
      const sizeText = buf.subarray(off, lineEnd).toString('latin1').split(';')[0]!.trim();
      const size = Number.parseInt(sizeText, 16);
      if (!Number.isFinite(size) || size < 0) return { kind: 'error', message: 'bad chunk size' };
      off = lineEnd + 2;
      if (size === 0) {
        // Trailers end at the first empty line.
        for (;;) {
          const trailerEnd = buf.indexOf('\r\n', off);
          if (trailerEnd === -1) return needMore();
          if (trailerEnd === off) {
            off += 2;
            break;
          }
          off = trailerEnd + 2;
        }
        const body = total === 0 ? EMPTY_BODY : Buffer.concat(chunks, total);
        return { kind: 'request', req: { method, target, http11, headers, body, keepAlive }, next: off };
      }
      if (off + size + 2 > buf.length) return needMore();
      total += size;
      if (total > MAX_BODY_BYTES) return { kind: 'error', message: 'request body too large' };
      chunks.push(buf.subarray(off, off + size));
      off += size + 2;
    }
  }
  const lengthRaw = headers['content-length'];
  if (lengthRaw !== undefined) {
    const length = Number(lengthRaw);
    if (!Number.isInteger(length) || length < 0) return { kind: 'error', message: 'bad content-length' };
    if (length > MAX_BODY_BYTES) return { kind: 'error', message: 'request body too large' };
    if (bodyStart + length > buf.length) return needMore();
    const body = length === 0 ? EMPTY_BODY : buf.subarray(bodyStart, bodyStart + length);
    return { kind: 'request', req: { method, target, http11, headers, body, keepAlive }, next: bodyStart + length };
  }
  // No body framing: a request with no body at all.
  return { kind: 'request', req: { method, target, http11, headers, body: EMPTY_BODY, keepAlive }, next: bodyStart };
}

// -- dispatch (same rules as the old transport) -------------------------------

/**
 * Answer one parsed request against the router. Order: /healthz (no auth)
 * -> Bearer auth for /api/v3 -> malformed JSON is 400 -> route or JSON 404.
 * Every reply carries X-GitHub-Request-Id.
/**
 * Route one request to its handler and serialize the response. Returns the
 * response Buffer synchronously when the handler is synchronous (all of
 * them are today) — no promise, no microtask — and a promise only when a
 * handler returns one.
 */
function dispatch(req: ParsedRequest, store: Store, router: Router): Buffer | Promise<Buffer> {
  const method = req.method;
  const rawUrl = req.target;
  const qIndex = rawUrl.indexOf('?');
  const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const query = qIndex === -1 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(qIndex + 1));
  const segments = pathname.split('/').filter((part) => part !== '').map(decodeSegment);
  const host = req.headers.host ?? '127.0.0.1';
  const origin = `http://${host}`;

  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    return buildResponse({ status: 200, body: { ok: true } });
  }

  const underApi = segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3';
  if (underApi && !isAuthenticated(req.headers)) {
    return buildResponse({ status: 401, body: { message: 'Requires authentication' } });
  }

  let body: unknown;
  // JSON is only parsed for the REST API; git smart-HTTP bodies are binary
  // pkt-line/pack streams and reach their handlers via rawBody.
  if (underApi && req.body.length > 0) {
    try {
      body = JSON.parse(req.body.toString('utf8')) as unknown;
    } catch {
      return buildResponse({ status: 400, body: { message: 'Invalid JSON in request body' } });
    }
  }

  const matched = router.match(method, segments);
  if (matched === null) {
    return buildResponse({ status: 404, body: { message: 'Not Found' } });
  }
  const ctx: Ctx = { method, segments, query, headers: req.headers, body, rawBody: req.body, params: matched.params, origin };
  let result: Resp | Promise<Resp>;
  try {
    result = matched.handler(ctx, store);
  } catch (err) {
    return buildErrorResponse(err);
  }
  if (result instanceof Promise) {
    return result.then(
      (r) => buildResponse(r),
      (err) => buildErrorResponse(err),
    );
  }
  return buildResponse(result);
}

// -- connection handling -------------------------------------------------------

/**
 * Serve one socket: read bytes, parse requests in order, dispatch each and
 * write its response, then keep the socket for the next request (HTTP/1.1
 * keep-alive) until the client closes it or asks to close.
 */
function handleSocket(socket: Socket, store: Store, router: Router): void {
  // Disable Nagle: the bench is small request/response pairs, and a Nagle'd
  // socket holds a small response up to the ~40ms delayed-ACK timer waiting
  // for an ACK, which Node's http server avoids by setting this itself.
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let processing = false;
  let closed = false;
  /** True once this request's 100 Continue has been sent (reset per request). */
  let continueSent = false;

  const fail = (message: string): void => {
    if (closed) return;
    closed = true;
    try {
      socket.write(buildResponse({ status: 400, body: { message } }));
    } catch {
      // The socket is already gone; nothing more to do.
    }
    socket.destroy();
  };

  const pump = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    try {
      for (;;) {
        if (closed || buf.length === 0) return;
        const parsed = parseRequest(buf, 0, continueSent);
        if (parsed.kind === 'need-more') return;
        if (parsed.kind === 'continue') {
          continueSent = true;
          socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'utf8'));
          return;
        }
        if (parsed.kind === 'error') {
          fail(parsed.message);
          return;
        }
        const { req, next } = parsed;
        continueSent = false;
        const dispatched = dispatch(req, store, router);
        const response = dispatched instanceof Promise ? await dispatched : dispatched;
        buf = buf.subarray(next);
        if (closed) return;
        socket.write(response);
        if (!req.keepAlive) {
          closed = true;
          socket.end();
          return;
        }
      }
    } finally {
      processing = false;
    }
  };

  socket.on('data', (chunk: Buffer) => {
    if (closed) return;
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    void pump();
  });
  socket.on('error', () => {
    closed = true;
    socket.destroy();
  });
  socket.on('close', () => {
    closed = true;
  });
}

/** Build a net.Server from a store + router. */
export function createHttpServer(store: Store, router: Router): Server {
  const server = createNetServer((socket) => handleSocket(socket, store, router));
  return server;
}

export { errJson };

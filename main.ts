// Entry point: the harness lifecycle for this forge.
//
// The trial environment (the "env") runs next to this process and hands us
// its origin in MAKEFUN_ENV_URL. Everything this file does is the small
// protocol the env expects from an entry:
//
//   - start the forge server on a port the kernel picks for us,
//   - tell the env which port that is, so its suite can dial us,
//   - keep serving until the env reports that the trial is finished,
//   - shut the server down and leave with exit code 0.
//
// All of the actual forge behaviour — the store, the routes, the git
// objects — lives in app.ts and the modules it pulls in. This file only
// speaks register-then-poll-done over HTTP and owns the process exit code.
//
// Two points the env contract is strict about, so they are written out
// here rather than left implicit: the port is always ephemeral (we listen
// on 0 and never touch 8080, where the env itself listens), and this
// process never gives up on its own while a trial runs. A request that
// fails is retried with backoff; only a plain contract error (400/405 on
// register) ends the program early.

import type { Server } from 'node:http';
import { createApp } from './app.ts';

/** The env origin, with trailing slashes trimmed off. Empty when unset. */
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw === '') return '';
  let end = raw.length;
  while (end > 0 && raw[end - 1] === '/') end -= 1;
  return raw.slice(0, end);
}

/** How long a single register or done request may run before we drop it. */
const REQUEST_BUDGET_MS = 30_000;
/** Backoff between retries: begin here, double each round, never past this. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((wake) => setTimeout(wake, ms));

/** How long to wait before the retry after `round` failed attempts. */
function backoffFor(round: number): number {
  const doubled = BACKOFF_FIRST_MS * 2 ** Math.min(round, 8);
  return doubled < BACKOFF_LIMIT_MS ? doubled : BACKOFF_LIMIT_MS;
}

/**
 * Keep calling `step` until it reports true. A step that throws ends the
 * whole process; a step that reports false is called again after a
 * backoff. Both the register call and the done poll below use this.
 */
async function retryUntil(step: (round: number) => Promise<boolean>): Promise<void> {
  for (let round = 0; ; round += 1) {
    if (await step(round)) return;
    await pause(backoffFor(round));
  }
}

/** Tell the env which port we bound. 200 and 409 both mean "registered". */
async function announcePort(origin: string, port: number): Promise<void> {
  await retryUntil(async () => {
    try {
      const res = await fetch(`${origin}/register`, {
        method: 'POST', // announce the port we bound
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (res.status === 200 || res.status === 409) return true;
      if (res.status === 400 || res.status === 405) {
        const detail = await res.text();
        throw new Error(`register rejected with HTTP ${res.status}: ${detail}`);
      }
      return false;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected with HTTP ')) throw err;
      return false;
    }
  });
}

/** Ask the env whether the trial is over; come back only when it says yes. */
async function awaitCompletion(origin: string): Promise<void> {
  await retryUntil(async () => {
    try {
      const res = await fetch(`${origin}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
      if (!res.ok) return false;
      const payload = (await res.json()) as { done?: unknown };
      return payload.done === true;
    } catch {
      return false;
    }
  });
}

/** Listen on a kernel-chosen port and hand the port number back. */
async function bindEphemeral(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, resolve);
  });
  const bound = server.address();
  if (bound === null || typeof bound !== 'object') {
    throw new Error('server did not bind a TCP port');
  }
  return bound.port;
}

/** The whole life of the process: bind, announce, wait, shut down. */
async function run(): Promise<void> {
  const origin = envOrigin();
  if (origin === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is missing: no env to talk to\n');
    process.exit(1);
  }

  const server = createApp();
  const port = await bindEphemeral(server);
  process.stdout.write(`[entry] bound ephemeral port ${port}\n`);

  await announcePort(origin, port);
  process.stdout.write('[entry] env accepted the port; waiting for done\n');

  await awaitCompletion(origin);
  server.close();
  process.stdout.write('[entry] env says done; exiting\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write('[entry] ' + (err instanceof Error ? err.message : String(err)) + '\n');
  process.exit(1);
}

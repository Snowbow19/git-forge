// The server: wires the in-memory store, the REST v3 routes, and the HTTP
// plumbing together. main.ts (the entry <-> env lifecycle) stays untouched.
//
// GET /healthz -> 200 {"ok": true} (no auth), GET /api/v3/ -> 200 JSON with
// X-OAuth-Scopes; everything else is routed through rest.ts.

import type { Server } from 'node:net';
import { createHttpServer, Router } from './http.ts';
import { registerGitRoutes } from './git.ts';
import { registerGraphqlRoutes } from './graphql.ts';
import { registerMcpRoutes } from './mcp.ts';
import { registerRestRoutes } from './rest.ts';
import { Store } from './store.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const router = new Router();
  registerRestRoutes(router);
  registerGitRoutes(router);
  registerGraphqlRoutes(router);
  registerMcpRoutes(router);
  return createHttpServer(store, router);
}

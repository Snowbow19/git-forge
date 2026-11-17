// MCP (M3): POST /mcp, JSON-RPC 2.0 Streamable HTTP, answered as plain JSON.
//
// Revisions: modern 2026-07-28 via server/discover (supportedVersions,
// serverInfo, capabilities.tools) AND the legacy handshake initialize
// (2025-11-25) + notifications/initialized. No session is issued and none is
// required. Per-request Bearer auth: missing/wrong token -> HTTP 401, before
// tool existence is considered. Malformed JSON -> HTTP 400 + -32700.
// Unknown tool -> -32601. Missing required argument -> isError:true.
// tools/list is a fixed literal array: byte-identical on every call.
// Every tool acts on the same store as REST (ops.ts) and answers in < 3 s.
//
// Determinism: no wall clock / randomness anywhere; tool results carry only
// store data (ids, TRIAL_NOW timestamps).

import type { Ctx, Resp, Router } from './http.ts';
import { errJson } from './http.ts';
import { VIEWER_ID, VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';
import {
  createIssueInStore,
  createPullInStore,
  isBearerAuthed,
  mergePullInStore,
} from './ops.ts';

const SERVER_NAME = 'makefun-git-forge';
const SERVER_VERSION = '0.1.0-m3';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISION = '2025-11-25';

// -- tool catalogue (fixed literal: tools/list is byte-identical every call) --

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        owner: { type: 'string', description: 'Owner login of the repository (defaults to the authenticated user).' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository ("owner/repo").' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository ("owner/repo").' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository ("owner/repo").' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository ("owner/repo").' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body of the pull request.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository ("owner/repo").' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// -- JSON-RPC helpers ------------------------------------------------------------

type JsonRpcId = string | number | null;

interface RpcError {
  code: number;
  message: string;
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error };
}

function toolTextResult(data: unknown): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data, isError: false };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Extract a JSON-RPC id from a body that failed to parse (best effort, for -32700). */
function extractIdFromRaw(raw: string): JsonRpcId {
  const match = /"id"\s*:\s*("([^"\\]|\\.)*"|-?\d+)/.exec(raw);
  if (match === null) return null;
  const token = match[1]!;
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return null;
    }
  }
  const num = Number(token);
  return Number.isFinite(num) ? num : null;
}

// -- REST-shaped views (same fields as rest.ts) ----------------------------------

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    has_issues: true,
    has_pull_requests: true,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
  };
}

function pullView(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER_LOGIN}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
  };
}

// -- argument resolution ----------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Resolve owner/repo from tool arguments: split owner + repo first, else a
 * full_name ("owner/repo"), else the token owner + a repo-like name.
 */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = asString(args.owner) ?? asString(args.owner_login) ?? asString(args.org) ?? asString(args.login);
  const repo = asString(args.repo) ?? asString(args.repository) ?? asString(args.repository_name) ?? asString(args.repo_name);
  if (owner !== null && repo !== null) return { owner, repo };
  const fullName = asString(args.full_name) ?? asString(args.repo_full_name) ?? asString(args.repository_full_name);
  if (fullName !== null) {
    const slash = fullName.indexOf('/');
    if (slash > 0 && slash < fullName.length - 1) {
      return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
    }
  }
  if (repo !== null) return { owner: VIEWER_LOGIN, repo };
  return null;
}

function missingRequired(args: Record<string, unknown>, required: string[]): string | null {
  for (const name of required) {
    const value = args[name];
    if (value === undefined || value === null || (typeof value === 'string' && value === '')) return name;
  }
  return null;
}

// -- tools ------------------------------------------------------------------------

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tool = TOOLS.find((entry) => entry.name.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized)
    ?? TOOLS.find((entry) => normalized.endsWith(entry.name.toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (tool === undefined) {
    throw { code: -32601, message: `Unknown tool: ${name}` } as RpcError;
  }

  switch (tool.name) {
    case 'create_repo': {
      const repoName = asString(args.name) ?? asString(args.repo) ?? asString(args.repository);
      if (repoName === null) return toolErrorResult('Missing required argument: name');
      if (store.hasRepo(repoName)) return toolErrorResult(`Repository already exists: ${repoName}`);
      const description = asString(args.description) ?? '';
      const repo = store.createRepo(repoName, description, args.private === true);
      return toolTextResult(repoView(repo));
    }
    case 'get_repo': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolErrorResult('Missing required argument: owner/repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === null) return toolErrorResult(`Repository not found: ${target.owner}/${target.repo}`);
      return toolTextResult(repoView(repo));
    }
    case 'create_issue': {
      const missing = missingRequired(args, ['title']);
      if (missing !== null) return toolErrorResult(`Missing required argument: ${missing}`);
      const target = resolveOwnerRepo(args);
      if (target === null) return toolErrorResult('Missing required argument: owner/repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === null) return toolErrorResult(`Repository not found: ${target.owner}/${target.repo}`);
      const title = asString(args.title)!;
      const body = asString(args.body) ?? asString(args.description) ?? '';
      const issue = createIssueInStore(store, repo, title, body);
      return toolTextResult(issueView(repo, issue));
    }
    case 'list_issues': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolErrorResult('Missing required argument: owner/repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === null) return toolErrorResult(`Repository not found: ${target.owner}/${target.repo}`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const items = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.seq - a.seq)
        .map((issue) => issueView(repo, issue));
      return toolTextResult({ issues: items });
    }
    case 'create_pull_request': {
      const missing = missingRequired(args, ['title', 'head', 'base']);
      if (missing !== null) return toolErrorResult(`Missing required argument: ${missing}`);
      const target = resolveOwnerRepo(args);
      if (target === null) return toolErrorResult('Missing required argument: owner/repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === null) return toolErrorResult(`Repository not found: ${target.owner}/${target.repo}`);
      const title = asString(args.title)!;
      const head = asString(args.head) ?? asString(args.head_ref) ?? asString(args.head_branch);
      const base = asString(args.base) ?? asString(args.base_ref) ?? asString(args.base_branch);
      if (head === null || base === null) return toolErrorResult('Missing required argument: head/base');
      const body = asString(args.body) ?? asString(args.description) ?? '';
      const created = createPullInStore(store, repo, title, body, head, base);
      if ('error' in created) return toolErrorResult(created.error);
      return toolTextResult(pullView(created.pull));
    }
    case 'merge_pull_request': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolErrorResult('Missing required argument: owner/repo');
      const rawNumber = args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number;
      const pullNumber = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number.parseInt(rawNumber, 10) : NaN;
      if (!Number.isInteger(pullNumber)) return toolErrorResult('Missing required argument: pull_number');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === null) return toolErrorResult(`Repository not found: ${target.owner}/${target.repo}`);
      const pull = repo.pulls.find((entry) => entry.number === pullNumber);
      if (pull === undefined) return toolErrorResult(`Pull request not found: #${pullNumber}`);
      const merged = mergePullInStore(store, repo, pull);
      if (!merged.ok) return toolErrorResult(merged.reason);
      return toolTextResult({ ...pullView(pull), merged: true, sha: merged.sha, message: `Pull request #${pullNumber} merged` });
    }
    default:
      throw { code: -32601, message: `Unknown tool: ${name}` } as RpcError;
  }
}

// -- HTTP handler -------------------------------------------------------------------

export function registerMcpRoutes(router: Router): void {
  router.add('POST', '/mcp', (ctx: Ctx, store: Store): Resp => {
    const rawText = ctx.rawBody.toString('utf8');
    let parsed: unknown;
    try {
      parsed = rawText === '' ? null : JSON.parse(rawText);
    } catch {
      // Malformed JSON -> HTTP 400 + -32700 (never a crash / 500).
      return {
        status: 400,
        body: rpcError(extractIdFromRaw(rawText), { code: -32700, message: 'Parse error' }),
      };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        status: 400,
        body: rpcError(null, { code: -32700, message: 'Parse error' }),
      };
    }
    const request = parsed as Record<string, unknown>;
    const id = (request.id === undefined ? null : request.id) as JsonRpcId;
    const method = request.method;
    if (typeof method !== 'string' || method === '') {
      return { status: 200, body: rpcError(id, { code: -32600, message: 'Invalid Request' }) };
    }
    const isNotification = request.id === undefined;

    // Auth is decided per request, before tool existence is considered.
    if (!isBearerAuthed(ctx.headers)) {
      return errJson(401, 'Requires authentication');
    }

    if (isNotification) {
      // notifications/initialized (and any other notification): no JSON-RPC
      // response; acknowledge with 202 and an empty JSON body.
      return { status: 202, body: {} };
    }

    const params = (request.params !== undefined && request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params))
      ? (request.params as Record<string, unknown>)
      : {};

    switch (method) {
      case 'server/discover': {
        const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
        return {
          status: 200,
          body: rpcResult(id, {
            supportedVersions: [MODERN_REVISION, LEGACY_REVISION, '2025-06-18'],
            serverInfo,
            capabilities: { tools: {} },
            _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
          }),
        };
      }
      case 'initialize': {
        const offered = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
          ? params.protocolVersion
          : LEGACY_REVISION;
        return {
          status: 200,
          body: rpcResult(id, {
            protocolVersion: offered,
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            capabilities: { tools: {} },
          }),
        };
      }
      case 'ping': {
        return { status: 200, body: rpcResult(id, {}) };
      }
      case 'tools/list': {
        return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
      }
      case 'tools/call': {
        const toolName = params.name;
        if (typeof toolName !== 'string' || toolName === '') {
          return { status: 200, body: rpcError(id, { code: -32602, message: 'Invalid params: tool name is required' }) };
        }
        const args = (params.arguments !== undefined && params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
          ? (params.arguments as Record<string, unknown>)
          : {};
        try {
          const result = callTool(store, toolName, args);
          return { status: 200, body: rpcResult(id, result) };
        } catch (err) {
          if (err !== null && typeof err === 'object' && 'code' in err && 'message' in err) {
            const rpcErr = err as RpcError;
            return { status: 200, body: rpcError(id, rpcErr) };
          }
          return { status: 200, body: rpcError(id, { code: -32602, message: err instanceof Error ? err.message : String(err) }) };
        }
      }
      default: {
        return { status: 200, body: rpcError(id, { code: -32601, message: `Method not found: ${method}` }) };
      }
    }
  });

  // The client's close() sends DELETE /mcp best-effort; acknowledge it.
  router.add('DELETE', '/mcp', (_ctx: Ctx, _store: Store): Resp => ({ status: 200, body: {} }));
}

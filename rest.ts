// REST v3 handlers (spec-rest.md §0 inventory). Registered onto the Router
// from http.ts; app.ts wires store + router + server together.
//
// Shapes follow the spec's asserted fields; extra GitHub-like fields are
// included where cheap. Error bodies are always {message: <non-empty>}.

import type { Ctx, Resp, Router } from './http.ts';
import { errJson } from './http.ts';
import {
  TRIAL_NOW,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  branchOfRef,
  countLines,
  refName,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

function notFound(what: string): Resp {
  return errJson(404, `${what} not found`);
}

function badRequest(message: string): Resp {
  return errJson(400, message);
}

function unprocessable(message: string): Resp {
  return errJson(422, message);
}

/** Body must be a JSON object; otherwise 422 (the suite only sends objects). */
function bodyObject(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.body === undefined || ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) return null;
  return ctx.body as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

/** Parse ?page=&per_page= (GitHub defaults: page 1, per_page 30). */
function pageParams(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  return { page, perPage };
}

/**
 * Slice a list into one page and build the Link header (rel="next" only
 * when a further page exists, absolute URL on this origin).
 */
function paginate<T>(ctx: Ctx, items: T[]): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(ctx);
  const start = (page - 1) * perPage;
  const sliced = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const path = `/${ctx.segments.join('/')}`;
    const next = new URL(path, ctx.origin);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { page: sliced, headers };
}

// -- views -----------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
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

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name } : labelJson(label);
    }),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
  };
}

function commentJson(comment: { id: number; body: string; created_at: string; updated_at: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
  };
}

/**
 * Single-issue response. A label-less issue's serialization is cached on
 * the issue itself (the bench's read workload asks for the same issue 2,000
 * times a round); any other issue goes through the normal JSON path.
 */
function issueResponse(repo: Repo, issue: Issue, status: number): Resp {
  if (issue.labels.length === 0) {
    let buf = issue.cachedJson;
    if (buf === undefined) {
      buf = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
      issue.cachedJson = buf;
    }
    return { status, jsonBuf: buf };
  }
  return { status, body: issueJson(repo, issue) };
}

function pullJson(pull: Pull): Record<string, unknown> {
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

// -- repo lookup ------------------------------------------------------------

function getRepo(ctx: Ctx, store: Store): Repo | null {
  const owner = ctx.params.owner ?? '';
  const name = ctx.params.repo ?? '';
  return store.getRepo(owner, name);
}

function requireRepo(ctx: Ctx, store: Store): Repo | Resp {
  const repo = getRepo(ctx, store);
  if (repo === null) return notFound('Repository');
  return repo;
}

// -- contents helpers -------------------------------------------------------

/** Resolve the ref a contents call targets (body.branch, ?ref=, or the default branch). */
function contentsRef(store: Store, ctx: Ctx, repo: Repo, bodyBranch: unknown): string | null {
  const refParam = ctx.query.get('ref') ?? undefined;
  const wanted = asString(bodyBranch) ?? refParam ?? repo.default_branch;
  return store.resolveRef(repo, wanted, repo.default_branch);
}

function fileEntry(store: Store, repo: Repo, ref: string, path: string): Resp | null {
  const contents = repo.contents.get(ref);
  const blobSha = contents?.get(path);
  if (blobSha === undefined) return null;
  const content = store.blobContent(repo, blobSha);
  if (content === null) return null;
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    status: 200,
    body: {
      type: 'file',
      encoding: 'base64',
      content: content.toString('base64'),
      sha: blobSha,
      size: content.length,
      name,
      path,
    },
  };
}

/** Directory listing: immediate children of `dir` on `ref`, or null when the dir holds nothing. */
function dirEntry(store: Store, repo: Repo, ref: string, dir: string): Resp | null {
  const contents = repo.contents.get(ref);
  if (contents === undefined) return null;
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, { isDir: boolean; sha: string }>();
  for (const [path, blobSha] of contents) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      children.set(rest, { isDir: false, sha: blobSha });
    } else {
      const dirName = rest.slice(0, slash);
      if (!children.has(dirName)) {
        const sub = new Map<string, string>();
        for (const [p2, s2] of contents) {
          if (p2.startsWith(`${prefix}${dirName}/`)) sub.set(p2.slice(prefix.length + dirName.length + 1), s2);
        }
        children.set(dirName, { isDir: true, sha: store.buildTree(repo, sub) });
      }
    }
  }
  if (children.size === 0) return null;
  const entries = [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, child]) => ({
      type: child.isDir ? 'dir' : 'file',
      name,
      path: prefix === '' ? name : `${prefix}${name}`,
      sha: child.sha,
    }));
  return { status: 200, body: entries };
}

// -- route registration -----------------------------------------------------

export function registerRestRoutes(router: Router): void {
  // API root: 200 JSON + X-OAuth-Scopes (the brief pins repo, read:org).
  router.add('GET', '/api/v3', (_ctx) => ({
    status: 200,
    body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
    headers: { 'x-oauth-scopes': 'repo, read:org' },
  }));

  router.add('GET', '/api/v3/meta', (_ctx) => ({
    status: 200,
    body: { installed_version: '0.1.0-m1' },
  }));

  // -- repos ---------------------------------------------------------------
  router.add('GET', '/api/v3/user/repos', (ctx, store) => {
    const repos = store.listRepos();
    const { page, headers } = paginate(ctx, repos);
    return { status: 200, body: page.map(repoJson), headers };
  });

  router.add('POST', '/api/v3/user/repos', (ctx, store) => {
    const body = bodyObject(ctx);
    if (body === null) return badRequest('Request body must be a JSON object');
    const name = asString(body.name);
    if (name === null || name === '') return unprocessable('name is required');
    if (store.hasRepo(name)) return unprocessable('Repository already exists');
    const description = asString(body.description) ?? '';
    const isPrivate = body.private === true;
    const repo = store.createRepo(name, description, isPrivate);
    return { status: 201, body: repoJson(repo) };
  });

  router.add('GET', '/api/v3/repos/:owner/:repo', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    return { status: 200, body: repoJson(repo) };
  });

  router.add('PATCH', '/api/v3/repos/:owner/:repo', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const body = bodyObject(ctx);
    if (body === null) return badRequest('Request body must be a JSON object');
    const description = asString(body.description);
    if (description !== null) repo.description = description;
    if (typeof body.private === 'boolean') repo.private = body.private;
    repo.updated_at = TRIAL_NOW.iso;
    return { status: 200, body: repoJson(repo) };
  });

  router.add('DELETE', '/api/v3/repos/:owner/:repo', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    store.deleteRepo(repo);
    return { status: 204 };
  });

  // -- branches / refs / commits -------------------------------------------
  router.add('GET', '/api/v3/repos/:owner/:repo/branches', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const branches = [...repo.refs.entries()]
      .map(([ref, sha]) => ({ ref, sha, name: branchOfRef(ref) }))
      .filter((entry) => entry.name !== null)
      .sort((a, b) => (a.name! < b.name! ? -1 : a.name! > b.name! ? 1 : 0))
      .map((entry) => ({ name: entry.name, commit: { sha: entry.sha }, protected: false }));
    return { status: 200, body: branches };
  });

  router.add('GET', '/api/v3/repos/:owner/:repo/branches/:branch', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const branch = ctx.params.branch ?? '';
    const ref = refName(branch);
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound('Branch');
    return { status: 200, body: { name: branch, commit: { sha }, protected: false } };
  });

  router.add('GET', '/api/v3/repos/:owner/:repo/git/refs/*ref', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const ref = ctx.params.ref ?? '';
    const fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`;
    const sha = repo.refs.get(fullRef);
    if (sha === undefined) return notFound('Ref');
    return { status: 200, body: { ref: fullRef, object: { sha, type: 'commit' } } };
  });

  router.add('POST', '/api/v3/repos/:owner/:repo/git/refs', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const body = bodyObject(ctx);
    if (body === null) return badRequest('Request body must be a JSON object');
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (ref === null || sha === null || !ref.startsWith('refs/')) return unprocessable('ref and sha are required');
    if (!store.createRef(repo, ref, sha.toLowerCase())) return unprocessable('sha does not name a commit in this repository');
    return { status: 201, body: { ref, object: { sha: sha.toLowerCase(), type: 'commit' } } };
  });

  router.add('GET', '/api/v3/repos/:owner/:repo/commits', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const wanted = ctx.query.get('sha') ?? undefined;
    const ref = store.resolveRef(repo, wanted, repo.default_branch);
    if (ref === null) return notFound('Ref');
    const tip = repo.refs.get(ref);
    if (tip === undefined) return notFound('Ref');
    const commits = store.listCommits(repo, tip).map((entry) => ({
      sha: entry.sha,
      commit: {
        message: entry.message,
        author: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: TRIAL_NOW.iso },
        committer: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: TRIAL_NOW.iso },
      },
    }));
    const { page, headers } = paginate(ctx, commits);
    return { status: 200, body: page, headers };
  });

  // -- contents -------------------------------------------------------------
  router.add('PUT', '/api/v3/repos/:owner/:repo/contents/*path', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const body = bodyObject(ctx);
    if (body === null) return badRequest('Request body must be a JSON object');
    const message = asString(body.message);
    const contentB64 = asString(body.content);
    if (message === null || contentB64 === null) return unprocessable('message and content are required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return unprocessable('content is not valid base64');
    }
    const path = (ctx.params.path ?? '').replace(/\/+$/, '');
    if (path === '') return unprocessable('path is required');
    const branch = asString(body.branch) ?? repo.default_branch;
    const ref = refName(branch);
    const tip = repo.refs.get(ref);
    if (tip === undefined) {
      // Unborn repository: only the default branch may take the first commit.
      if (branch !== repo.default_branch) return notFound('Branch');
      const commitSha = store.createCommit(repo, ref, message, new Map([[path, content]]));
      const blobSha = repo.contents.get(ref)?.get(path) ?? '';
      return {
        status: 201,
        body: {
          content: { name: path.slice(path.lastIndexOf('/') + 1), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
          commit: { sha: commitSha, message },
        },
      };
    }
    const currentBlobSha = repo.contents.get(ref)?.get(path);
    const givenSha = asString(body.sha);
    if (currentBlobSha !== undefined) {
      if (givenSha === null) return errJson(409, 'sha is required to update an existing file');
      if (givenSha.toLowerCase() !== currentBlobSha.toLowerCase()) return errJson(409, 'sha does not match the current blob (stale sha)');
    } else if (givenSha !== null) {
      return errJson(409, 'sha does not match: the file does not exist on this branch');
    }
    const isUpdate = currentBlobSha !== undefined;
    const commitSha = store.createCommit(repo, ref, message, new Map([[path, content]]));
    const blobSha = repo.contents.get(ref)?.get(path) ?? '';
    return {
      status: isUpdate ? 200 : 201,
      body: {
        content: { name: path.slice(path.lastIndexOf('/') + 1), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
        commit: { sha: commitSha, message },
      },
    };
  });

  router.add('GET', '/api/v3/repos/:owner/:repo/contents/*path', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const path = (ctx.params.path ?? '').replace(/\/+$/, '');
    const ref = contentsRef(store, ctx, repo, undefined);
    if (ref === null) return notFound('Ref');
    const tip = repo.refs.get(ref);
    if (tip === undefined) return notFound('Ref');
    if (path === '') {
      const listing = dirEntry(store, repo, ref, '');
      if (listing === null) return notFound('Path');
      return listing;
    }
    const file = fileEntry(store, repo, ref, path);
    if (file !== null) return file;
    const listing = dirEntry(store, repo, ref, path);
    if (listing !== null) return listing;
    return notFound('Path');
  });

  router.add('DELETE', '/api/v3/repos/:owner/:repo/contents/*path', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const body = bodyObject(ctx);
    if (body === null) return badRequest('Request body must be a JSON object');
    const message = asString(body.message);
    if (message === null) return unprocessable('message is required');
    const path = (ctx.params.path ?? '').replace(/\/+$/, '');
    if (path === '') return unprocessable('path is required');
    const ref = contentsRef(store, ctx, repo, body.branch);
    if (ref === null) return notFound('Ref');
    const currentBlobSha = repo.contents.get(ref)?.get(path);
    if (currentBlobSha === undefined) return notFound('Path');
    const givenSha = asString(body.sha);
    if (givenSha === null) return unprocessable('sha is required');
    if (givenSha.toLowerCase() !== currentBlobSha.toLowerCase()) return errJson(409, 'sha does not match the current blob (stale sha)');
    const commitSha = store.createCommit(repo, ref, message, new Map([[path, null]]));
    return { status: 200, body: { commit: { sha: commitSha, message } } };
  });

  // -- labels ----------------------------------------------------------------
  router.add('POST', '/api/v3/repos/:owner/:repo/labels', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const body = bodyObject(ctx);
    if (body === null) return badRequest('Request body must be a JSON object');
    const name = asString(body.name);
    if (name === null || name === '') return unprocessable('name is required');
    const color = asString(body.color) ?? 'ededed';
    const description = asString(body.description) ?? '';
    const label: Label = { name, color, description };
    repo.labels.set(name, label);
    return { status: 201, body: labelJson(label) };
  });

  // -- issues -----------------------------------------------------------------
  router.add('POST', '/api/v3/repos/:owner/:repo/issues', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const body = bodyObject(ctx);
    if (body === null) return badRequest('Request body must be a JSON object');
    const title = asString(body.title);
    if (title === null) return unprocessable('title is required');
    const issueBody = asString(body.body) ?? '';
    const labelNames = body.labels === undefined ? [] : asStringArray(body.labels);
    if (labelNames === null) return unprocessable('labels must be an array of label names');
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return unprocessable(`label does not exist: ${name}`);
    }
    repo.issueSeq += 1;
    const issue: Issue = {
      id: repo.id * 100000 + repo.issueSeq,
      number: repo.issueSeq,
      title,
      body: issueBody,
      state: 'open',
      labels: [...labelNames],
      seq: store.nextSeq(),
      created_at: TRIAL_NOW.iso,
      updated_at: TRIAL_NOW.iso,
      comments: [],
    };
    repo.issues.push(issue);
    return issueResponse(repo, issue, 201);
  });

  router.add('GET', '/api/v3/repos/:owner/:repo/issues', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const state = ctx.query.get('state') ?? 'open';
    const direction = ctx.query.get('direction') ?? 'desc';
    let items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    items = [...items].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    const { page, headers } = paginate(ctx, items);
    return { status: 200, body: page.map((issue) => issueJson(repo, issue)), headers };
  });

  router.add('GET', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const issue = repo.issues.find((entry) => entry.number === Number(ctx.params.number));
    if (issue === undefined) return notFound('Issue');
    return issueResponse(repo, issue, 200);
  });

  router.add('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const issue = repo.issues.find((entry) => entry.number === Number(ctx.params.number));
    if (issue === undefined) return notFound('Issue');
    const body = bodyObject(ctx);
    if (body === null) return badRequest('Request body must be a JSON object');
    const state = asString(body.state);
    if (state === 'open' || state === 'closed') issue.state = state;
    const title = asString(body.title);
    if (title !== null) issue.title = title;
    const issueBody = asString(body.body);
    if (issueBody !== null) issue.body = issueBody;
    issue.updated_at = TRIAL_NOW.iso;
    issue.cachedJson = undefined;
    return issueResponse(repo, issue, 200);
  });

  router.add('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const issue = repo.issues.find((entry) => entry.number === Number(ctx.params.number));
    if (issue === undefined) return notFound('Issue');
    const body = bodyObject(ctx);
    if (body === null) return badRequest('Request body must be a JSON object');
    const commentBody = asString(body.body);
    if (commentBody === null) return unprocessable('body is required');
    repo.commentSeq += 1;
    const comment = { id: repo.commentSeq, body: commentBody, created_at: TRIAL_NOW.iso, updated_at: TRIAL_NOW.iso };
    issue.comments.push(comment);
    return { status: 201, body: commentJson(comment) };
  });

  router.add('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const issue = repo.issues.find((entry) => entry.number === Number(ctx.params.number));
    if (issue === undefined) return notFound('Issue');
    const { page, headers } = paginate(ctx, issue.comments);
    return { status: 200, body: page.map(commentJson), headers };
  });

  // -- pull requests ----------------------------------------------------------
  router.add('POST', '/api/v3/repos/:owner/:repo/pulls', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const body = bodyObject(ctx);
    if (body === null) return badRequest('Request body must be a JSON object');
    const head = asString(body.head);
    const base = asString(body.base);
    const title = asString(body.title);
    if (head === null || base === null || title === null) return unprocessable('head, base and title are required');
    const headRef = refName(head);
    const baseRef = refName(base);
    const headSha = repo.refs.get(headRef);
    const baseSha = repo.refs.get(baseRef);
    if (headSha === undefined || baseSha === undefined) return notFound('Branch');
    const pullBody = asString(body.body) ?? '';
    const baseContents = new Map<string, string>(repo.contents.get(baseRef) ?? new Map());
    const headContents = repo.contents.get(headRef) ?? new Map<string, string>();
    const files = diffContents(store, repo, baseContents, headContents);
    repo.pullSeq += 1;
    const pull: Pull = {
      id: repo.id * 100000 + repo.pullSeq,
      number: repo.pullSeq,
      title,
      body: pullBody,
      state: 'open',
      headRef: head,
      headSha,
      baseRef: base,
      baseSha,
      baseContents,
      files,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      seq: store.nextSeq(),
      created_at: TRIAL_NOW.iso,
      updated_at: TRIAL_NOW.iso,
    };
    repo.pulls.push(pull);
    return { status: 201, body: pullJson(pull) };
  });

  router.add('GET', '/api/v3/repos/:owner/:repo/pulls', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const state = ctx.query.get('state') ?? 'open';
    const items = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
    const { page, headers } = paginate(ctx, items);
    return { status: 200, body: page.map(pullJson), headers };
  });

  router.add('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const pull = repo.pulls.find((entry) => entry.number === Number(ctx.params.number));
    if (pull === undefined) return notFound('Pull request');
    return {
      status: 200,
      body: pull.files.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })),
    };
  });

  router.add('GET', '/api/v3/repos/:owner/:repo/pulls/:number', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const pull = repo.pulls.find((entry) => entry.number === Number(ctx.params.number));
    if (pull === undefined) return notFound('Pull request');
    return { status: 200, body: pullJson(pull) };
  });

  router.add('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', (ctx, store) => {
    const repo = requireRepo(ctx, store);
    if ('status' in repo) return repo;
    const pull = repo.pulls.find((entry) => entry.number === Number(ctx.params.number));
    if (pull === undefined) return notFound('Pull request');
    if (pull.state !== 'open') return errJson(405, 'Pull request is already closed');
    const baseRef = refName(pull.baseRef);
    const currentBaseContents = repo.contents.get(baseRef) ?? new Map<string, string>();
    // Conflict: a file this PR touches was also changed on the base branch
    // since the PR was opened (same file, divergent edit from the same base).
    for (const file of pull.files) {
      const baseBlob = pull.baseContents.get(file.filename);
      const currentBlob = currentBaseContents.get(file.filename);
      if (currentBlob !== baseBlob && file.headBlobSha !== baseBlob) {
        return errJson(405, `Merge conflict: ${file.filename} was changed on ${pull.baseRef} since this pull request was opened`);
      }
    }
    const changes = new Map<string, Buffer | string | null>();
    for (const file of pull.files) {
      changes.set(file.filename, file.headBlobSha === null ? null : file.headBlobSha);
    }
    const message = `${pull.title} (#${pull.number})`;
    const commitSha = store.createCommit(repo, baseRef, message, changes, { baseContents: currentBaseContents });
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = TRIAL_NOW.iso;
    pull.merge_commit_sha = commitSha;
    pull.updated_at = TRIAL_NOW.iso;
    return { status: 200, body: { merged: true, sha: commitSha, message } };
  });
}

/**
 * Diff two path -> blob sha maps into the pull-request files list. Line
 * counts come from the stored blob bytes (added file: all lines added).
 */
function diffContents(
  store: Store,
  repo: Repo,
  base: Map<string, string>,
  head: Map<string, string>,
): Pull['files'] {
  const files: Pull['files'] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const baseSha = base.get(path);
    const headSha = head.get(path);
    if (baseSha === headSha) continue;
    const headText = headSha === undefined ? '' : (store.blobContent(repo, headSha)?.toString('utf8') ?? '');
    const baseText = baseSha === undefined ? '' : (store.blobContent(repo, baseSha)?.toString('utf8') ?? '');
    const additions = countLines(headText);
    const deletions = countLines(baseText);
    files.push({
      filename: path,
      status: baseSha === undefined ? 'added' : headSha === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      headBlobSha: headSha ?? null,
      baseBlobSha: baseSha,
    });
  }
  return files;
}

// Shared store operations for the GraphQL v4 and MCP surfaces (M3).
// Both surfaces act on the SAME store as REST, with the SAME id formulas
// (issue id = repo.id * 100000 + number, pull id likewise), so an object
// created over one surface reads back over the others unchanged.
//
// Determinism: nothing here reads the wall clock or unseeded randomness.
// Timestamps come from TRIAL_NOW; global ids are base64 of a stable
// "Type:owner/repo:number" string — opaque, stable, never the plain
// databaseId / issue number.

import { TRIAL_NOW, VIEWER_LOGIN, countLines, refName, type Issue, type Pull, type Repo, type Store } from './store.ts';

/** Bearer check mirroring http.ts: exact token when set, any non-empty Bearer token otherwise. */
export function isBearerAuthed(headers: Record<string, string | string[] | undefined>): boolean {
  const raw = headers.authorization;
  const header = Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return false;
  const token = match[1]!.trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return token === expected;
  return true;
}

// -- global ids --------------------------------------------------------------

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function repoGlobalId(repo: Repo): string {
  return b64(`Repository:${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64(`Issue:${repo.owner}/${repo.name}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64(`PullRequest:${repo.owner}/${repo.name}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return b64(`IssueComment:${repo.owner}/${repo.name}:${issue.number}:${commentId}`);
}

export interface DecodedGlobalId {
  type: string;
  owner: string;
  repo: string;
  number: number | null;
  extra: number | null;
}

export function decodeGlobalId(id: string): DecodedGlobalId | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const type = parts[0]!;
  const ownerRepo = parts[1]!;
  const slash = ownerRepo.indexOf('/');
  if (slash === -1) return null;
  const owner = ownerRepo.slice(0, slash);
  const repo = ownerRepo.slice(slash + 1);
  if (owner === '' || repo === '') return null;
  const number = parts.length >= 3 && parts[2] !== undefined && parts[2] !== '' ? Number(parts[2]) : null;
  const extra = parts.length >= 4 && parts[3] !== undefined && parts[3] !== '' ? Number(parts[3]) : null;
  if (number !== null && !Number.isInteger(number)) return null;
  return { type, owner, repo, number, extra };
}

export function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Repository') return null;
  return store.getRepo(decoded.owner, decoded.repo);
}

export function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Issue' || decoded.number === null) return null;
  const repo = store.getRepo(decoded.owner, decoded.repo);
  if (repo === null) return null;
  const issue = repo.issues.find((entry) => entry.number === decoded.number);
  return issue === undefined ? null : { repo, issue };
}

export function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'PullRequest' || decoded.number === null) return null;
  const repo = store.getRepo(decoded.owner, decoded.repo);
  if (repo === null) return null;
  const pull = repo.pulls.find((entry) => entry.number === decoded.number);
  return pull === undefined ? null : { repo, pull };
}

// -- diff ---------------------------------------------------------------------

/**
 * Diff two path -> blob sha maps into the pull-request files list. Same
 * algorithm as REST (rest.ts diffContents): line counts from stored blobs.
 */
export function diffContents(store: Store, repo: Repo, base: Map<string, string>, head: Map<string, string>): Pull['files'] {
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

// -- issue / pull / comment creation (same formulas as REST) ------------------

export function createIssueInStore(store: Store, repo: Repo, title: string, body: string): Issue {
  repo.issueSeq += 1;
  const issue: Issue = {
    id: repo.id * 100000 + repo.issueSeq,
    number: repo.issueSeq,
    title,
    body,
    state: 'open',
    labels: [],
    seq: store.nextSeq(),
    created_at: TRIAL_NOW.iso,
    updated_at: TRIAL_NOW.iso,
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

export function createPullInStore(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): { pull: Pull } | { error: string } {
  const headRef = refName(head);
  const baseRef = refName(base);
  const headSha = repo.refs.get(headRef);
  const baseSha = repo.refs.get(baseRef);
  if (headSha === undefined || baseSha === undefined) return { error: 'Branch not found' };
  const baseContents = new Map<string, string>(repo.contents.get(baseRef) ?? new Map());
  const headContents = repo.contents.get(headRef) ?? new Map<string, string>();
  const files = diffContents(store, repo, baseContents, headContents);
  repo.pullSeq += 1;
  const pull: Pull = {
    id: repo.id * 100000 + repo.pullSeq,
    number: repo.pullSeq,
    title,
    body,
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
  return { pull };
}

/** True when the PR's files conflict with the current base tip (same rule as REST merge). */
export function pullConflicts(repo: Repo, pull: Pull): string | null {
  const baseRef = refName(pull.baseRef);
  const currentBaseContents = repo.contents.get(baseRef) ?? new Map<string, string>();
  for (const file of pull.files) {
    const baseBlob = pull.baseContents.get(file.filename);
    const currentBlob = currentBaseContents.get(file.filename);
    if (currentBlob !== baseBlob && file.headBlobSha !== baseBlob) {
      return file.filename;
    }
  }
  return null;
}

export function mergePullInStore(store: Store, repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; reason: string } {
  if (pull.state !== 'open') return { ok: false, reason: 'Pull request is already closed' };
  const conflict = pullConflicts(repo, pull);
  if (conflict !== null) return { ok: false, reason: `Merge conflict: ${conflict}` };
  const baseRef = refName(pull.baseRef);
  const currentBaseContents = repo.contents.get(baseRef) ?? new Map<string, string>();
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
  return { ok: true, sha: commitSha };
}

export function addCommentInStore(store: Store, repo: Repo, issue: Issue, body: string): { id: number; body: string; created_at: string; updated_at: string } {
  void store;
  repo.commentSeq += 1;
  const comment = { id: repo.commentSeq, body, created_at: TRIAL_NOW.iso, updated_at: TRIAL_NOW.iso };
  issue.comments.push(comment);
  return comment;
}

/** The viewer login the token names (the store's single owner). */
export const OWNER_LOGIN = VIEWER_LOGIN;

// In-memory store for the git forge (M1).
//
// Determinism: nothing here reads the wall clock or unseeded randomness.
// Every timestamp comes from MAKEFUN_TRIAL_NOW (parsed once at startup;
// fallback constant for local dev). IDs are sequential counters only.
// Git object ids are SHA-1 over the canonical `"<type> <len>\0" + body`
// framing, so the same content always yields the same sha.
//
// The scenario seed is fixed (SCENARIO_SEED in the suite), so the viewer
// login the token names is a fixed string: "adaiversen". Repositories
// created through POST /user/repos belong to that login; any other owner
// in a path is foreign and must answer 404, never 403.

import { createHash } from 'node:crypto';

/** The login the suite's bearer token names (viewer, users[0] of the fixed scenario). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** Fallback instant used when MAKEFUN_TRIAL_NOW is unset (local dev only). */
export const FALLBACK_NOW_ISO = '2026-11-14T06:30:00.000Z';

/**
 * Parse MAKEFUN_TRIAL_NOW (RFC 3339 instant or epoch milliseconds) once.
 * Returns the ISO instant every created_at/updated_at uses, plus the epoch
 * seconds git commit author/committer lines use.
 */
export function parseTrialNow(): { iso: string; epochSec: number } {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  let ms: number | null = null;
  if (/^\d+$/.test(raw)) {
    ms = Number(raw);
  } else if (raw !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) ms = parsed;
  }
  if (ms === null || !Number.isFinite(ms)) ms = Date.parse(FALLBACK_NOW_ISO);
  return { iso: new Date(ms).toISOString(), epochSec: Math.floor(ms / 1000) };
}

export const TRIAL_NOW = parseTrialNow();

/** SHA-1 hex of the given bytes. */
export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The canonical git object framing: `"<type> <len>\0" + body`. */
export function gitObjectBytes(type: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'utf8'), body]);
}

/** The git object id: SHA-1 of the framed object (hashed incrementally: no copy of the body). */
export function gitObjectSha(type: string, body: Buffer): string {
  return createHash('sha1').update(`${type} ${body.length}\0`, 'utf8').update(body).digest('hex');
}

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  body: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  /** Monotonic insertion order, for stable created asc/desc sorting. */
  seq: number;
  created_at: string;
  updated_at: string;
  comments: IssueComment[];
  /**
   * Serialized single-issue response (with trailing newline), cached only
   * while the issue carries no labels: labels are fixed at creation and
   * PATCH never touches them, so the cache is exact until a PATCH clears it.
   */
  cachedJson?: Buffer;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  /** Blob sha on the head branch (null when the file was removed). */
  headBlobSha: string | null;
  /** Blob sha on the base branch at PR creation (undefined when the file is new). */
  baseBlobSha: string | undefined;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  /** Base branch tip at PR creation. */
  baseSha: string;
  /** Snapshot of the base branch's path -> blob sha at PR creation (conflict detection). */
  baseContents: Map<string, string>;
  files: PullFile[];
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  /** Full ref name ("refs/heads/main") -> commit sha. */
  refs: Map<string, string>;
  /** Git objects by sha (blob/tree/commit/tag). */
  objects: Map<string, GitObject>;
  /** Full ref name -> path -> blob sha (the ref tip's working tree). */
  contents: Map<string, Map<string, string>>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueSeq: number;
  pulls: Pull[];
  pullSeq: number;
  commentSeq: number;
  /** Monotonic insertion order across all issues/PRs, for stable sorting. */
  seqCounter: number;
  /** Memoized v2 fetch responses: the pack + shallow-info bytes for a fetch
   * are a pure function of (wants, haves, shallow, depth, deepen-relative,
   * done) over content-addressed objects, which are immutable and only ever
   * added — so a cached response stays exact for the life of this repo.
   * Capped and cleared when full (a recompute is always correct). */
  fetchCache: Map<string, Buffer>;
  /**
   * Memoized v0 advertisements and ls-refs answers. Both are pure functions
   * of the repo's refs, so they are keyed by gitVersion, which is bumped on
   * every refs mutation (applyCommand, commitChanges, createRef). A stale
   * entry can never be served: the version in its key no longer matches.
   */
  lsRefsCache: Map<string, Buffer>;
  v0AdCache: Map<string, Buffer>;
  /** Bumped on every refs mutation; see lsRefsCache / v0AdCache. */
  gitVersion: number;
}

export function refName(branch: string): string {
  return `refs/heads/${branch}`;
}

export function branchOfRef(ref: string): string | null {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

/** Count text lines the way a diff would: trailing newline ends the last line, it does not start a new one. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.length;
}

export class Store {
  repos = new Map<string, Repo>();
  repoIdCounter = 5000;
  /** Global monotonic counter shared by issues and PRs for stable ordering. */
  globalSeq = 0;

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  nextSeq(): number {
    this.globalSeq += 1;
    return this.globalSeq;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.repoIdCounter,
      name,
      owner: VIEWER_LOGIN,
      description,
      private: isPrivate,
      default_branch: 'main',
      created_at: TRIAL_NOW.iso,
      updated_at: TRIAL_NOW.iso,
      pushed_at: TRIAL_NOW.iso,
      refs: new Map(),
      objects: new Map(),
      contents: new Map(),
      labels: new Map(),
      issues: [],
      issueSeq: 0,
      pulls: [],
      pullSeq: 0,
      commentSeq: 0,
      seqCounter: 0,
      fetchCache: new Map<string, Buffer>(),
      lsRefsCache: new Map<string, Buffer>(),
      v0AdCache: new Map<string, Buffer>(),
      gitVersion: 0,
    };
    this.repoIdCounter += 1;
    this.repos.set(Store.repoKey(repo.owner, repo.name), repo);
    return repo;
  }

  /** The repo only when the owner is the token's login and the name exists; otherwise null (404, never 403). */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(Store.repoKey(owner, name)) ?? null;
  }

  hasRepo(name: string): boolean {
    return this.repos.has(Store.repoKey(VIEWER_LOGIN, name));
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(Store.repoKey(repo.owner, repo.name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  // -- git objects -------------------------------------------------------

  storeObject(repo: Repo, type: ObjectType, body: Buffer): string {
    const sha = gitObjectSha(type, body);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, body });
    return sha;
  }

  storeBlob(repo: Repo, content: Buffer): string {
    return this.storeObject(repo, 'blob', content);
  }

  blobContent(repo: Repo, sha: string): Buffer | null {
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'blob') return null;
    return obj.body;
  }

  /**
   * Build (and store) the tree objects for a path -> blob sha map, returning
   * the root tree sha. Entries sort the git way: directory names compare
   * with a trailing '/'.
   */
  buildTree(repo: Repo, paths: Map<string, string>): string {
    const groups = new Map<string, { blob?: string; sub?: Map<string, string> }>();
    for (const [path, sha] of paths) {
      const slash = path.indexOf('/');
      if (slash === -1) {
        groups.set(path, { blob: sha });
      } else {
        const dir = path.slice(0, slash);
        let group = groups.get(dir);
        if (group === undefined) {
          group = { sub: new Map() };
          groups.set(dir, group);
        }
        group.sub!.set(path.slice(slash + 1), sha);
      }
    }
    interface Entry {
      mode: string;
      name: string;
      sha: string;
      isDir: boolean;
    }
    const entries: Entry[] = [];
    for (const [name, group] of groups) {
      if (group.blob !== undefined) {
        entries.push({ mode: '100644', name, sha: group.blob, isDir: false });
      } else {
        entries.push({ mode: '40000', name, sha: this.buildTree(repo, group.sub!), isDir: true });
      }
    }
    entries.sort((a, b) => {
      const an = a.isDir ? `${a.name}/` : a.name;
      const bn = b.isDir ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const entry of entries) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      parts.push(Buffer.from(entry.sha, 'hex'));
    }
    return this.storeObject(repo, 'tree', Buffer.concat(parts));
  }

  /** Expand a stored tree object back into a path -> blob sha map. */
  treeToContents(repo: Repo, treeSha: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (sha: string, prefix: string): void => {
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'tree') return;
      const body = obj.body;
      let offset = 0;
      while (offset < body.length) {
        const space = body.indexOf(0x20, offset);
        const nul = body.indexOf(0x00, space);
        if (space === -1 || nul === -1) break;
        const mode = body.subarray(offset, space).toString('utf8');
        const name = body.subarray(space + 1, nul).toString('utf8');
        const childSha = body.subarray(nul + 1, nul + 21).toString('hex');
        offset = nul + 21;
        const path = prefix === '' ? name : `${prefix}/${name}`;
        if (mode === '40000') walk(childSha, path);
        else out.set(path, childSha);
      }
    };
    walk(treeSha, '');
    return out;
  }

  /**
   * Create a commit on `ref` (full ref name) applying `changes` to the ref's
   * current tree. A change value is new blob bytes (Buffer), an existing blob
   * sha (string), or null to delete the path. `baseContents` overrides the
   * starting tree (used by squash merges). Returns the new commit sha.
   */
  createCommit(
    repo: Repo,
    ref: string,
    message: string,
    changes: Map<string, Buffer | string | null>,
    opts: { parents?: string[]; baseContents?: Map<string, string> } = {},
  ): string {
    const parentSha = repo.refs.get(ref) ?? null;
    const parents = opts.parents ?? (parentSha === null ? [] : [parentSha]);
    const base = opts.baseContents ?? repo.contents.get(ref) ?? new Map<string, string>();
    const next = new Map<string, string>(base);
    for (const [path, change] of changes) {
      if (change === null) {
        next.delete(path);
      } else if (typeof change === 'string') {
        next.set(path, change);
      } else {
        next.set(path, this.storeBlob(repo, change));
      }
    }
    const treeSha = this.buildTree(repo, next);
    const lines: string[] = [`tree ${treeSha}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    const stamp = `${TRIAL_NOW.epochSec} +0000`;
    const ident = `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${stamp}`;
    lines.push(`author ${ident}`);
    lines.push(`committer ${ident}`);
    lines.push('');
    lines.push(message.endsWith('\n') ? message : `${message}\n`);
    const body = Buffer.from(lines.join('\n'), 'utf8');
    const commitSha = this.storeObject(repo, 'commit', body);
    repo.refs.set(ref, commitSha);
    repo.contents.set(ref, next);
    repo.gitVersion += 1;
    repo.updated_at = TRIAL_NOW.iso;
    repo.pushed_at = TRIAL_NOW.iso;
    return commitSha;
  }

  /** Point a ref at an existing commit, deriving its working tree from the commit's tree. */
  createRef(repo: Repo, ref: string, commitSha: string): boolean {
    const obj = repo.objects.get(commitSha);
    if (obj === undefined || obj.type !== 'commit') return false;
    const treeLine = obj.body.toString('utf8').split('\n')[0] ?? '';
    const treeSha = treeLine.startsWith('tree ') ? treeLine.slice(5).trim() : '';
    if (!/^[0-9a-f]{40}$/.test(treeSha)) return false;
    repo.refs.set(ref, commitSha);
    repo.contents.set(ref, this.treeToContents(repo, treeSha));
    repo.gitVersion += 1;
    return true;
  }

  /** Parse a stored commit object into its message and parent shas. */
  parseCommit(repo: Repo, sha: string): { message: string; parents: string[] } | null {
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') return null;
    const text = obj.body.toString('utf8');
    const sep = text.indexOf('\n\n');
    const header = sep === -1 ? text : text.slice(0, sep);
    let message = sep === -1 ? '' : text.slice(sep + 2);
    if (message.endsWith('\n')) message = message.slice(0, -1);
    const parents: string[] = [];
    for (const line of header.split('\n')) {
      if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    }
    return { message, parents };
  }

  /** First-parent history from a tip, newest first. */
  listCommits(repo: Repo, tipSha: string): { sha: string; message: string }[] {
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    let current: string | null = tipSha;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const parsed = this.parseCommit(repo, current);
      if (parsed === null) break;
      out.push({ sha: current, message: parsed.message });
      current = parsed.parents[0] ?? null;
    }
    return out;
  }

  /**
   * Resolve a `ref` query/body value to a full ref name: a branch name, a
   * full ref, or a commit sha (returned as-is when the object exists).
   */
  resolveRef(repo: Repo, value: string | undefined, defaultBranch: string): string | null {
    const wanted = value ?? defaultBranch;
    if (repo.refs.has(wanted)) return wanted;
    const asBranch = refName(wanted);
    if (repo.refs.has(asBranch)) return asBranch;
    if (/^[0-9a-f]{40}$/i.test(wanted) && repo.objects.has(wanted.toLowerCase())) return wanted.toLowerCase();
    return null;
  }
}

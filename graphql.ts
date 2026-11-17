// GraphQL v4 (M3): POST /api/graphql, single + batched operations.
//
// This is NOT a general GraphQL engine: it implements exactly the documents
// in spec-graphql-mcp.md — the queries/mutations of §2 plus __type
// introspection probes — with a small recursive-descent parser for the
// GraphQL syntax those documents use (variables, aliases, inline fragments,
// inline enums / input objects / lists / null).
//
// Auth: Bearer required exactly as REST (missing/wrong -> HTTP 401).
// Unknown field -> HTTP 200 with errors[] naming the field. Unknown
// repository -> data.repository = null with NO errors. Every mutation acts
// on the same store as REST (see ops.ts) and is instantly visible over REST.
//
// Determinism: no wall clock / randomness; global ids are stable base64
// encodings (ops.ts); cursors encode a list offset.

import type { Ctx, Resp, Router } from './http.ts';
import { errJson } from './http.ts';
import { TRIAL_NOW, VIEWER_LOGIN, refName, type Issue, type Pull, type Repo, type Store } from './store.ts';
import {
  addCommentInStore,
  commentGlobalId,
  createIssueInStore,
  createPullInStore,
  decodeGlobalId,
  findIssueByGlobalId,
  findPullByGlobalId,
  findRepoByGlobalId,
  isBearerAuthed,
  issueGlobalId,
  mergePullInStore,
  pullGlobalId,
  repoGlobalId,
} from './ops.ts';

// -- tokenizer ----------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          if (esc === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('Unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if ('!$&():=[]{}|@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

// -- AST ----------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Map<string, ValueNode | null>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected "${value}" in GraphQL document`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('Expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variables: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('Expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        const type = token.value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.next().value;
        const variables = new Map<string, ValueNode | null>();
        if (this.acceptPunct('(')) {
          while (!this.acceptPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            let defaultValue: ValueNode | null = null;
            if (this.acceptPunct('=')) defaultValue = this.parseValue();
            variables.set(varName, defaultValue);
          }
        }
        this.skipDirectives();
        operations.push({ type, name, variables, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`Unexpected token ${JSON.stringify(token.value)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  /** Consume a type reference (Name, [..], !) without interpreting it. */
  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek() !== undefined && this.peek()!.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.expectName();
      if (this.peek() !== undefined && this.peek()!.kind === 'punct' && this.peek()!.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          else if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('Unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (next !== undefined && next.kind === 'name') {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push(this.parseField());
    }
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    const next = this.peek();
    if (next !== undefined && next.kind === 'punct' && next.value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.acceptPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(token.value)}`);
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

// -- schema (field lists: introspection + validation) -------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const SEARCH_TYPE_VALUES = ['COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'];

// -- object wrappers -----------------------------------------------------------

type GqlObject = { __typename: string; [key: string]: unknown };

function repoObj(repo: Repo): GqlObject {
  return { __typename: 'Repository', _repo: repo };
}

function issueObj(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', _repo: repo, _issue: issue };
}

function pullObj(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull };
}

function commentObj(repo: Repo, issue: Issue, comment: { id: number; body: string; created_at: string; updated_at: string }): GqlObject {
  return { __typename: 'IssueComment', _repo: repo, _issue: issue, _comment: comment };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return 0;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const match = /^offset:(\d+)$/.exec(text);
    if (match !== null) return Number.parseInt(match[1]!, 10);
  } catch {
    return 0;
  }
  return 0;
}

interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function paginate<T>(items: T[], first: unknown, after: unknown): Page<T> {
  const start = decodeCursor(after);
  const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.floor(first)) : items.length;
  const nodes = items.slice(start, start + limit);
  const end = start + nodes.length;
  return {
    nodes,
    hasNextPage: end < items.length,
    endCursor: nodes.length > 0 ? encodeCursor(end) : null,
  };
}

function pageInfoObj(page: Page<unknown>): GqlObject {
  return { __typename: 'PageInfo', _hasNextPage: page.hasNextPage, _endCursor: page.endCursor };
}

function sortIssues(items: Issue[], orderBy: unknown): Issue[] {
  const out = [...items];
  if (orderBy === null || typeof orderBy !== 'object') return out.sort((a, b) => a.seq - b.seq);
  const order = orderBy as { field?: unknown; direction?: unknown };
  const dir = order.direction === 'ASC' ? 1 : -1;
  const field = order.field;
  if (field === 'COMMENTS') {
    return out.sort((a, b) => (a.comments.length - b.comments.length) * dir || (a.seq - b.seq) * dir);
  }
  // CREATED_AT / UPDATED_AT (and default): insertion order, ties by number.
  return out.sort((a, b) => (a.seq - b.seq) * dir);
}

function mergeableOf(repo: Repo, pull: Pull): string {
  const baseRef = refName(pull.baseRef);
  const currentBaseContents = repo.contents.get(baseRef) ?? new Map<string, string>();
  for (const file of pull.files) {
    const baseBlob = pull.baseContents.get(file.filename);
    const currentBlob = currentBaseContents.get(file.filename);
    if (currentBlob !== baseBlob && file.headBlobSha !== baseBlob) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// -- resolvers ------------------------------------------------------------------

type Resolver = (obj: GqlObject, args: Record<string, unknown>, store: Store) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __typename: 'User', _login: VIEWER_LOGIN }),
    repository: (_obj, args, store) => {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = store.getRepo(owner, name);
      return repo === null ? null : repoObj(repo);
    },
    node: (_obj, args, store) => {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.type === 'Repository') {
        const repo = store.getRepo(decoded.owner, decoded.repo);
        return repo === null ? null : repoObj(repo);
      }
      if (decoded.type === 'Issue' && decoded.number !== null) {
        const found = findIssueByGlobalId(store, id);
        return found === null ? null : issueObj(found.repo, found.issue);
      }
      if (decoded.type === 'PullRequest' && decoded.number !== null) {
        const found = findPullByGlobalId(store, id);
        return found === null ? null : pullObj(found.repo, found.pull);
      }
      return null;
    },
    __type: (_obj, args) => {
      const name = args.name;
      if (typeof name !== 'string') return null;
      if (TYPE_FIELDS[name] === undefined && name !== 'SearchType') return null;
      return { __typename: '__Type', _typeName: name };
    },
  },
  Mutation: {
    createIssue: (_obj, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(store, input.repositoryId) : null;
      if (repo === null) throw new Error('Repository not found');
      if (typeof input.title !== 'string' || input.title === '') throw new Error('title is required');
      const issue = createIssueInStore(store, repo, input.title, typeof input.body === 'string' ? input.body : '');
      return { __typename: 'CreateIssuePayload', _issue: issueObj(repo, issue) };
    },
    closeIssue: (_obj, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.issueId === 'string' ? findIssueByGlobalId(store, input.issueId) : null;
      if (found === null) throw new Error('Issue not found');
      found.issue.state = 'closed';
      found.issue.updated_at = TRIAL_NOW.iso;
      return { __typename: 'CloseIssuePayload', _issue: issueObj(found.repo, found.issue) };
    },
    createPullRequest: (_obj, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(store, input.repositoryId) : null;
      if (repo === null) throw new Error('Repository not found');
      const head = input.headRefName;
      const base = input.baseRefName;
      const title = input.title;
      if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
        throw new Error('headRefName, baseRefName and title are required');
      }
      const created = createPullInStore(store, repo, title, typeof input.body === 'string' ? input.body : '', head, base);
      if ('error' in created) throw new Error(created.error);
      return { __typename: 'CreatePullRequestPayload', _pull: pullObj(repo, created.pull) };
    },
    mergePullRequest: (_obj, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(store, input.pullRequestId) : null;
      if (found === null) throw new Error('Pull request not found');
      const merged = mergePullInStore(store, found.repo, found.pull);
      if (!merged.ok) throw new Error(merged.reason);
      return { __typename: 'MergePullRequestPayload', _pull: pullObj(found.repo, found.pull) };
    },
    addComment: (_obj, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(store, input.subjectId) : null;
      if (found === null) throw new Error('Subject not found');
      if (typeof input.body !== 'string') throw new Error('body is required');
      const comment = addCommentInStore(store, found.repo, found.issue, input.body);
      return {
        __typename: 'AddCommentPayload',
        _edge: { __typename: 'IssueCommentEdge', _comment: commentObj(found.repo, found.issue, comment) },
      };
    },
  },
  User: {
    login: (obj) => obj._login as string,
  },
  Repository: {
    id: (obj) => repoGlobalId(obj._repo as Repo),
    databaseId: (obj) => (obj._repo as Repo).id,
    name: (obj) => (obj._repo as Repo).name,
    nameWithOwner: (obj) => {
      const repo = obj._repo as Repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: (obj) => ({ __typename: 'User', _login: (obj._repo as Repo).owner }),
    defaultBranchRef: (obj) => {
      const repo = obj._repo as Repo;
      return repo.refs.has(refName(repo.default_branch)) ? { __typename: 'Ref', _name: repo.default_branch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (obj) => (obj._repo as Repo).description,
    issue: (obj, args) => {
      const repo = obj._repo as Repo;
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : issueObj(repo, issue);
    },
    issues: (obj, args) => {
      const repo = obj._repo as Repo;
      let items = [...repo.issues];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        items = items.filter((issue) => wanted.has(issue.state));
      }
      items = sortIssues(items, args.orderBy ?? null);
      const page = paginate(items, args.first, args.after ?? null);
      return {
        __typename: 'IssueConnection',
        _nodes: page.nodes.map((issue) => issueObj(repo, issue)),
        _pageInfo: pageInfoObj(page as Page<unknown>),
        _totalCount: items.length,
      };
    },
    pullRequests: (obj, args) => {
      const repo = obj._repo as Repo;
      const items = [...repo.pulls].sort((a, b) => a.seq - b.seq);
      const page = paginate(items, args.first, args.after ?? null);
      return {
        __typename: 'PullRequestConnection',
        _nodes: page.nodes.map((pull) => pullObj(repo, pull)),
        _pageInfo: pageInfoObj(page as Page<unknown>),
        _totalCount: items.length,
      };
    },
    pullRequest: (obj, args) => {
      const repo = obj._repo as Repo;
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.find((entry) => entry.number === number);
      return pull === undefined ? null : pullObj(repo, pull);
    },
  },
  Ref: {
    name: (obj) => obj._name as string,
  },
  Issue: {
    id: (obj) => issueGlobalId(obj._repo as Repo, obj._issue as Issue),
    number: (obj) => (obj._issue as Issue).number,
    title: (obj) => (obj._issue as Issue).title,
    state: (obj) => issueState(obj._issue as Issue),
    body: (obj) => (obj._issue as Issue).body,
    createdAt: (obj) => (obj._issue as Issue).created_at,
    updatedAt: (obj) => (obj._issue as Issue).updated_at,
  },
  IssueConnection: {
    nodes: (obj) => obj._nodes as unknown[],
    pageInfo: (obj) => obj._pageInfo as GqlObject,
    totalCount: (obj) => obj._totalCount as number,
  },
  PullRequest: {
    id: (obj) => pullGlobalId(obj._repo as Repo, obj._pull as Pull),
    number: (obj) => (obj._pull as Pull).number,
    title: (obj) => (obj._pull as Pull).title,
    body: (obj) => (obj._pull as Pull).body,
    state: (obj) => pullState(obj._pull as Pull),
    merged: (obj) => (obj._pull as Pull).merged,
    headRefName: (obj) => (obj._pull as Pull).headRef,
    baseRefName: (obj) => (obj._pull as Pull).baseRef,
    mergeable: (obj) => mergeableOf(obj._repo as Repo, obj._pull as Pull),
    files: (obj, args) => {
      const pull = obj._pull as Pull;
      const page = paginate(pull.files, args.first, args.after ?? null);
      return {
        __typename: 'PullRequestChangedFileConnection',
        _nodes: page.nodes.map((file) => ({ __typename: 'PullRequestChangedFile', _file: file })),
        _pageInfo: pageInfoObj(page as Page<unknown>),
        _totalCount: pull.files.length,
      };
    },
    createdAt: (obj) => (obj._pull as Pull).created_at,
    updatedAt: (obj) => (obj._pull as Pull).updated_at,
  },
  PullRequestConnection: {
    nodes: (obj) => obj._nodes as unknown[],
    pageInfo: (obj) => obj._pageInfo as GqlObject,
    totalCount: (obj) => obj._totalCount as number,
  },
  PullRequestChangedFileConnection: {
    nodes: (obj) => obj._nodes as unknown[],
    pageInfo: (obj) => obj._pageInfo as GqlObject,
    totalCount: (obj) => obj._totalCount as number,
  },
  PullRequestChangedFile: {
    path: (obj) => (obj._file as Pull['files'][number]).filename,
    additions: (obj) => (obj._file as Pull['files'][number]).additions,
    deletions: (obj) => (obj._file as Pull['files'][number]).deletions,
    changes: (obj) => (obj._file as Pull['files'][number]).changes,
    status: (obj) => (obj._file as Pull['files'][number]).status.toUpperCase(),
  },
  PageInfo: {
    hasNextPage: (obj) => obj._hasNextPage as boolean,
    endCursor: (obj) => obj._endCursor as string | null,
    hasPreviousPage: () => false,
    startCursor: () => null,
  },
  CreateIssuePayload: {
    issue: (obj) => obj._issue as GqlObject,
  },
  CloseIssuePayload: {
    issue: (obj) => obj._issue as GqlObject,
  },
  CreatePullRequestPayload: {
    pullRequest: (obj) => obj._pull as GqlObject,
  },
  MergePullRequestPayload: {
    pullRequest: (obj) => obj._pull as GqlObject,
  },
  AddCommentPayload: {
    commentEdge: (obj) => obj._edge as GqlObject,
  },
  IssueCommentEdge: {
    node: (obj) => obj._comment as GqlObject,
    cursor: (obj) => (obj._comment as GqlObject)._comment !== undefined ? String(((obj._comment as GqlObject)._comment as { id: number }).id) : '',
  },
  IssueComment: {
    id: (obj) => commentGlobalId(obj._repo as Repo, obj._issue as Issue, (obj._comment as { id: number }).id),
    body: (obj) => (obj._comment as { body: string }).body,
    createdAt: (obj) => (obj._comment as { created_at: string }).created_at,
    updatedAt: (obj) => (obj._comment as { updated_at: string }).updated_at,
  },
  __Type: {
    name: (obj) => obj._typeName as string,
    kind: (obj) => ((obj._typeName as string) === 'SearchType' ? 'ENUM' : 'OBJECT'),
    fields: (obj) => {
      const name = obj._typeName as string;
      if (name === 'SearchType') return null;
      const fields = TYPE_FIELDS[name];
      if (fields === undefined) return null;
      return fields.map((field) => ({ __typename: '__Field', _name: field }));
    },
    enumValues: (obj) => {
      const name = obj._typeName as string;
      if (name !== 'SearchType') return null;
      return SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue', _name: value }));
    },
    description: () => null,
  },
  __Field: {
    name: (obj) => obj._name as string,
    description: () => null,
  },
  __EnumValue: {
    name: (obj) => obj._name as string,
    description: () => null,
  },
};

// -- execution ------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: (string | number)[];
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: GqlError[];
}

function executeSelectionSet(
  ctx: ExecContext,
  typeName: string,
  obj: GqlObject,
  selections: SelectionNode[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const merged = executeSelectionSet(ctx, typeName, obj, selection.selectionSet, path);
      Object.assign(out, merged);
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== typeName) continue;
      const merged = executeSelectionSet(ctx, typeName, obj, fragment.selectionSet, path);
      Object.assign(out, merged);
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    const fieldPath = [...path, responseKey];
    if (field.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const allowed = TYPE_FIELDS[typeName];
    if (allowed === undefined || !allowed.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path: fieldPath });
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[field.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path: fieldPath });
      continue;
    }
    let value: unknown;
    try {
      value = resolver(obj, evalArgs(field, ctx.variables), ctx.store);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = executeFieldValue(ctx, value, field.selectionSet, fieldPath);
  }
  return out;
}

function executeFieldValue(ctx: ExecContext, value: unknown, selectionSet: SelectionNode[] | null, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (selectionSet === null) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => executeFieldValue(ctx, item, selectionSet, [...path, index]));
  }
  if (typeof value === 'object') {
    const obj = value as GqlObject;
    if (typeof obj.__typename !== 'string') return value;
    return executeSelectionSet(ctx, obj.__typename, obj, selectionSet, path);
  }
  return value;
}

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors?: GqlError[];
}

export function executeGraphql(store: Store, query: string, variables: Record<string, unknown>): GqlResult {
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (parsed.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation provided.' }] };
  }
  const operation = parsed.operations[0]!;
  const ctx: ExecContext = { store, variables, fragments: parsed.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  let data: Record<string, unknown>;
  try {
    data = executeSelectionSet(ctx, rootType, root, operation.selectionSet, []);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const result: GqlResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// -- HTTP handler -----------------------------------------------------------------

function parseOperationBody(body: unknown): { query: unknown; variables: unknown } | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return { query: record.query, variables: record.variables };
}

export function registerGraphqlRoutes(router: Router): void {
  router.add('POST', '/api/graphql', (ctx: Ctx, store: Store): Resp => {
    if (!isBearerAuthed(ctx.headers)) {
      return errJson(401, 'Requires authentication');
    }
    let parsed: unknown;
    try {
      parsed = ctx.rawBody.length === 0 ? null : JSON.parse(ctx.rawBody.toString('utf8'));
    } catch {
      return errJson(400, 'Invalid JSON in request body');
    }
    if (parsed === null) return errJson(400, 'Invalid JSON in request body');
    // Batched operations: an array of 2 operation documents -> 2 results in order.
    if (Array.isArray(parsed)) {
      const results: GqlResult[] = parsed.map((entry) => {
        const op = parseOperationBody(entry);
        if (op === null || typeof op.query !== 'string') {
          return { data: null, errors: [{ message: 'Each batched operation must be an object with a query string.' }] };
        }
        const variables = op.variables !== undefined && op.variables !== null && typeof op.variables === 'object' && !Array.isArray(op.variables)
          ? (op.variables as Record<string, unknown>)
          : {};
        return executeGraphql(store, op.query, variables);
      });
      return { status: 200, body: results };
    }
    const op = parseOperationBody(parsed);
    if (op === null || typeof op.query !== 'string') {
      return { status: 200, body: { data: null, errors: [{ message: 'Request body must contain a query string.' }] } };
    }
    const variables = op.variables !== undefined && op.variables !== null && typeof op.variables === 'object' && !Array.isArray(op.variables)
      ? (op.variables as Record<string, unknown>)
      : {};
    return { status: 200, body: executeGraphql(store, op.query, variables) };
  });
}

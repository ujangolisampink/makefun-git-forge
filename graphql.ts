// GraphQL v4: a small executor for exactly the documents gh / github-mcp-server send
// (see the kit's checks-graphql.ts GRAPHQL_DOCUMENTS). It is not a general engine:
// a lexer + recursive-descent parser for the used subset, then field resolution
// against the store with the schema surface gh feature-detects.

import {
  diffTrees,
  globalId,
  mergeableState,
  parseGlobalId,
  squashMerge,
  treeAtRepo,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// Lexer

type TokenKind = 'name' | 'string' | 'int' | 'punct' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'enum'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string | null; selections: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.value === 'query' || token.value === 'mutation') {
        this.next();
        const operation = token.value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        this.parseVariableDefinitions();
        operations.push({ operation, name, selections: this.parseSelectionSet() });
      } else if (token.value === '{') {
        operations.push({ operation: 'query', name: null, selections: this.parseSelectionSet() });
      } else if (token.value === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition.
        this.next();
        this.expectName();
        if (this.peek().value === 'on') {
          this.next();
          this.expectName();
        }
        this.parseSelectionSet();
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token.value)} in GraphQL document`);
      }
    }
    return operations;
  }

  private parseVariableDefinitions(): void {
    if (this.peek().value !== '(') return;
    this.next();
    while (this.peek().value !== ')') {
      this.expect('$');
      this.expectName();
      this.expect(':');
      this.parseType();
      if (this.peek().value === '=') {
        this.next();
        this.parseValue();
      }
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.expectName();
    }
    if (this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().value === '...') {
        this.next();
        let typeCondition: string | null = null;
        if (this.peek().value === 'on') {
          this.next();
          typeCondition = this.expectName();
        }
        selections.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.peek().value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args: Array<{ name: string; value: ValueNode }> = [];
      if (this.peek().value === '(') {
        this.next();
        while (this.peek().value !== ')') {
          const argName = this.expectName();
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      const sub = this.peek().value === '{' ? this.parseSelectionSet() : [];
      selections.push({ kind: 'field', field: { alias, name, args, selections: sub } });
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.value === 'true') return { kind: 'boolean', value: true };
    if (token.value === 'false') return { kind: 'boolean', value: false };
    if (token.value === 'null') return { kind: 'null' };
    if (token.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek().value !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek().value !== '}') {
        const name = this.expectName();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') return { kind: 'enum', value: token.value };
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'enum':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Schema surface (the fields gh feature-detects and reads)

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'headRef', 'baseRef', 'mergeCommit', 'mergedAt', 'author'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'defaultBranch'];
const QUERY_FIELDS = ['viewer', 'repository', 'node', '__type'];
const MUTATION_FIELDS = ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'];

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_REQUEST_FIELDS,
  Repository: REPOSITORY_FIELDS,
  User: ['id', 'login', 'name', 'email'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PROJECT', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// Execution

type JsonRecord = Record<string, unknown>;

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function fieldError(ctx: ExecContext, type: string, field: string): null {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${type}".` });
  return null;
}

const issueStateOut = (state: 'open' | 'closed'): string => (state === 'open' ? 'OPEN' : 'CLOSED');
function prStateOut(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(repo: Repo, issue: Issue): JsonRecord {
  return {
    __typename: 'Issue',
    __repoName: `${repo.owner}/${repo.name}`,
    id: globalId('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issueStateOut(issue.state),
    body: issue.body,
  };
}

function prNode(repo: Repo, pr: PullRequest): JsonRecord {
  return {
    __typename: 'PullRequest',
    __repoName: `${repo.owner}/${repo.name}`,
    id: globalId('pr', repo.id, pr.number),
    number: pr.number,
    title: pr.title,
    state: prStateOut(pr),
    merged: pr.merged,
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    mergeable: mergeableState(repo, pr),
    body: pr.body,
  };
}

function repoNode(repo: Repo): JsonRecord {
  return {
    __typename: 'Repository',
    __repoName: `${repo.owner}/${repo.name}`,
    id: globalId('repo', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner },
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
  };
}

const issueCursor = (number: number): string => Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function resolveIssues(repo: Repo, args: Record<string, unknown>): JsonRecord {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((issue) => wanted.has(issueStateOut(issue.state)));
  }
  const orderBy = args.orderBy as JsonRecord | undefined;
  const direction = orderBy !== undefined ? String(orderBy.direction ?? 'ASC') : 'ASC';
  list.sort((a, b) => {
    const bySeq = direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq;
    if (bySeq !== 0) return bySeq;
    return direction === 'DESC' ? b.number - a.number : a.number - b.number;
  });
  const after = cursorNumber(args.after);
  if (after !== null) {
    const index = list.findIndex((issue) => issue.number === after);
    if (index >= 0) list = list.slice(index + 1);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return {
    nodes: page.map((issue) => issueNode(repo, issue)),
    pageInfo: {
      hasNextPage: list.length > page.length,
      endCursor: page.length > 0 ? issueCursor(page[page.length - 1]?.number as number) : null,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? issueCursor(page[0]?.number as number) : null,
    },
    totalCount: list.length,
  };
}

function resolvePullRequests(repo: Repo, args: Record<string, unknown>): JsonRecord {
  const list = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
  const first = typeof args.first === 'number' ? args.first : list.length;
  return { nodes: list.slice(0, first).map((pr) => prNode(repo, pr)) };
}

function findRepo(store: Store, source: JsonRecord): Repo | null {
  const nameWithOwner = String(source.__repoName ?? source.nameWithOwner ?? '');
  const [owner, name] = nameWithOwner.split('/');
  if (owner === undefined || name === undefined) return null;
  return store.getRepo(owner, name) ?? null;
}

function findByGlobalId(store: Store, id: unknown): { kind: string; repo: Repo; issue?: Issue; pr?: PullRequest } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  const dbId = Number(parsed.parts[0]);
  const number = Number(parsed.parts[1]);
  for (const repo of store.repos.values()) {
    if (repo.id !== dbId) continue;
    if (parsed.kind === 'repo') return { kind: 'repo', repo };
    if (parsed.kind === 'issue') {
      const issue = repo.issues.get(number);
      if (issue !== undefined) return { kind: 'issue', repo, issue };
    }
    if (parsed.kind === 'pr') {
      const pr = repo.pulls.get(number);
      if (pr !== undefined) return { kind: 'pr', repo, pr };
    }
  }
  return null;
}

function selectFields(
  ctx: ExecContext,
  typeName: string,
  source: JsonRecord | null,
  selections: SelectionNode[],
  allowed: readonly string[],
): JsonRecord | null {
  if (source === null) return null;
  const out: JsonRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName && selection.typeCondition !== source.__typename) continue;
      const sub = selectFields(ctx, typeName, source, selection.selections, allowed);
      if (sub !== null) Object.assign(out, sub);
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (!allowed.includes(field.name)) {
      fieldError(ctx, typeName, field.name);
      out[key] = null;
      continue;
    }
    out[key] = resolveField(ctx, typeName, source, field);
  }
  return out;
}

function selectConnection(ctx: ExecContext, connection: JsonRecord, field: FieldNode): JsonRecord {
  const nodes = (connection.nodes as JsonRecord[]) ?? [];
  const isIssue = nodes.length === 0 || (nodes[0] as JsonRecord).__typename === 'Issue';
  const typeName = isIssue ? 'IssueConnection' : 'PullRequestConnection';
  const allowed = isIssue ? ISSUE_FIELDS : PULL_REQUEST_FIELDS;
  const childType = isIssue ? 'Issue' : 'PullRequest';
  const out: JsonRecord = {};
  for (const selection of field.selections) {
    if (selection.kind === 'fragment') continue;
    const child = selection.field;
    const key = child.alias ?? child.name;
    if (child.name === 'nodes') {
      out[key] = nodes.map((node) => selectFields(ctx, childType, node, child.selections, allowed));
    } else if (child.name === 'pageInfo') {
      const pageInfo = connection.pageInfo as JsonRecord;
      out[key] = selectFields(ctx, 'PageInfo', pageInfo, child.selections, ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor']);
    } else if (child.name === 'totalCount') {
      out[key] = connection.totalCount ?? null;
    } else {
      fieldError(ctx, typeName, child.name);
      out[key] = null;
    }
  }
  return out;
}

function resolveField(ctx: ExecContext, typeName: string, source: JsonRecord, field: FieldNode): unknown {
  const args = argMap(field, ctx.variables);
  const store = ctx.store;

  if (typeName === 'Query') {
    if (field.name === 'viewer') {
      const viewer = store.viewer();
      return selectFields(
        ctx,
        'User',
        { __typename: 'User', login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email },
        field.selections,
        TYPE_FIELDS.User as string[],
      );
    }
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== store.viewer().login) return null;
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return null;
      return selectFields(ctx, 'Repository', repoNode(repo), field.selections, REPOSITORY_FIELDS);
    }
    if (field.name === 'node') {
      const found = findByGlobalId(store, args.id);
      if (found === null) return null;
      if (found.kind === 'repo') return selectFields(ctx, 'Repository', repoNode(found.repo), field.selections, REPOSITORY_FIELDS);
      if (found.kind === 'issue' && found.issue !== undefined) {
        return selectFields(ctx, 'Issue', issueNode(found.repo, found.issue), field.selections, ISSUE_FIELDS);
      }
      if (found.kind === 'pr' && found.pr !== undefined) {
        return selectFields(ctx, 'PullRequest', prNode(found.repo, found.pr), field.selections, PULL_REQUEST_FIELDS);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      const fields = TYPE_FIELDS[name];
      const enums = TYPE_ENUM_VALUES[name];
      const out: JsonRecord = { name, kind: fields !== undefined ? 'OBJECT' : enums !== undefined ? 'ENUM' : 'OBJECT' };
      if (fields !== undefined) out.fields = fields.map((f) => ({ name: f }));
      if (enums !== undefined) out.enumValues = enums.map((e) => ({ name: e }));
      return selectFields(ctx, '__Type', out, field.selections, ['name', 'kind', 'fields', 'enumValues']);
    }
    return fieldError(ctx, 'Query', field.name);
  }

  if (typeName === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as JsonRecord;
      const found = findByGlobalId(store, input.repositoryId);
      if (found === null || found.kind !== 'repo') {
        ctx.errors.push({ message: 'createIssue: unknown repository' });
        return null;
      }
      const repo = found.repo;
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = {
        id: store.nextObjectId(),
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        createdSeq: store.nextSeq(),
        comments: [],
        rev: 1,
      };
      repo.issues.set(number, issue);
      return selectFields(ctx, 'CreateIssuePayload', { issue: issueNode(repo, issue) }, field.selections, ['issue']);
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as JsonRecord;
      const found = findByGlobalId(store, input.issueId);
      if (found === null || found.kind !== 'issue' || found.issue === undefined) {
        ctx.errors.push({ message: 'closeIssue: unknown issue' });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.rev += 1;
      return selectFields(ctx, 'CloseIssuePayload', { issue: issueNode(found.repo, found.issue) }, field.selections, ['issue']);
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as JsonRecord;
      const found = findByGlobalId(store, input.repositoryId);
      if (found === null || found.kind !== 'repo') {
        ctx.errors.push({ message: 'createPullRequest: unknown repository' });
        return null;
      }
      const repo = found.repo;
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) {
        ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
        return null;
      }
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
          ctx.errors.push({ message: 'createPullRequest: a pull request already exists for this head and base' });
          return null;
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pr: PullRequest = {
        id: store.nextObjectId(),
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef,
        baseRef,
        headSha,
        baseSha,
        mergeBaseSha: null,
        createdSeq: store.nextSeq(),
      };
      repo.pulls.set(number, pr);
      return selectFields(ctx, 'CreatePullRequestPayload', { pullRequest: prNode(repo, pr) }, field.selections, ['pullRequest']);
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as JsonRecord;
      const found = findByGlobalId(store, input.pullRequestId);
      if (found === null || found.kind !== 'pr' || found.pr === undefined) {
        ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
        return null;
      }
      const result = squashMerge(store, found.repo, found.pr);
      if ('error' in result) {
        ctx.errors.push({ message: `mergePullRequest: ${result.error}` });
        return null;
      }
      return selectFields(ctx, 'MergePullRequestPayload', { pullRequest: prNode(found.repo, found.pr) }, field.selections, ['pullRequest']);
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as JsonRecord;
      const found = findByGlobalId(store, input.subjectId);
      if (found === null || found.kind !== 'issue' || found.issue === undefined) {
        ctx.errors.push({ message: 'addComment: unknown subject' });
        return null;
      }
      const comment = { id: store.nextCommentId(), body: String(input.body ?? ''), createdSeq: store.nextSeq() };
      found.issue.comments.push(comment);
      found.issue.rev += 1;
      const node: JsonRecord = {
        id: globalId('comment', found.repo.id, found.issue.number, comment.id),
        body: comment.body,
      };
      const nodeSelection = field.selections.find((s) => s.kind === 'field' && s.field.name === 'node');
      if (nodeSelection !== undefined && nodeSelection.kind === 'field') {
        return {
          commentEdge: {
            node: selectFields(ctx, 'Comment', node, nodeSelection.field.selections, ['id', 'body']),
          },
        };
      }
      return { commentEdge: { node } };
    }
    return fieldError(ctx, 'Mutation', field.name);
  }

  if (typeName === 'Repository') {
    if (field.name === 'owner') {
      const owner = source.owner as JsonRecord;
      return selectFields(ctx, 'User', owner, field.selections, TYPE_FIELDS.User as string[]);
    }
    if (field.name === 'defaultBranchRef') {
      const ref = source.defaultBranchRef as JsonRecord | null;
      if (ref === null) return null;
      return selectFields(ctx, 'Ref', ref, field.selections, ['name']);
    }
    if (field.name === 'issue') {
      const repo = findRepo(store, source);
      if (repo === null) return null;
      const issue = repo.issues.get(Number(args.number));
      if (issue === undefined) return null;
      return selectFields(ctx, 'Issue', issueNode(repo, issue), field.selections, ISSUE_FIELDS);
    }
    if (field.name === 'issues') {
      const repo = findRepo(store, source);
      if (repo === null) return null;
      return selectConnection(ctx, resolveIssues(repo, args), field);
    }
    if (field.name === 'pullRequests') {
      const repo = findRepo(store, source);
      if (repo === null) return null;
      return selectConnection(ctx, resolvePullRequests(repo, args), field);
    }
    if (field.name === 'pullRequest') {
      const repo = findRepo(store, source);
      if (repo === null) return null;
      const pr = repo.pulls.get(Number(args.number));
      if (pr === undefined) return null;
      return selectFields(ctx, 'PullRequest', prNode(repo, pr), field.selections, PULL_REQUEST_FIELDS);
    }
    // Scalar fields were placed on the node object by repoNode.
    return source[field.name] ?? null;
  }

  if (typeName === 'PullRequest') {
    if (field.name === 'files') {
      const repo = findRepo(store, source);
      if (repo === null) return { nodes: [] };
      const pr = repo.pulls.get(Number(source.number));
      if (pr === undefined) return { nodes: [] };
      const headTree = treeAtRepo(repo, pr.headSha);
      const baseTree = pr.mergeBaseSha === null ? treeAtRepo(repo, pr.baseSha) : treeAtRepo(repo, pr.mergeBaseSha);
      const changes = diffTrees(repo, baseTree, headTree);
      const first = typeof args.first === 'number' ? args.first : changes.length;
      return { nodes: changes.slice(0, first).map((change) => ({ path: change.filename })) };
    }
    return source[field.name] ?? null;
  }

  // Leaf / payload types: fields, enumValues, nodes, pageInfo, issue, pullRequest,
  // commentEdge, and plain scalars all resolve off the source object.
  if (field.name === 'fields' || field.name === 'enumValues') {
    const list = source[field.name];
    if (!Array.isArray(list)) return null;
    return list.map((entry) => selectFields(ctx, '__Field', entry as JsonRecord, field.selections, ['name']));
  }
  if (field.name === 'nodes') {
    const nodes = (source.nodes as JsonRecord[]) ?? [];
    const isIssue = nodes.length === 0 || (nodes[0] as JsonRecord).__typename === 'Issue';
    const allowed = isIssue ? ISSUE_FIELDS : PULL_REQUEST_FIELDS;
    const childType = isIssue ? 'Issue' : 'PullRequest';
    return nodes.map((node) => selectFields(ctx, childType, node, field.selections, allowed));
  }
  if (field.name === 'pageInfo') {
    const pageInfo = source.pageInfo as JsonRecord;
    return selectFields(ctx, 'PageInfo', pageInfo, field.selections, ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor']);
  }
  if (field.name === 'issue' || field.name === 'pullRequest') {
    const child = source[field.name] as JsonRecord | null | undefined;
    if (child === null || child === undefined) return null;
    const childType = field.name === 'issue' ? 'Issue' : 'PullRequest';
    const allowed = field.name === 'issue' ? ISSUE_FIELDS : PULL_REQUEST_FIELDS;
    return selectFields(ctx, childType, child, field.selections, allowed);
  }
  if (field.name === 'commentEdge') {
    const edge = source.commentEdge as JsonRecord;
    const node = edge.node as JsonRecord;
    const nodeSelection = field.selections.find((s) => s.kind === 'field' && s.field.name === 'node');
    if (nodeSelection !== undefined && nodeSelection.kind === 'field') {
      return { node: selectFields(ctx, 'Comment', node, nodeSelection.field.selections, ['id', 'body']) };
    }
    return { node };
  }
  return source[field.name] ?? null;
}

// ---------------------------------------------------------------------------
// Entry point

export interface GraphQLResult {
  data: unknown;
  errors?: Array<{ message: string }>;
}

function runOne(store: Store, body: JsonRecord): GraphQLResult {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  let operations: OperationNode[];
  try {
    operations = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let operation = operations[0];
  if (operationName !== null) operation = operations.find((op) => op.name === operationName) ?? operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation found' }] };
  const ctx: ExecContext = { store, variables, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const allowed = rootType === 'Mutation' ? MUTATION_FIELDS : QUERY_FIELDS;
  const data = selectFields(ctx, rootType, {}, operation.selections, allowed);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data };
}

/** Run one GraphQL request body ({query, variables}, or an array for batching). */
export function handleGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'Invalid operation' }] };
      return runOne(store, entry as JsonRecord);
    });
  }
  if (body === null || typeof body !== 'object') return { data: null, errors: [{ message: 'Invalid request body' }] };
  return runOne(store, body as JsonRecord);
}

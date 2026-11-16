// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
// The suite probes server/discover first (revision 2026-07-28), falls back to the
// legacy initialize handshake, then calls the six github-mcp-server tools. Tools act
// on the same store as REST and GraphQL.

import {
  globalId,
  squashMerge,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse = Record<string, unknown>;

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

// The six tools, frozen so two tools/list calls answer the same list byte for byte.
const TOOLS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'Short description of the repository.' },
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
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
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
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
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
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
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
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
        body: { type: 'string', description: 'Body of the pull request.' },
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
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'number', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

// The suite maps documented arguments onto the schema's nearest property name and
// fills a full_name property with owner/repo, so resolve owner/repo from every
// spelling it may use.
function pickArg(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function repoFromArgs(store: Store, args: Record<string, unknown>): Repo | null {
  let owner = pickArg(args, ['owner', 'owner_login']) as string | undefined;
  let repo = pickArg(args, ['repo', 'repository', 'name']) as string | undefined;
  const fullName = pickArg(args, ['full_name']) as string | undefined;
  if (fullName !== undefined && (owner === undefined || repo === undefined)) {
    const [o, r] = String(fullName).split('/');
    owner = owner ?? o;
    repo = repo ?? r;
  }
  if (owner === undefined || repo === undefined) return null;
  return store.getRepo(owner, repo) ?? null;
}

function toolText(payload: unknown): Array<{ type: string; text: string }> {
  return [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }];
}

function toolResult(payload: unknown): Record<string, unknown> {
  return { content: toolText(payload), structuredContent: payload };
}

function toolError(message: string): Record<string, unknown> {
  return { content: toolText(message), isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  // A server prefix on the name is allowed (github__create_issue): match as a suffix,
  // case-insensitively.
  const base = name.includes('__') ? (name.split('__').pop() as string) : name;
  const canonical = base.toLowerCase();

  if (canonical === 'create_repo') {
    const repoName = pickArg(args, ['name']) as string | undefined;
    if (repoName === undefined) return toolError('Missing required argument: name');
    const repo = store.createRepo(store.viewer().login, repoName, {
      description: pickArg(args, ['description']) as string | undefined,
      private: pickArg(args, ['private']) as boolean | undefined,
    });
    if (repo === null) return toolError(`Repository ${repoName} already exists`);
    return toolResult({
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.private,
      default_branch: repo.defaultBranch,
      description: repo.description,
    });
  }

  if (canonical === 'get_repo') {
    const repo = repoFromArgs(store, args);
    if (repo === null) return toolError('Repository not found');
    return toolResult({
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.private,
      default_branch: repo.defaultBranch,
      description: repo.description,
    });
  }

  if (canonical === 'create_issue') {
    const repo = repoFromArgs(store, args);
    if (repo === null) return toolError('Repository not found');
    const title = pickArg(args, ['title']) as string | undefined;
    if (title === undefined) return toolError('Missing required argument: title');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      id: store.nextObjectId(),
      number,
      title,
      body: (pickArg(args, ['body', 'description']) as string | undefined) ?? '',
      state: 'open',
      labels: [],
      createdSeq: store.nextSeq(),
      comments: [],
      rev: 1,
    };
    repo.issues.set(number, issue);
    return toolResult({
      id: globalId('issue', repo.id, issue.number),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: 'open',
    });
  }

  if (canonical === 'list_issues') {
    const repo = repoFromArgs(store, args);
    if (repo === null) return toolError('Repository not found');
    const state = pickArg(args, ['state']) as string | undefined;
    let issues = [...repo.issues.values()];
    if (state !== undefined && state !== 'all') {
      issues = issues.filter((issue) => issue.state === state);
    }
    issues.sort((a, b) => a.number - b.number);
    return toolResult(
      issues.map((issue) => ({
        id: globalId('issue', repo.id, issue.number),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      })),
    );
  }

  if (canonical === 'create_pull_request') {
    const repo = repoFromArgs(store, args);
    if (repo === null) return toolError('Repository not found');
    const title = pickArg(args, ['title']) as string | undefined;
    const head = pickArg(args, ['head', 'head_ref']) as string | undefined;
    const base = pickArg(args, ['base', 'base_ref']) as string | undefined;
    if (title === undefined) return toolError('Missing required argument: title');
    if (head === undefined) return toolError('Missing required argument: head');
    if (base === undefined) return toolError('Missing required argument: base');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return toolError('Head or base branch does not exist');
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return toolError('A pull request already exists for this head and base');
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pr: PullRequest = {
      id: store.nextObjectId(),
      number,
      title,
      body: (pickArg(args, ['body', 'description']) as string | undefined) ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      mergeBaseSha: null,
      createdSeq: store.nextSeq(),
    };
    repo.pulls.set(number, pr);
    return toolResult({
      id: globalId('pr', repo.id, pr.number),
      number: pr.number,
      title: pr.title,
      state: 'open',
      head: pr.headRef,
      base: pr.baseRef,
    });
  }

  if (canonical === 'merge_pull_request') {
    const repo = repoFromArgs(store, args);
    if (repo === null) return toolError('Repository not found');
    const number = pickArg(args, ['pull_number', 'number']) as number | undefined;
    if (number === undefined) return toolError('Missing required argument: pull_number');
    const pr = repo.pulls.get(Number(number));
    if (pr === undefined) return toolError('Pull request not found');
    const result = squashMerge(store, repo, pr);
    if ('error' in result) return toolError(result.error);
    return toolResult({ number: pr.number, merged: true, sha: result.sha, message: result.message });
  }

  return toolError(`Unknown tool: ${name}`);
}

function dispatch(store: Store, request: JsonRpcRequest): JsonRpcResponse | null {
  const id = request.id ?? null;
  const method = request.method ?? '';
  // Notifications (no id) get no response.
  if (request.id === undefined) return null;

  const result = (payload: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result: payload });
  const error = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });

  if (method === 'server/discover') {
    return result({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'initialize') {
    const params = request.params ?? {};
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const requested =
      typeof meta.protocolVersion === 'string'
        ? meta.protocolVersion
        : typeof params.protocolVersion === 'string'
          ? params.protocolVersion
          : '2026-07-28';
    return result({
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'ping') {
    return result({});
  }

  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const params = request.params ?? {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') return error(-32602, 'Missing tool name');
    const base = name.includes('__') ? (name.split('__').pop() as string) : name;
    const known = TOOLS.some((tool) => String(tool.name).toLowerCase() === base.toLowerCase());
    if (!known) return error(-32602, `Unknown tool: ${name}`);
    return result(callTool(store, name, args));
  }

  return error(-32601, `Method not found: ${method}`);
}

/**
 * Handle a POST /mcp body that has already been parsed as JSON.
 * Returns { status, body } — body null means an empty 202 (notifications only).
 * Parse errors are handled by the caller (app.ts) before this runs.
 */
export function handleMcp(store: Store, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = [];
    for (const entry of body) {
      if (entry === null || typeof entry !== 'object') continue;
      const response = dispatch(store, entry as JsonRpcRequest);
      if (response !== null) responses.push(response);
    }
    return { status: 200, body: responses };
  }
  if (body === null || typeof body !== 'object') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const response = dispatch(store, body as JsonRpcRequest);
  if (response === null) return { status: 202, body: null };
  return { status: 200, body: response };
}

/** The JSON-RPC parse-error response (HTTP 400, code -32700) for a non-JSON body. */
export function mcpParseError(): { status: number; body: unknown } {
  return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
}

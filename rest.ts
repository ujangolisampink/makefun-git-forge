// GitHub REST v3: repositories, branches, commits, contents, labels, issues, pulls.
// Shapes follow what the suite's checks assert: exact statuses, JSON bodies with a
// string `message` on errors, pagination via Link rel="next".

import { VIEWER } from './scenario.ts';
import { ZERO_OID, mergeBase, parseCommit, parseTree, type GitObject } from './gitobj.ts';
import {
  commitFile,
  deleteFile,
  diffTrees,
  flattenTree,
  getObject,
  listCommits,
  squashMerge,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
  /** Pre-serialized body: when set, the caller sends this instead of stringifying `json`. */
  raw?: string;
}

const ok = (json: unknown, status = 200, headers?: Record<string, string>): RestResult => ({ status, json, headers });
const err = (status: number, message: string): RestResult => ({ status, json: { message } });
const notFound = (what = 'Not Found'): RestResult => err(404, what);

const isoCache = new Map<number, string>();
function iso(ts: number): string {
  const hit = isoCache.get(ts);
  if (hit !== undefined) return hit;
  const s = new Date(ts * 1000).toISOString();
  if (isoCache.size > 4096) isoCache.clear();
  isoCache.set(ts, s);
  return s;
}

const stripMessage = (m: string): string => (m.endsWith('\n') ? m.slice(0, -1) : m);

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: '',
    url: '',
    created_at: iso(1735689600 + repo.createdSeq),
    updated_at: iso(1735689600 + repo.createdSeq),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    license: null,
    topics: [],
  };
}

// The read workload GETs the same issue 2,000 times: cache its serialized JSON,
// keyed by the issue's mutation counter and the repo's label counter.
const issueCache = new WeakMap<Issue, { rev: number; labelRev: number; text: string }>();

function issueJsonText(repo: Repo, issue: Issue): string {
  const hit = issueCache.get(issue);
  if (hit !== undefined && hit.rev === issue.rev && hit.labelRev === repo.labelRev) return hit.text;
  const text = JSON.stringify({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', id: 0 };
    }),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: iso(1735689600 + issue.createdSeq),
    updated_at: iso(1735689600 + issue.createdSeq),
    comments: issue.comments.length,
    html_url: '',
  });
  issueCache.set(issue, { rev: issue.rev, labelRev: repo.labelRev, text });
  return text;
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return JSON.parse(issueJsonText(repo, issue)) as Record<string, unknown>;
}

function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.state === 'open',
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: iso(1735689600 + pr.createdSeq),
    updated_at: iso(1735689600 + pr.createdSeq),
    html_url: '',
  };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, base: string, path: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const other = [...query.entries()].filter(([k]) => k !== 'page' && k !== 'per_page');
  const qs = (p: number): string => {
    const params = new URLSearchParams([...other, ['per_page', String(perPage)], ['page', String(p)]]);
    return `${base}${path}?${params.toString()}`;
  };
  if (page < totalPages) links.push(`<${qs(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${qs(page - 1)}>; rel="prev"`);
  links.push(`<${qs(1)}>; rel="first"`);
  links.push(`<${qs(totalPages)}>; rel="last"`);
  if (links.length > 0) headers.link = links.join(', ');
  return { page: [...slice], headers };
}

function resolveRef(repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`);
  if (repo.objects.has(ref)) return ref;
  return undefined;
}

function treeAt(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function subtreeAt(repo: Repo, treeOid: string, path: string): string | null {
  if (path === '') return treeOid;
  let current = treeOid;
  for (const segment of path.split('/').filter((s) => s !== '')) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    let next: string | null = null;
    for (const e of parseTree(obj.data)) {
      if (e.name === segment && e.mode === '40000') next = e.oid;
    }
    if (next === null) return null;
    current = next;
  }
  return current;
}

type Body = Record<string, unknown>;
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asBoolean = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** Route one REST request. `segments` are the decoded path parts after /api/v3. */
export function routeRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Body | null,
  base: string,
): RestResult {
  const viewer = store.viewer();

  if (segments.length === 0) {
    if (method === 'GET') {
      return ok(
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        200,
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return notFound();
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method === 'GET') return ok({ installed_version: '1.0.0' });
    return notFound();
  }
  if (segments.length === 1 && segments[0] === 'user') {
    if (method === 'GET') {
      return ok({ login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email, type: 'User' });
    }
    return notFound();
  }

  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const { page, headers } = paginate(
        store.listRepos(viewer.login).map((repo) => repoJson(repo)),
        query,
        base,
        '/api/v3/user/repos',
      );
      return ok(page, 200, headers);
    }
    if (method === 'POST') {
      const name = asString(body?.name);
      if (name === '') return err(422, 'Repository name is required');
      const created = store.createRepo(viewer.login, name, {
        description: asString(body?.description),
        private: asBoolean(body?.private, false),
      });
      if (created === null) return err(422, 'Repository already exists');
      return ok(repoJson(created), 201);
    }
    return notFound();
  }

  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const repoName = segments[2] as string;
    const repo = store.getRepo(owner, repoName);
    if (owner !== viewer.login) return notFound('Not Found');
    if (repo === undefined) return notFound('Not Found');
    const rest = segments.slice(3);
    const repoPath = `/api/v3/repos/${owner}/${repoName}`;

    if (rest.length === 0) {
      if (method === 'GET') return ok(repoJson(repo));
      if (method === 'PATCH') {
        if (body !== null && 'description' in body) repo.description = asString(body.description);
        return ok(repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return { status: 204, json: null };
      }
      return notFound();
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((n) => n.startsWith('refs/heads/'))
          .map((n) => ({ name: n.slice('refs/heads/'.length), commit: { sha: repo.refs.get(n) }, protected: false }));
        return ok(list);
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (sha === undefined) return notFound('Branch not found');
        return ok({ name: rest[1], commit: { sha }, protected: false });
      }
      return notFound();
    }

    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const tip = resolveRef(repo, query.get('sha'));
      if (tip === undefined) return notFound('No commit found for this ref');
      const commits = listCommits(repo, tip).map((entry) => {
        const obj = repo.objects.get(entry.sha) as GitObject;
        const parsed = parseCommit(obj.data);
        const author = parsed.author.replace(/ \d+ [+-]\d{4}$/, '');
        return {
          sha: entry.sha,
          commit: {
            message: stripMessage(parsed.message),
            author: { name: author, email: viewer.email, date: '' },
            committer: { name: author, email: viewer.email, date: '' },
          },
          author: { login: viewer.login },
          committer: { login: viewer.login },
        };
      });
      return ok(commits);
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = asString(body?.ref);
        const sha = asString(body?.sha);
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) return err(422, 'Invalid ref or sha');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha.toLowerCase());
        return ok({ ref, object: { sha: sha.toLowerCase() } }, 201);
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return notFound('Reference not found');
        return ok({ ref, object: { sha } });
      }
      return notFound();
    }

    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'GET') {
        const tip = resolveRef(repo, query.get('ref'));
        if (tip === undefined) return notFound('Not Found');
        const tree = treeAt(repo, tip);
        if (tree === null) return notFound('Not Found');
        const files = flattenTree(repo, tree);
        if (files.has(filePath)) {
          const file = files.get(filePath) as { oid: string; mode: string };
          const blob = repo.objects.get(file.oid) as GitObject;
          return ok({
            type: 'file',
            encoding: 'base64',
            content: blob.data.toString('base64'),
            sha: file.oid,
            size: blob.data.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
          });
        }
        const dirTree = subtreeAt(repo, tree, filePath);
        if (dirTree === null) return notFound('Not Found');
        const dirObj = repo.objects.get(dirTree) as GitObject;
        const entries = parseTree(dirObj.data).map((entry) => {
          const isDir = entry.mode === '40000';
          const child = repo.objects.get(entry.oid);
          return {
            type: isDir ? 'dir' : 'file',
            name: entry.name,
            path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
            sha: entry.oid,
            ...(isDir ? {} : { size: child?.data.length ?? 0 }),
          };
        });
        return ok(entries);
      }
      if (method === 'PUT') {
        const message = asString(body?.message) || 'commit';
        const contentB64 = asString(body?.content);
        if (contentB64 === '') return err(422, 'Content is required');
        const content = Buffer.from(contentB64, 'base64');
        const branch = asString(body?.branch) || repo.defaultBranch;
        const sha = asString(body?.sha);
        const branchRef = `refs/heads/${branch}`;
        const tip = repo.refs.get(branchRef);
        if (tip !== undefined) {
          const tree = treeAt(repo, tip) as string;
          const files = flattenTree(repo, tree);
          const existing = files.get(filePath);
          if (existing !== undefined && (sha === '' || sha.toLowerCase() !== existing.oid)) {
            return err(409, 'The blob sha does not match the current file');
          }
          const { commitSha, contentSha } = commitFile(store, repo, branch, filePath, content, message);
          const existed = existing !== undefined;
          return ok(
            {
              content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: contentSha, size: content.length, type: 'file', encoding: 'base64' },
              commit: { sha: commitSha, message },
            },
            existed ? 200 : 201,
          );
        }
        if (repo.refs.size > 0) {
          const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (defaultTip !== undefined) repo.refs.set(branchRef, defaultTip);
        }
        const { commitSha, contentSha } = commitFile(store, repo, branch, filePath, content, message);
        return ok(
          {
            content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: contentSha, size: content.length, type: 'file', encoding: 'base64' },
            commit: { sha: commitSha, message },
          },
          201,
        );
      }
      if (method === 'DELETE') {
        const message = asString(body?.message) || 'delete';
        const sha = asString(body?.sha);
        const branch = asString(body?.branch) || repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return notFound('Not Found');
        const tree = treeAt(repo, tip) as string;
        const files = flattenTree(repo, tree);
        const existing = files.get(filePath);
        if (existing === undefined) return notFound('Not Found');
        if (sha !== '' && sha.toLowerCase() !== existing.oid) return err(409, 'The blob sha does not match the current file');
        const commitSha = deleteFile(store, repo, branch, filePath, message);
        if (commitSha === null) return notFound('Not Found');
        return ok({ commit: { sha: commitSha, message } });
      }
      return notFound();
    }

    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const name = asString(body?.name);
        if (name === '') return err(422, 'Label name is required');
        const color = asString(body?.color) || 'ededed';
        const existing = repo.labels.get(name);
        if (existing !== undefined) return ok({ name, color: existing.color, id: store.nextObjectId() }, 201);
        repo.labels.set(name, { name, color });
        repo.labelRev += 1;
        return ok({ name, color, id: store.nextObjectId() }, 201);
      }
      if (method === 'GET' && rest.length === 1) {
        return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      }
      return notFound();
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = asString(body?.title);
          if (title === '') return err(422, 'Title is required');
          const rawLabels = Array.isArray(body?.labels) ? (body?.labels as unknown[]) : [];
          const labelNames: string[] = [];
          for (const raw of rawLabels) {
            const name = typeof raw === 'string' ? raw : asString((raw as Body)?.name);
            if (name === '') continue;
            if (!repo.labels.has(name)) return err(422, `Label "${name}" does not exist`);
            labelNames.push(name);
          }
          const number = repo.nextNumber;
          repo.nextNumber += 1;
          const issue: Issue = {
            id: store.nextObjectId(),
            number,
            title,
            body: asString(body?.body),
            state: 'open',
            labels: labelNames,
            createdSeq: store.nextSeq(),
            comments: [],
            rev: 1,
          };
          repo.issues.set(number, issue);
          // Hot path for the write workload: send the cached serialization
          // verbatim instead of stringify -> parse -> stringify again.
          return { status: 201, json: null, raw: issueJsonText(repo, issue) };
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((issue) => issue.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          }
          const { page, headers } = paginate(
            list.map((issue) => issueJson(repo, issue)),
            query,
            base,
            repoPath + '/issues',
          );
          return ok(page, 200, headers);
        }
        return notFound();
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return notFound();
      const issue = repo.issues.get(number);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (issue === undefined) return notFound('Issue not found');
          // Hot path for the read workload: send the cached serialization.
          return { status: 200, json: null, raw: issueJsonText(repo, issue) };
        }
        if (method === 'PATCH') {
          if (issue === undefined) return notFound('Issue not found');
          if (body !== null) {
            if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
          }
          issue.rev += 1;
          return ok(issueJson(repo, issue));
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) return notFound('Issue not found');
        if (method === 'POST') {
          const text = asString(body?.body);
          if (text === '') return err(422, 'Comment body is required');
          const comment = { id: store.nextCommentId(), body: text, createdSeq: store.nextSeq() };
          issue.comments.push(comment);
          issue.rev += 1;
          return ok(
            { id: comment.id, body: comment.body, user: { login: repo.owner, id: VIEWER.id, type: 'User' }, created_at: iso(1735689600 + comment.createdSeq) },
            201,
          );
        }
        if (method === 'GET') {
          return ok(
            issue.comments.map((comment) => ({
              id: comment.id,
              body: comment.body,
              user: { login: repo.owner, id: VIEWER.id, type: 'User' },
              created_at: iso(1735689600 + comment.createdSeq),
            })),
          );
        }
        return notFound();
      }
      return notFound();
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const head = asString(body?.head);
          const base = asString(body?.base);
          const title = asString(body?.title);
          if (head === '' || base === '' || title === '') return err(422, 'head, base and title are required');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined || baseSha === undefined) return err(422, 'Head or base branch does not exist');
          for (const existing of repo.pulls.values()) {
            if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
              return err(422, 'A pull request already exists for this head and base');
            }
          }
          const number = repo.nextNumber;
          repo.nextNumber += 1;
          const pr: PullRequest = {
            id: store.nextObjectId(),
            number,
            title,
            body: asString(body?.body),
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
          pr.mergeBaseSha = mergeBase((oid: string) => getObject(repo, oid), headSha, baseSha);
          repo.pulls.set(number, pr);
          return ok(prJson(repo, pr), 201);
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((pr) => pr.state === state);
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          const { page, headers } = paginate(
            list.map((pr) => prJson(repo, pr)),
            query,
            base,
            repoPath + '/pulls',
          );
          return ok(page, 200, headers);
        }
        return notFound();
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return notFound();
      const pr = repo.pulls.get(number);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (pr === undefined) return notFound('Pull request not found');
          return ok(prJson(repo, pr));
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pr === undefined) return notFound('Pull request not found');
        const headTree = treeAt(repo, pr.headSha);
        const baseTree = pr.mergeBaseSha === null ? treeAt(repo, pr.baseSha) : treeAt(repo, pr.mergeBaseSha);
        const changes = diffTrees(repo, baseTree, headTree);
        return ok(
          changes.map((change) => ({
            filename: change.filename,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.changes,
            sha: change.newOid ?? change.oldOid ?? ZERO_OID,
          })),
        );
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pr === undefined) return notFound('Pull request not found');
        const result = squashMerge(store, repo, pr);
        if ('error' in result) {
          if (result.error === 'already-merged') return err(405, 'Pull request is already merged or closed');
          return err(405, 'Merge conflict');
        }
        return ok({ sha: result.sha, merged: true, message: `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}` });
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}

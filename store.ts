// In-memory forge state. A trial is one process and the suite sends byte-identical
// requests in live and replay runs, so in-memory state replays exactly. No wall clock
// and no unseeded randomness in anything a response carries: timestamps come from a
// deterministic counter starting at a fixed epoch, so two runs behave identically.
// (The suite never restarts the entry mid-trial, so on-disk persistence is not
// exercised; objects live in memory keyed by SHA-1, exactly as loose objects would be.)

import { VIEWER, type ScenarioUser } from './scenario.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  fullClosure,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './gitobj.ts';

export const DEFAULT_BRANCH = 'main';
const CLOCK_EPOCH = 1735689600; // 2025-01-01T00:00:00Z; one tick per created object.

export interface Label {
  name: string;
  color: string;
}
export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: Comment[];
  /** Bumped on any mutation of this issue; drives the REST JSON cache. */
  rev: number;
}
export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string | null;
  createdSeq: number;
}
export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  /** Bumped when a label is added; part of the issue-JSON cache key. */
  labelRev: number;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** Opaque, stable Relay-style global ids (never the plain database id or number). */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '') return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  private clock = CLOCK_EPOCH;
  private seq = 0;
  private repoSeq = 5000;
  private objectIdSeq = 100000;
  private commentSeq = 200000;
  private requestSeq = 0;

  tick(): number {
    this.clock += 1;
    return this.clock;
  }
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }
  nextObjectId(): number {
    this.objectIdSeq += 1;
    return this.objectIdSeq;
  }
  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }
  viewer(): ScenarioUser {
    return VIEWER;
  }
  iso(ts: number): string {
    return new Date(ts * 1000).toISOString();
  }

  createRepo(owner: string, name: string, input: { description?: string; private?: boolean }): Repo | null {
    const key = repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner,
      description: input.description ?? '',
      private: input.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      labelRev: 0,
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repoSeq += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Git helpers on a repo

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** The root tree oid of a commit, or null when the oid is not a commit. */
export function treeAtRepo(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Store an object, hashing it (skipped when the caller already knows the oid). */
export function putObject(repo: Repo, type: ObjectType, data: Buffer, knownOid?: string): string {
  const oid = knownOid ?? hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const obj = getObject(repo, commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Flatten a tree into path -> {oid, mode}, recursively. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, v] of flattenTree(repo, entry.oid, path)) out.set(p, v);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

function buildTreeFromMap(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i] as string;
      let child = node.dirs.get(seg);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.set(segs[segs.length - 1] as string, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Apply one file change to a tree (null tree = unborn repo); content null deletes. */
export function applyFileToTree(repo: Repo, treeOid: string | null, path: string, content: Buffer | null): string {
  const files = treeOid === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, treeOid);
  if (content === null) files.delete(path);
  else files.set(path, { oid: putObject(repo, 'blob', content), mode: '100644' });
  return buildTreeFromMap(repo, files);
}

function identityLine(store: Store): { ts: number; line: string } {
  const ts = store.tick();
  return { ts, line: `${VIEWER.name} <${VIEWER.email}> ${ts} +0000` };
}

export function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; contentSha: string } {
  const ref = `refs/heads/${branch}`;
  const parentOid = repo.refs.get(ref);
  const parentTree = parentOid === undefined ? null : parseCommit((repo.objects.get(parentOid) as GitObject).data).tree;
  const treeOid = applyFileToTree(repo, parentTree, path, content);
  const { ts, line } = identityLine(store);
  void ts;
  const commitSha = putObject(
    repo,
    'commit',
    buildCommit({ tree: treeOid, parents: parentOid === undefined ? [] : [parentOid], author: line, committer: line, message }),
  );
  repo.refs.set(ref, commitSha);
  return { commitSha, contentSha: hashObject('blob', content) };
}

export function deleteFile(store: Store, repo: Repo, branch: string, path: string, message: string): string | null {
  const ref = `refs/heads/${branch}`;
  const parentOid = repo.refs.get(ref);
  if (parentOid === undefined) return null;
  const parentObj = repo.objects.get(parentOid);
  if (parentObj === undefined) return null;
  const files = flattenTree(repo, parseCommit(parentObj.data).tree);
  if (!files.has(path)) return null;
  const treeOid = applyFileToTree(repo, parseCommit(parentObj.data).tree, path, null);
  const { line } = identityLine(store);
  const commitSha = putObject(
    repo,
    'commit',
    buildCommit({ tree: treeOid, parents: [parentOid], author: line, committer: line, message }),
  );
  repo.refs.set(ref, commitSha);
  return commitSha;
}

/** Commits reachable from `tip`, newest first (BFS, parents after children). */
export function listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const queue = [tip];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++] as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    out.push({ sha: oid, message: parsed.message });
    for (const p of parsed.parents) queue.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pull-request diff and merge

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  oldOid: string | null;
  newOid: string | null;
}

function countLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Multiset line diff: lines in new but not old are additions, and vice versa. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const remaining = oldCounts.get(line) ?? 0;
    if (remaining > 0) oldCounts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of oldCounts.values()) deletions += remaining;
  return { additions, deletions };
}

export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = baseTreeOid === null ? new Map() : flattenTree(repo, baseTreeOid);
  const head = headTreeOid === null ? new Map() : flattenTree(repo, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      changes.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1, oldOid: b.oid, newOid: null });
    } else if (b === undefined && h !== undefined) {
      const text = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const additions = Math.max(1, countLines(text).length);
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, oldOid: null, newOid: h.oid });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      changes.push({
        filename: path,
        status: 'modified',
        additions: Math.max(1, additions),
        deletions,
        changes: Math.max(1, additions) + deletions,
        oldOid: b.oid,
        newOid: h.oid,
      });
    }
  }
  return changes;
}

function threeWayTrees(repo: Repo, pr: PullRequest): { ancestor: Map<string, { oid: string; mode: string }>; base: Map<string, { oid: string; mode: string }>; head: Map<string, { oid: string; mode: string }> } | null {
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return null;
  const baseObj = repo.objects.get(baseTip);
  const headObj = repo.objects.get(headTip);
  if (baseObj === undefined || headObj === undefined) return null;
  const mb = mergeBase((oid) => repo.objects.get(oid), headTip, baseTip) ?? pr.mergeBaseSha;
  const ancestorTree = mb === null ? null : parseCommit((repo.objects.get(mb) as GitObject).data).tree;
  return {
    ancestor: ancestorTree === null ? new Map() : flattenTree(repo, ancestorTree),
    base: flattenTree(repo, parseCommit(baseObj.data).tree),
    head: flattenTree(repo, parseCommit(headObj.data).tree),
  };
}

/** Squash-merge a PR onto its base branch. */
export function squashMerge(
  store: Store,
  repo: Repo,
  pr: PullRequest,
): { sha: string; message: string } | { error: 'conflict' | 'already-merged' } {
  if (pr.state !== 'open' || pr.merged) return { error: 'already-merged' };
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { error: 'conflict' };
  const trees = threeWayTrees(repo, pr);
  if (trees === null) return { error: 'conflict' };
  const merged = new Map(trees.base);
  for (const [path, headFile] of trees.head) {
    const anc = trees.ancestor.get(path);
    const base = trees.base.get(path);
    if (anc?.oid !== headFile.oid && anc?.oid !== base?.oid && base?.oid !== headFile.oid) return { error: 'conflict' };
    if (anc?.oid !== headFile.oid) merged.set(path, headFile);
  }
  for (const [path, anc] of trees.ancestor) {
    if (trees.head.has(path)) continue;
    const base = trees.base.get(path);
    if (anc.oid !== base?.oid && base !== undefined) return { error: 'conflict' };
    merged.delete(path);
  }
  const mergedTree = buildTreeFromMap(repo, merged);
  const { ts, line } = identityLine(store);
  const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`;
  const sha = putObject(
    repo,
    'commit',
    buildCommit({ tree: mergedTree, parents: [baseTip], author: line, committer: line, message }),
  );
  repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = store.iso(ts);
  pr.mergeCommitSha = sha;
  return { sha, message };
}

/** Whether a PR would merge cleanly right now (GraphQL `mergeable`). */
export function mergeableState(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pr.state !== 'open') return 'UNKNOWN';
  const trees = threeWayTrees(repo, pr);
  if (trees === null) return 'UNKNOWN';
  for (const [path, headFile] of trees.head) {
    const anc = trees.ancestor.get(path);
    const base = trees.base.get(path);
    if (anc?.oid !== headFile.oid && anc?.oid !== base?.oid && base?.oid !== headFile.oid) return 'CONFLICTING';
  }
  for (const [path, anc] of trees.ancestor) {
    if (trees.head.has(path)) continue;
    const base = trees.base.get(path);
    if (anc.oid !== base?.oid && base !== undefined) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

export { ZERO_OID, collectReachable, fullClosure, isAncestor };

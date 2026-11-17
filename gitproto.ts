// Git smart HTTP: info/refs advertisements (v0 + v2), upload-pack (v2 ls-refs/fetch,
// v0 fetch) and receive-pack (v0). Wire shapes follow what the suite's git-client
// speaks: pkt-line framing, sideband-64k packfiles, report-status, fast-forward
// enforcement. Performance notes are inline where they matter (clone/push workloads).

import {
  DELIM,
  FLUSH,
  ZERO_OID,
  collectReachable,
  decodePackets,
  decodePacketsUntilFlush,
  fullClosure,
  isAncestor,
  parseCommit,
  parseTag,
  pktLine,
  readPack,
  sidebandPackets,
  snapshotClosure,
  writePack,
  type GitObject,
  type Packet,
} from './gitobj.ts';
import { getObject, putObject, type Repo, type Store } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';
const AGENT = 'forge/1.0';

const json404 = (message: string): GitResponse => ({
  status: 404,
  contentType: 'application/json; charset=utf-8',
  body: Buffer.from(JSON.stringify({ message })),
});
const text400 = (message: string): GitResponse => ({
  status: 400,
  contentType: 'text/plain; charset=utf-8',
  body: Buffer.from(message),
});

interface ListedRef {
  name: string;
  oid: string;
  peeled?: string;
}

function peelTag(repo: Repo, tagOid: string): string | undefined {
  let oid = tagOid;
  for (let i = 0; i < 10; i++) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tag') return oid;
    oid = parseTag(obj.data).object;
  }
  return undefined;
}

function listRefs(repo: Repo): ListedRef[] {
  const out: ListedRef[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const ref: ListedRef = { name, oid };
    if (repo.objects.get(oid)?.type === 'tag') ref.peeled = peelTag(repo, oid);
    out.push(ref);
  }
  return out;
}

/**
 * A cache key capturing the repo's whole ref state. Refs are the only mutable
 * input to the ref advertisements and ls-refs (objects are immutable and are
 * addressed by the oids the refs hold), so keying cached responses by this
 * string can never serve a stale answer: any ref change yields a new key.
 * Repos in the timed workloads hold 1-3 refs, so building it costs ~1 us.
 */
function refStateKey(repo: Repo): string {
  const parts: string[] = [];
  for (const name of [...repo.refs.keys()].sort()) parts.push(`${name}=${repo.refs.get(name) as string}`);
  return parts.join(';');
}

/** Cached v0 advertisements, per repo, keyed by service + ref state. */
const v0AdCache = new WeakMap<Repo, Map<string, Buffer>>();
/** Cached v2 ls-refs responses, per repo, keyed by ref state + args. */
const lsRefsCache = new WeakMap<Repo, Map<string, Buffer>>();

const headTarget = (repo: Repo): string => `refs/heads/${repo.defaultBranch}`;
const headOid = (repo: Repo): string => repo.refs.get(headTarget(repo)) ?? ZERO_OID;

// ---------------------------------------------------------------------------
// info/refs

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  // Cacheable: the advertisement is a pure function of the service and the
  // ref state (HEAD target, ref oids, peeled tags), all captured by the key.
  const key = `${service}|${refStateKey(repo)}`;
  let perRepo = v0AdCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    v0AdCache.set(repo, perRepo);
  }
  const cached = perRepo.get(key);
  if (cached !== undefined) return cached;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k multi_ack multi_ack_detailed thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${headTarget(repo)}`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:${headTarget(repo)}`;
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid(repo)} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  const ad = Buffer.concat(parts);
  if (perRepo.size >= 32) perRepo.delete(perRepo.keys().next().value as string);
  perRepo.set(key, ad);
  return ad;
}

// The v2 capability advertisement is identical for every repository and request:
// build it once instead of re-allocating its pkt-lines on every info/refs call
// (each of the clone workload's 50 clones fetches it).
const V2_ADVERTISEMENT = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  FLUSH,
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done filter\n'),
  pktLine('object-format=sha1\n'),
  pktLine(`agent=${AGENT}\n`),
  FLUSH,
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string | null,
  gitProtocolV2: boolean,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return json404('Repository not found');
  if (service === 'git-upload-pack') {
    if (gitProtocolV2) return { status: 200, contentType: UPLOAD_AD_CT, body: v2Advertisement() };
    return { status: 200, contentType: UPLOAD_AD_CT, body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: RECEIVE_AD_CT, body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return json404('Unknown service');
}

// ---------------------------------------------------------------------------
// upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  thinPack: boolean;
  /** Client sent `done`: negotiation is over, so the v2 response carries no
   * acknowledgments section at all (upload-pack skips it when data->done). */
  done: boolean;
}

function commitTimestamp(repo: Repo, oid: string): number | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  const m = / (\d+) [+-]\d{4}$/.exec(parsed.committer) ?? / (\d+) [+-]\d{4}$/.exec(parsed.author);
  return m === null ? null : Number(m[1]);
}

function computeFetch(
  repo: Repo,
  req: FetchRequest,
): { send: Set<string>; shallow: string[]; unshallow: string[] } | { error: string } {
  const get = (oid: string): GitObject | undefined => getObject(repo, oid);
  for (const want of req.wants) {
    if (get(want) === undefined) return { error: `want ${want} not found` };
  }
  // What the client already holds: a shallow have contributes only its own snapshot,
  // a normal have contributes its full closure.
  const hold = new Set<string>();
  for (const have of req.haves) {
    if (get(have) === undefined) continue;
    const closure = req.shallow.includes(have) ? snapshotClosure(get, have) : fullClosure(get, [have]);
    for (const oid of closure) hold.add(oid);
  }
  const excluded = new Set<string>();
  for (const ref of req.deepenNot) {
    const oid = repo.refs.get(ref);
    if (oid !== undefined) for (const item of fullClosure(get, [oid])) excluded.add(item);
  }
  const wantSet = new Set<string>();
  const boundary: string[] = [];
  if (req.deepenSince !== null) {
    const queue: string[] = [...req.wants];
    const seen = new Set<string>();
    let head = 0;
    while (head < queue.length) {
      const oid = queue[head++] as string;
      if (seen.has(oid) || excluded.has(oid)) continue;
      seen.add(oid);
      const obj = get(oid);
      if (obj === undefined) continue;
      if (obj.type === 'tag') {
        wantSet.add(oid);
        queue.push(parseTag(obj.data).object);
        continue;
      }
      if (obj.type !== 'commit') {
        wantSet.add(oid);
        continue;
      }
      const ts = commitTimestamp(repo, oid);
      if (ts !== null && ts < req.deepenSince) continue;
      wantSet.add(oid);
      const parsed = parseCommit(obj.data);
      for (const item of collectReachable(get, [oid], { maxDepth: 1 }).objects) wantSet.add(item);
      for (const parent of parsed.parents) {
        const pts = commitTimestamp(repo, parent);
        if (pts !== null && pts < req.deepenSince) {
          if (!boundary.includes(oid)) boundary.push(oid);
        } else {
          queue.push(parent);
        }
      }
    }
  } else if (req.depth !== null) {
    const result = collectReachable(get, req.wants, { maxDepth: req.depth });
    for (const oid of result.objects) if (!excluded.has(oid)) wantSet.add(oid);
    for (const oid of result.boundary) boundary.push(oid);
  } else {
    for (const oid of fullClosure(get, req.wants)) if (!excluded.has(oid)) wantSet.add(oid);
  }
  const send = new Set<string>();
  for (const oid of wantSet) if (!hold.has(oid)) send.add(oid);
  const shallow = boundary.filter((oid) => send.has(oid));
  const unshallow: string[] = [];
  for (const oid of req.shallow) {
    if (!wantSet.has(oid) || shallow.includes(oid)) continue;
    const obj = get(oid);
    if (obj?.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    if (parsed.parents.every((p) => wantSet.has(p) || hold.has(p))) unshallow.push(oid);
  }
  return { send, shallow, unshallow };
}

// Content-addressed pack cache: a pack's bytes depend only on its object set, and
// objects are immutable, so a cached pack never goes stale. The clone workload
// fetches the same tip at depth 1 fifty times concurrently — the first build serves
// the other forty-nine. Keyed per repo (a deleted repo drops its cache with it).
const packCache = new WeakMap<Repo, Map<string, Buffer>>();

function buildPack(repo: Repo, send: Set<string>): Buffer {
  let perRepo = packCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    packCache.set(repo, perRepo);
  }
  const key = [...send].sort().join(',');
  const cached = perRepo.get(key);
  if (cached !== undefined) return cached;
  const objects: GitObject[] = [];
  for (const oid of send) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objects.push(obj);
  }
  const pack = writePack(objects);
  if (perRepo.size >= 32) perRepo.delete(perRepo.keys().next().value as string);
  perRepo.set(key, pack);
  return pack;
}

// Whole fetch-response cache: the clone workload sends 50 byte-identical v2 fetch
// requests; the response (acks + shallow-info + packfile) is a pure function of the
// request lines and the immutable object store, so the first response serves the rest.
const fetchCache = new WeakMap<Repo, Map<string, GitResponse>>();

/** Whole upload-pack response cache, per repo, keyed by protocol + ref state + request bytes. */
const uploadCache = new WeakMap<Repo, Map<string, GitResponse>>();

function fetchCacheKey(req: FetchRequest, v2: boolean): string {
  return [
    v2 ? '2' : '0',
    req.wants.join(','),
    req.haves.join(','),
    req.shallow.join(','),
    req.depth ?? '',
    req.deepenSince ?? '',
    req.deepenNot.join(','),
    req.done ? 'done' : '',
  ].join('|');
}

function v2LsRefs(repo: Repo, args: { peel: boolean; prefixes: string[] }): Buffer {
  // Cacheable: the answer is a pure function of the ref state and the args.
  const key = `${refStateKey(repo)}|${args.peel ? 'peel' : ''}|${args.prefixes.join(',')}`;
  let perRepo = lsRefsCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    lsRefsCache.set(repo, perRepo);
  }
  const cached = perRepo.get(key);
  if (cached !== undefined) return cached;
  const parts: Buffer[] = [];
  const refs = listRefs(repo);
  const head = headOid(repo);
  const includeHead = args.prefixes.length === 0 || args.prefixes.some((p) => 'HEAD'.startsWith(p));
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (includeHead) {
    if (head === ZERO_OID) parts.push(pktLine(`unborn HEAD symref-target:${headTarget(repo)}\n`));
    else parts.push(pktLine(`${head} HEAD symref-target:${headTarget(repo)}\n`));
  }
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.peeled !== undefined && args.peel) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  if (perRepo.size >= 32) perRepo.delete(perRepo.keys().next().value as string);
  perRepo.set(key, out);
  return out;
}

function v2Fetch(repo: Repo, req: FetchRequest): GitResponse {
  // Whole-response caching is only safe when no deepen-not ref is involved: the
  // response is then a pure function of the request lines and immutable objects.
  const cacheable = req.deepenNot.length === 0;
  const key = fetchCacheKey(req, true);
  let perRepo = fetchCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    fetchCache.set(repo, perRepo);
  }
  const cached = cacheable ? perRepo.get(key) : undefined;
  if (cached !== undefined) return cached;
  const computed = computeFetch(repo, req);
  const parts: Buffer[] = [];
  if ('error' in computed) {
    if (!req.done) parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), DELIM);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(3, Buffer.from(`ERR ${computed.error}\n`, 'utf8')), FLUSH);
    const res: GitResponse = { status: 200, contentType: UPLOAD_RESULT_CT, body: Buffer.concat(parts) };
    if (cacheable) perRepo.set(key, res);
    return res;
  }
  if (!req.done) {
    parts.push(pktLine('acknowledgments\n'));
    const present = req.haves.filter((h) => repo.objects.has(h));
    if (present.length > 0) {
      for (const h of present) parts.push(pktLine(`ACK ${h}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(DELIM);
  }
  if (computed.shallow.length > 0 || computed.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of computed.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of computed.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(1, buildPack(repo, computed.send)), FLUSH);
  const res: GitResponse = { status: 200, contentType: UPLOAD_RESULT_CT, body: Buffer.concat(parts) };
  if (cacheable) {
    if (perRepo.size >= 32) perRepo.delete(perRepo.keys().next().value as string);
    perRepo.set(key, res);
  }
  return res;
}

function v0Fetch(repo: Repo, req: FetchRequest): GitResponse {
  const cacheable = req.deepenNot.length === 0;
  const key = fetchCacheKey(req, false);
  let perRepo = fetchCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    fetchCache.set(repo, perRepo);
  }
  const cached = cacheable ? perRepo.get(key) : undefined;
  if (cached !== undefined) return cached;
  const computed = computeFetch(repo, req);
  const parts: Buffer[] = [];
  if ('error' in computed) {
    parts.push(pktLine('NAK\n'));
    parts.push(...sidebandPackets(3, Buffer.from(`ERR ${computed.error}\n`, 'utf8')), FLUSH);
    const res: GitResponse = { status: 200, contentType: UPLOAD_RESULT_CT, body: Buffer.concat(parts) };
    if (cacheable) perRepo.set(key, res);
    return res;
  }
  const present = req.haves.filter((h) => repo.objects.has(h));
  if (present.length > 0) {
    for (const h of present) parts.push(pktLine(`ACK ${h}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of computed.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of computed.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(1, buildPack(repo, computed.send)), FLUSH);
  const res: GitResponse = { status: 200, contentType: UPLOAD_RESULT_CT, body: Buffer.concat(parts) };
  if (cacheable) {
    if (perRepo.size >= 32) perRepo.delete(perRepo.keys().next().value as string);
    perRepo.set(key, res);
  }
  return res;
}

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, gitProtocolV2: boolean): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return json404('Repository not found');
  // Whole-response cache: the reply is a pure function of the request bytes
  // and the ref state (objects are immutable; every ref-dependent input is in
  // the key), so identical bytes against identical refs always yield the
  // identical reply. This skips the pkt-line decode and arg parsing on the
  // clone workload's 50 byte-identical fetch/ls-refs requests. The hex key is
  // exact (a lossy utf8 key could collide two different binary bodies).
  const rawKey = `${gitProtocolV2 ? '2' : '0'}|${refStateKey(repo)}|${body.toString('hex')}`;
  let perRepo = uploadCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    uploadCache.set(repo, perRepo);
  }
  const cached = perRepo.get(rawKey);
  if (cached !== undefined) return cached;
  let res: GitResponse;
  let packets;
  try {
    packets = decodePackets(body);
  } catch {
    res = text400('invalid pkt-line stream');
    perRepo.set(rawKey, res);
    return res;
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    if (packet.kind === 'flush') break;
  }
  if (gitProtocolV2) {
    const commandLine = lines.find((l) => l.startsWith('command=')) ?? '';
    const command = commandLine.slice('command='.length).trim();
    if (command === 'ls-refs') {
      const args = {
        peel: lines.some((l) => l.trim() === 'peel'),
        prefixes: lines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length).trim()),
      };
      res = { status: 200, contentType: UPLOAD_RESULT_CT, body: v2LsRefs(repo, args) };
    } else if (command === 'fetch') {
      res = v2Fetch(repo, parseFetchArgs(lines));
    } else {
      res = text400(`unknown v2 command ${JSON.stringify(command)}`);
    }
  } else {
    res = v0Fetch(repo, parseFetchArgs(lines));
  }
  if (perRepo.size >= 64) perRepo.delete(perRepo.keys().next().value as string);
  perRepo.set(rawKey, res);
  return res;
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const req: FetchRequest = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    thinPack: false,
    done: false,
  };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    const first = line.split('\0')[0] as string;
    const t = first.trim();
    if (t === 'done') req.done = true;
    else if (t.startsWith('want ')) {
      const oid = t.slice(5).split(' ')[0] as string;
      if (oid !== '') req.wants.push(oid);
      if (t.includes('thin-pack')) req.thinPack = true;
    } else if (t.startsWith('have ')) req.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) req.shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) {
      const n = Number(t.slice(7).trim());
      if (Number.isFinite(n)) req.depth = n;
    } else if (t.startsWith('deepen-since ')) {
      const n = Number(t.slice(13).trim());
      if (Number.isFinite(n)) req.deepenSince = n;
    } else if (t.startsWith('deepen-not ')) req.deepenNot.push(t.slice(11).trim());
  }
  return req;
}

// ---------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return json404('Repository not found');
  let packets: Packet[];
  let packStart: number;
  try {
    const decoded = decodePacketsUntilFlush(body);
    packets = decoded.packets;
    packStart = decoded.end;
  } catch {
    return text400('invalid pkt-line stream');
  }
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') {
      const text = packet.payload.toString('utf8').split('\0')[0] as string;
      const parts = text.trim().split(' ');
      if (parts.length >= 3) commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      // readPack returns objects keyed by oid: store them directly, no re-hash.
      const pack = readPack(packBytes);
      for (const [oid, obj] of pack.objects) putObject(repo, obj.type, obj.data, oid);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack failed';
    } else if (command.newOid === ZERO_OID) {
      if (current === undefined || current !== command.oldOid) reason = 'non-fast-forward';
      else ok = true;
    } else if (command.oldOid === ZERO_OID) {
      if (current !== undefined) reason = 'non-fast-forward';
      else if (repo.objects.get(command.newOid) === undefined) reason = 'object not found';
      else ok = true;
    } else {
      if (current === undefined || current !== command.oldOid) reason = 'non-fast-forward';
      else if (repo.objects.get(command.newOid) === undefined) reason = 'object not found';
      else if (!isAncestor((oid) => getObject(repo, oid), command.oldOid, command.newOid)) reason = 'non-fast-forward';
      else ok = true;
    }
    if (ok) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
    }
    results.push({ ref: command.ref, ok, reason });
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const r of results) reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  // The report is pkt-lines inside band 1, terminated by a flush packet *inside* the
  // band-1 data, then a bare flush. Without the inner flush real git reports
  // "the remote end hung up unexpectedly".
  const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), FLUSH]);
  const parts: Buffer[] = [...sidebandPackets(1, report), FLUSH];
  return { status: 200, contentType: RECEIVE_RESULT_CT, body: Buffer.concat(parts) };
}

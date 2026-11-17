// Git object layer, pure Node stdlib: SHA-1 ids, blob/tree/commit/tag parse+build,
// reachability, packfile read/write (OFS/REF deltas), pkt-line codec.
// The grading pod has no git binary, so the forge implements this itself.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function hashObject(type: ObjectType, data: Buffer): string {
  return createHash('sha1')
    .update(`${type} ${data.length}\0`, 'ascii')
    .update(data)
    .digest('hex');
}

// Parse results are memoized by buffer identity: the store keeps one Buffer per
// object, and reachability walks re-parse the same commits/trees constantly
// (every push re-walks history for the fast-forward check).
export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}
export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

const commitCache = new WeakMap<Buffer, ParsedCommit>();
const treeCache = new WeakMap<Buffer, TreeEntry[]>();
const tagCache = new WeakMap<Buffer, ParsedTag>();

export function parseCommit(data: Buffer): ParsedCommit {
  const hit = commitCache.get(data);
  if (hit !== undefined) return hit;
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const out: ParsedCommit = { tree, parents, author, committer, message };
  commitCache.set(data, out);
  return out;
}

export function buildCommit(input: { tree: string; parents: readonly string[]; author: string; committer: string; message: string }): Buffer {
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  let text = `tree ${input.tree}\n`;
  for (const p of input.parents) text += `parent ${p}\n`;
  text += `author ${input.author}\ncommitter ${input.committer}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const hit = treeCache.get(data);
  if (hit !== undefined) return hit;
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp === -1 || nul === -1) break;
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  treeCache.set(data, entries);
  return entries;
}

/** Git tree order: a directory compares as if its name ended in '/'. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTag(data: Buffer): ParsedTag {
  const hit = tagCache.get(data);
  if (hit !== undefined) return hit;
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  const out: ParsedTag = { object, type, tag, tagger, message };
  tagCache.set(data, out);
  return out;
}

// ---------------------------------------------------------------------------
// Reachability (queues use a head index, not shift(), so long walks stay linear)

export interface ReachResult {
  objects: Set<string>;
  boundary: string[];
}

export function collectReachable(
  get: (oid: string) => GitObject | undefined,
  tips: readonly string[],
  opts: { maxDepth?: number; exclude?: Set<string> } = {},
): ReachResult {
  const objects = new Set<string>();
  const boundary: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = tips.map((oid) => ({ oid, depth: 0 }));
  let head = 0;
  while (head < queue.length) {
    const { oid, depth } = queue[head++] as { oid: string; depth: number };
    if (opts.exclude?.has(oid)) continue;
    const obj = get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      if (seen.has(oid)) continue;
      seen.add(oid);
      objects.add(oid);
      collectTreeInto(get, parseCommit(obj.data).tree, objects, opts.exclude);
      const atLimit = opts.maxDepth !== undefined && depth >= opts.maxDepth - 1;
      if (atLimit) {
        if (parseCommit(obj.data).parents.length > 0) boundary.push(oid);
        continue;
      }
      for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, depth: depth + 1 });
    } else if (obj.type === 'tag') {
      if (objects.has(oid)) continue;
      objects.add(oid);
      queue.push({ oid: parseTag(obj.data).object, depth });
    } else {
      objects.add(oid);
    }
  }
  return { objects, boundary };
}

function collectTreeInto(
  get: (oid: string) => GitObject | undefined,
  treeOid: string,
  out: Set<string>,
  exclude?: Set<string>,
): void {
  if (out.has(treeOid) || exclude?.has(treeOid)) return;
  const obj = get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  out.add(treeOid);
  for (const e of parseTree(obj.data)) {
    if (exclude?.has(e.oid)) continue;
    if (e.mode === '40000') collectTreeInto(get, e.oid, out, exclude);
    else if (get(e.oid) !== undefined) out.add(e.oid);
  }
}

export function fullClosure(get: (oid: string) => GitObject | undefined, tips: readonly string[]): Set<string> {
  return collectReachable(get, tips).objects;
}

/** A shallow have's snapshot: the commit plus its own tree closure, not ancestors. */
export function snapshotClosure(get: (oid: string) => GitObject | undefined, commitOid: string): Set<string> {
  const out = new Set<string>();
  const obj = get(commitOid);
  if (obj === undefined) return out;
  out.add(commitOid);
  if (obj.type === 'commit') collectTreeInto(get, parseCommit(obj.data).tree, out);
  else if (obj.type === 'tag') {
    const target = parseTag(obj.data).object;
    const t = get(target);
    if (t !== undefined) {
      out.add(target);
      if (t.type === 'commit') collectTreeInto(get, parseCommit(t.data).tree, out);
    }
  }
  return out;
}

export function isAncestor(get: (oid: string) => GitObject | undefined, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++] as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}

export function mergeBase(get: (oid: string) => GitObject | undefined, a: string, b: string): string | null {
  if (a === b) return a;
  const distA = new Map<string, number>();
  const qa: Array<[string, number]> = [[a, 0]];
  let ha = 0;
  while (ha < qa.length) {
    const [oid, d] = qa[ha++] as [string, number];
    if (distA.has(oid)) continue;
    distA.set(oid, d);
    const obj = get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) qa.push([p, d + 1]);
  }
  const seenB = new Set<string>();
  const qb: Array<[string, number]> = [[b, 0]];
  let hb = 0;
  let best: string | null = null;
  let bestScore = Infinity;
  while (hb < qb.length) {
    const [oid, d] = qb[hb++] as [string, number];
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const da = distA.get(oid);
    if (da !== undefined) {
      const score = da + d;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
      continue;
    }
    const obj = get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) qb.push([p, d + 1]);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Packfiles

const TYPE_NUM: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeNum << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) b |= 0x80;
  bytes.push(b);
  while (size > 0) {
    b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Write a pack (version 2, plain objects, no deltas) with a valid trailer checksum.
 * Object order is the caller's (git accepts any order); skipping a hash-sort keeps
 * the clone workload's 600-object pack build cheap. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packObjHeader(TYPE_NUM[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Inflate one pack object starting at `start`. One inflateSync call with
 * `info: true` returns the engine, whose `bytesWritten` is the number of input
 * bytes the stream consumed (zlib header + deflate data + Adler-32 trailer),
 * so the stream end is known without scanning for the checksum and without a
 * second verification inflate: the data itself is exactly what inflateSync
 * produced, and a wrong end would break the next object's parse (or, for the
 * last object, is unused). This halves the inflate calls per pack object
 * versus the previous scan-and-verify approach.
 */
function inflateObject(buf: Buffer, start: number, limit: number, expectedSize: number): { end: number; data: Buffer } {
  const { buffer: data, engine } = inflateSync(buf.subarray(start, limit), { info: true });
  if (data.length !== expectedSize) throw new Error('pack object size mismatch');
  const end = start + (engine as { bytesWritten: number }).bytesWritten;
  if (end > limit || end <= start) throw new Error('zlib stream end not found in pack');
  return { end, data };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos++;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = varint();
  const targetSize = varint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos++;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if ((op & (1 << i)) !== 0) {
          offset |= (delta[pos] as number) << (8 * i);
          pos++;
        }
      }
      for (let i = 0; i < 3; i++) {
        if ((op & (0x10 << i)) !== 0) {
          size |= (delta[pos] as number) << (8 * i);
          pos++;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ReadPackResult {
  version: number;
  declaredCount: number;
  /** Objects keyed by their SHA-1, so the caller can store them without re-hashing. */
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a pack (v2/v3), resolving OFS_DELTA and REF_DELTA; verifies the trailer checksum. */
export function readPack(buf: Buffer): ReadPackResult {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  const declaredCount = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  if (!createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest().equals(trailer)) {
    throw new Error('pack trailer checksum mismatch');
  }
  interface Raw {
    typeNum: number;
    data: Buffer;
    ofsBase?: number;
    refBase?: string;
    offset: number;
  }
  const raw: Raw[] = [];
  let pos = 12;
  let deltaCount = 0;
  for (let i = 0; i < declaredCount; i++) {
    const entryOffset = pos;
    let byte = buf[pos] as number;
    pos++;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[pos] as number;
      pos++;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let ofsBase: number | undefined;
    let refBase: string | undefined;
    if (typeNum === 6) {
      byte = buf[pos] as number;
      pos++;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[pos] as number;
        pos++;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      ofsBase = entryOffset - offset;
      deltaCount++;
    } else if (typeNum === 7) {
      refBase = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      deltaCount++;
    }
    const { end, data } = inflateObject(buf, pos, buf.length - 20, size);
    pos = end;
    raw.push({ typeNum, data, ofsBase, refBase, offset: entryOffset });
  }
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const resolve = (entry: Raw, depth = 0): GitObject => {
    if (depth > 1000) throw new Error('delta cycle');
    const cached = byOffset.get(entry.offset);
    if (cached !== undefined) return cached;
    let resolved: GitObject;
    if (entry.typeNum === 6) {
      const baseEntry = raw.find((c) => c.offset === entry.ofsBase);
      if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry, depth + 1);
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeNum === 7) {
      const baseOid = entry.refBase as string;
      let base = objects.get(baseOid);
      if (base === undefined) {
        const baseEntry = raw.find(
          (c) => c.typeNum <= 4 && hashObject(NUM_TYPE[c.typeNum] as ObjectType, c.data) === baseOid,
        );
        base = baseEntry === undefined ? undefined : resolve(baseEntry, depth + 1);
      }
      if (base === undefined) throw new Error('ref-delta base not in pack');
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      const type = NUM_TYPE[entry.typeNum];
      if (type === undefined) throw new Error(`unknown pack object type ${entry.typeNum}`);
      resolved = { type, data: entry.data };
    }
    byOffset.set(entry.offset, resolved);
    objects.set(hashObject(resolved.type, resolved.data), resolved);
    return resolved;
  };
  for (const entry of raw) resolve(entry);
  return { version, declaredCount, objects, deltaCount };
}

// ---------------------------------------------------------------------------
// pkt-line

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface Packet {
  kind: PacketKind;
  payload: Buffer;
}

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const header = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

export function decodePackets(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line length');
    const length = parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('invalid pkt-line length');
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
    } else {
      if (pos + length > buf.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
      pos += length;
    }
  }
  return packets;
}

/** Decode pkt-lines up to and including the first flush; return the offset just past it.
 * A receive-pack request carries a raw pack after the flush, so the whole body cannot be
 * decoded as pkt-lines ('PACK' is not a hex length). */
export function decodePacketsUntilFlush(buf: Buffer): { packets: Packet[]; end: number } {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line length');
    const length = parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('invalid pkt-line length');
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, end: pos + 4 };
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
    } else {
      if (pos + length > buf.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
      pos += length;
    }
  }
  return { packets, end: pos };
}

/** Split a sideband payload into pkt-lines of at most 65520 bytes total. */
export function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxData = 65520 - 4 - 1;
  for (let offset = 0; offset < data.length; offset += maxData) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxData));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

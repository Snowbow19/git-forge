// Git smart-HTTP (M2): protocol v2 upload-pack (ls-refs / fetch, shallow),
// v0 upload-pack advertisement, and v0 receive-pack (push, fast-forward-only).
//
// Determinism: nothing here reads the wall clock or unseeded randomness.
// Object ids are SHA-1 over canonical bytes; ref updates stamp TRIAL_NOW;
// pack entry order is sorted by oid. Request ids stay the http.ts counter.
//
// Object bytes are stored verbatim (store.ts helpers); this module only
// parses them to walk reachability / ancestry, never rewrites them.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Ctx, Resp, Router } from './http.ts';
import { errJson } from './http.ts';
import {
  TRIAL_NOW,
  gitObjectSha,
  type ObjectType,
  type Repo,
  type Store,
} from './store.ts';

const ZERO_OID = '0'.repeat(40);
const EMPTY_SET: ReadonlySet<string> = new Set<string>();
const PKT_LINE_MAX = 65520;
const HEX40 = /^[0-9a-f]{40}$/;
const MAIN_REF = 'refs/heads/main';

function isOid(value: string): boolean {
  return HEX40.test(value);
}

// -- pkt-line ---------------------------------------------------------------

type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

/** True when `s` is exactly four hex digits (a pkt-line length header). */
function isHex4(s: string): boolean {
  if (s.length !== 4) return false;
  for (let i = 0; i < 4; i += 1) {
    const c = s.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) return false;
  }
  return true;
}

/** Decode every pkt-line in `buf`; throws on a bad header or truncation. */
function decodeAll(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const header = buf.subarray(off, off + 4).toString('ascii');
    if (!isHex4(header)) throw new Error('invalid pkt-line header');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error('invalid pkt-line length');
    if (off + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + length) });
    off += length;
  }
  return packets;
}

/**
 * Decode pkt-lines up to the first flush; the bytes after it are returned
 * untouched (the raw pack in a receive-pack body). Throws if no flush appears.
 */
function decodeUntilFlush(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const header = buf.subarray(off, off + 4).toString('ascii');
    if (!isHex4(header)) throw new Error('invalid pkt-line header');
    const length = Number.parseInt(header, 16);
    if (length === 0) return { packets, rest: buf.subarray(off + 4) };
    if (length === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error('invalid pkt-line length');
    if (off + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + length) });
    off += length;
  }
  throw new Error('pkt-line stream has no flush');
}

/** Split pack bytes into sideband band-1 pkt-lines (≤ 65,520 bytes each). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = PKT_LINE_MAX - 4 - 1; // payload room minus the band byte
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// -- object parsing (read-only walks over verbatim stored bytes) ------------

function parseCommitHeaders(body: Buffer): { tree: string; parents: string[] } {
  const text = body.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

function parseTagTarget(body: Buffer): { object: string; type: string } {
  const text = body.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  let object = '';
  let type = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  return { object, type };
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTreeEntries(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const nul = space === -1 ? -1 : body.indexOf(0x00, space + 1);
    if (space === -1 || nul === -1 || nul + 21 > body.length) throw new Error('malformed tree object');
    entries.push({
      mode: body.subarray(offset, space).toString('ascii'),
      name: body.subarray(space + 1, nul).toString('utf8'),
      oid: body.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Every object reachable from `roots` (commit → tree + parents; tag → target; tree → entries, gitlinks skipped). */
/**
 * Objects reachable from `roots`. Commits listed in `stopAt` are included
 * together with their tree closure, but their parents are NOT followed: a
 * client that holds a shallow boundary has the boundary commit and its
 * files, but not the history below it. `stopAt` is empty for a plain
 * full-closure walk.
 */
function collectReachable(repo: Repo, roots: Iterable<string>, stopAt: ReadonlySet<string> = EMPTY_SET): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommitHeaders(obj.body);
      queue.push(commit.tree);
      if (!stopAt.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (obj.type === 'tag') {
      queue.push(parseTagTarget(obj.body).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTreeEntries(obj.body)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Follow tag objects to the commit they point at (null when not a commit). */
function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTagTarget(obj.body).object;
      continue;
    }
    return null;
  }
}

/** True when `ancestor` (peeled to a commit) is reachable from `descendant`. */
function isAncestor(repo: Repo, ancestorOid: string, descendantOid: string): boolean {
  const ancestor = peelToCommit(repo, ancestorOid);
  const descendant = peelToCommit(repo, descendantOid);
  if (ancestor === null || descendant === null) return false;
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommitHeaders(obj.body).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

// -- packfiles ---------------------------------------------------------------

const PACK_TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a plain-object pack (version 2, correct trailer); entry order is sorted by oid. */
function writePack(repo: Repo, oids: Iterable<string>): Buffer {
  const list = [...oids].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    parts.push(packObjectHeader(obj.type, obj.body.length));
    parts.push(deflateSync(obj.body));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate one zlib stream starting at `offset` (bounded by `end`); returns its bytes and the next offset. */
function inflateAt(pack: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = pack.subarray(offset, end);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib inflate failed at offset ${offset}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/** Apply a git delta instruction stream to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Parse and resolve a packfile (version 2/3, plain objects plus OFS_DELTA and
 * REF_DELTA). Validates the trailer checksum, entry sizes and zlib streams;
 * every returned object is keyed by its recomputed SHA-1. Throws on any defect.
 */
function readPack(pack: Buffer): Map<string, { type: ObjectType; data: Buffer }> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry header is truncated');
    let byte = pack[offset];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = pack[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
      byte = pack[offset];
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        byte = pack[offset];
        offset += 1;
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (PACK_CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, { type: ObjectType; data: Buffer }>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolved = new Map<number, { type: ObjectType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();

  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      let baseEntry = resolvedByOid.get(wanted);
      if (baseEntry === undefined) {
        // The base may appear later in the pack (or be itself deltafied):
        // resolve entries until one yields the wanted oid.
        for (const candidate of raw) {
          if (resolved.has(candidate.offset)) continue;
          const got = resolve(candidate);
          if (got.oid === wanted) {
            baseEntry = candidate;
            break;
          }
        }
      }
      if (baseEntry === undefined) throw new Error(`ref-delta base ${wanted} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = PACK_CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = gitObjectSha(type, data);
    const out = { type, data, oid };
    resolved.set(entry.offset, out);
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };

  for (const entry of raw) {
    const got = resolve(entry);
    if (!objects.has(got.oid)) objects.set(got.oid, { type: got.type, data: got.data });
  }
  return objects;
}

// -- refs / advertisements --------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Peeled target of a tag ref (undefined when the ref does not point at a tag object). */
function peelOid(repo: Repo, refOid: string): string | undefined {
  const obj = repo.objects.get(refOid);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  const target = parseTagTarget(obj.body).object;
  return isOid(target) ? target : undefined;
}

function v0Advertisement(repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(FLUSH);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const mainTip = repo.refs.get(MAIN_REF) ?? ZERO_OID;
    parts.push(pktLine(`${mainTip} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const peeled = peelOid(repo, oid);
      if (peeled !== undefined) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement never changes: build its bytes once and reuse them. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  FLUSH,
  pktLine('version 2\n'),
  pktLine('fetch=shallow\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('object-format=sha1\n'),
  FLUSH,
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

// -- fetch object selection --------------------------------------------------

interface FetchSelection {
  objects: Set<string>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/** Minimum parent-distance from any of `wants` (tags peeled) to every ancestor commit. */
function commitDistances(repo: Repo, wants: Iterable<string>): Map<string, number> {
  const distance = new Map<string, number>();
  const queue: Array<{ oid: string; d: number }> = [];
  let head = 0;
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'commit') queue.push({ oid: want, d: 0 });
    else if (obj.type === 'tag') {
      const target = peelToCommit(repo, want);
      if (target !== null) queue.push({ oid: target, d: 0 });
    }
  }
  while (head < queue.length) {
    const { oid, d } = queue[head];
    head += 1;
    const known = distance.get(oid);
    if (known !== undefined && known <= d) continue;
    distance.set(oid, d);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommitHeaders(obj.body).parents) queue.push({ oid: parent, d: d + 1 });
  }
  return distance;
}

function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  oldShallow: string[],
  depth: number | undefined,
  deepenRelative = false,
): FetchSelection {
  const haveSet = new Set(haves.filter(isOid));
  const oldShallowSet = new Set(oldShallow.filter(isOid));
  // The have-closure must stop at the client's shallow boundaries: a client
  // that holds a boundary has the boundary commit and its files, but NOT
  // the history below it — a plain full closure would claim the client
  // already owns the very commits a deepen fetch is supposed to deliver.
  const haveClosure = collectReachable(repo, haveSet, oldShallowSet);

  // `deepen-relative` (real git's --deepen): the deepen value counts from
  // the client's current shallow boundary, not from the want. The new
  // absolute depth is (distance from the want to its boundary) + 1 + deepen.
  // The suite never sends deepen-relative; its deepen values are absolute.
  if (depth !== undefined && deepenRelative) {
    const distances = commitDistances(repo, wants.filter(isOid));
    let best: number | undefined;
    for (const boundary of oldShallowSet) {
      const d = distances.get(boundary);
      if (d === undefined) continue;
      const candidate = d + 1 + depth;
      if (best === undefined || candidate > best) best = candidate;
    }
    depth = best ?? depth;
  }

  // Objects the client already holds through its shallow boundary: the
  // boundary commit itself plus its tree/blobs (never its parents).
  const shallowHeld = new Set<string>();
  for (const boundary of oldShallowSet) {
    const obj = repo.objects.get(boundary);
    if (obj === undefined) continue;
    shallowHeld.add(boundary);
    if (obj.type === 'commit') {
      for (const oid of collectReachable(repo, [parseCommitHeaders(obj.body).tree])) shallowHeld.add(oid);
    } else if (obj.type === 'tag') {
      shallowHeld.add(parseTagTarget(obj.body).object);
    }
  }

  // BFS over commits from the wants, tracking distance from the nearest want.
  const distance = new Map<string, number>();
  const reached = new Map<string, number>();
  const includedCommits = new Set<string>();
  const extraRoots: string[] = [];
  const queue: Array<{ oid: string; d: number }> = [];
  let queueHead = 0;
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'commit') queue.push({ oid: want, d: 0 });
    else if (obj.type === 'tag') {
      extraRoots.push(want);
      const target = parseTagTarget(obj.body).object;
      const targetObj = repo.objects.get(target);
      if (targetObj !== undefined && targetObj.type === 'commit') queue.push({ oid: target, d: 0 });
      else if (targetObj !== undefined) extraRoots.push(target);
    } else {
      extraRoots.push(want);
    }
  }
  // Also seed the client's old shallow boundaries at their distance from the
  // wants. A boundary can sit below a have (a second deepen: the want is the
  // tip, a full have, and the boundary is its parent), and the walk must not
  // stop at the have before reaching it — the boundary's parents are the
  // history a deepen is supposed to deliver.
  if (oldShallowSet.size > 0) {
    const distances = commitDistances(repo, wants.filter(isOid));
    for (const boundary of oldShallowSet) {
      const d = distances.get(boundary);
      if (d !== undefined) queue.push({ oid: boundary, d });
    }
  }
  while (queueHead < queue.length) {
    const { oid, d } = queue[queueHead];
    queueHead += 1;
    const known = distance.get(oid);
    if (known !== undefined && known <= d) continue;
    distance.set(oid, d);
    if (depth !== undefined && d >= depth) continue;
    if (!reached.has(oid)) reached.set(oid, d);
    if (oldShallowSet.has(oid)) {
      // Held as a shallow boundary: the client has this commit but NOT its
      // parents, so exclude the commit itself yet keep descending. This
      // check must come before the have check: a boundary is usually also
      // listed as a have (deepen), and stopping there would send nothing.
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'commit') {
        for (const parent of parseCommitHeaders(obj.body).parents) queue.push({ oid: parent, d: d + 1 });
      }
      continue;
    }
    if (haveSet.has(oid)) continue; // held with its ancestors: exclude all
    includedCommits.add(oid);
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const parent of parseCommitHeaders(obj.body).parents) queue.push({ oid: parent, d: d + 1 });
    }
  }

  const objects = new Set<string>();
  for (const commit of includedCommits) {
    objects.add(commit);
    const obj = repo.objects.get(commit);
    if (obj !== undefined && obj.type === 'commit') {
      for (const oid of collectReachable(repo, [parseCommitHeaders(obj.body).tree])) objects.add(oid);
    }
  }
  for (const root of extraRoots) {
    for (const oid of collectReachable(repo, [root])) objects.add(oid);
  }
  for (const held of haveClosure) objects.delete(held);
  for (const held of shallowHeld) objects.delete(held);

  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== undefined) {
    for (const commit of includedCommits) {
      const d = distance.get(commit) ?? 0;
      let isBoundary = d === depth - 1;
      if (!isBoundary) {
        const obj = repo.objects.get(commit);
        if (obj !== undefined && obj.type === 'commit') {
          for (const parent of parseCommitHeaders(obj.body).parents) {
            if (!includedCommits.has(parent)) {
              isBoundary = true;
              break;
            }
          }
        }
      }
      if (isBoundary) shallow.push(commit);
    }
    for (const boundary of oldShallowSet) {
      if (!reached.has(boundary)) continue;
      const obj = repo.objects.get(boundary);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parentIncluded = parseCommitHeaders(obj.body).parents.some((parent) => includedCommits.has(parent));
      if (parentIncluded) unshallow.push(boundary);
    }
    shallow = [...new Set(shallow)].sort();
    unshallow = [...new Set(unshallow)].sort();
  }

  // Acknowledgments only exist when the client sent haves: with none, the
  // answer is empty by definition, so skip walking the whole want closure
  // (a depth-1 clone of a 200-commit repo would otherwise pay that walk
  // on every one of its 50 concurrent fetches).
  const acks =
    haveSet.size === 0
      ? []
      : [...haveSet].filter((have) => collectReachable(repo, wants.filter(isOid)).has(have)).sort();
  return { objects, shallow, unshallow, acks };
}

// -- v2 ls-refs / fetch ------------------------------------------------------

function handleLsRefs(repo: Repo, packets: Packet[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const mainTip = repo.refs.get(MAIN_REF);
  if (matches('HEAD')) {
    if (mainTip !== undefined) {
      out.push(pktLine(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    } else if (unborn) {
      out.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peelOid(repo, oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

function parseFetchArgs(packets: Packet[]): {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  done: boolean;
  deepenRelative: boolean;
} {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  let deepenRelative = false;
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (line === 'deepen-relative') {
      deepenRelative = true;
    } else if (line === 'done') {
      done = true;
    }
  }
  return { wants, haves, shallow, depth, done, deepenRelative };
}

function handleFetchV2(repo: Repo, packets: Packet[]): Buffer {
  const args = parseFetchArgs(packets);
  // Memoize the whole response: the 50 concurrent depth-1 clones of one tip
  // send byte-identical fetch requests, and the response is a pure function
  // of the request over immutable objects (see Repo.fetchCache).
  const cacheKey = [
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    [...args.shallow].sort().join(','),
    args.depth === undefined ? '' : String(args.depth),
    args.deepenRelative ? '1' : '0',
    args.done ? '1' : '0',
  ].join('|');
  const cached = repo.fetchCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const selection = computeFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepenRelative);
  const parts: Buffer[] = [];
  // Acknowledgments belong only to an open negotiation round: real git
  // reads them only when the request carried haves but no `done`. A request
  // with `done` (every suite fetch, and git's final round) goes straight to
  // the packfile section — sending an acknowledgments section there makes
  // git die with "expected 'packfile', received 'acknowledgments'".
  if (args.haves.length > 0 && !args.done) {
    parts.push(pktLine('acknowledgments\n'));
    if (selection.acks.length > 0) {
      for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    // "ready" + delim tells git the pack follows in this same response
    // (without it, git waits for a response-end packet and opens a new
    // negotiation round).
    parts.push(pktLine('ready\n'));
    parts.push(DELIM);
  }
  if (args.depth !== undefined && (selection.shallow.length > 0 || selection.unshallow.length > 0)) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  // The packfile section is always sent (an empty pack when nothing is owed):
  // git's fetch requires the section after the acknowledgments/shallow-info,
  // and the suite accepts an empty pack for a nothing-new fetch.
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(writePack(repo, selection.objects))) parts.push(packet);
  parts.push(FLUSH);
  const response = Buffer.concat(parts);
  if (repo.fetchCache.size >= 128) repo.fetchCache.clear();
  repo.fetchCache.set(cacheKey, response);
  return response;
}

// -- v0 fetch (fallback; only used when the client did not negotiate v2) -----

function handleFetchV0(repo: Repo, packets: Packet[]): Buffer {
  // Two sections split by flush: wants (+ shallow/deepen), then haves + done.
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind !== 'data') continue;
    sections[sections.length - 1]!.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let deepenRelative = false;
  for (const line of sections[0] ?? []) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (line === 'deepen-relative') {
      deepenRelative = true;
    }
  }
  for (const line of sections[1] ?? []) {
    if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) haves.push(oid);
    }
  }
  const selection = computeFetch(repo, wants, haves, shallow, depth, deepenRelative);
  const parts: Buffer[] = [];
  if (selection.acks.length > 0) {
    for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (selection.objects.size > 0) {
    for (const packet of sidebandPackets(writePack(repo, selection.objects))) parts.push(packet);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// -- receive-pack (push) -----------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Refresh a branch ref's REST working tree from its new tip (tags: no tree). */
function updateContents(store: Store, repo: Repo, ref: string, tipOid: string): void {
  repo.updated_at = TRIAL_NOW.iso;
  repo.pushed_at = TRIAL_NOW.iso;
  if (!ref.startsWith('refs/heads/')) return;
  const commitOid = peelToCommit(repo, tipOid);
  if (commitOid === null) {
    repo.contents.delete(ref);
    return;
  }
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') {
    repo.contents.delete(ref);
    return;
  }
  repo.contents.set(ref, store.treeToContents(repo, parseCommitHeaders(obj.body).tree));
}

function applyCommand(
  store: Store,
  repo: Repo,
  command: PushCommand,
): { ref: string; ok: boolean; reason: string } {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    if (current === undefined) return { ref: command.ref, ok: false, reason: 'remote ref does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      return { ref: command.ref, ok: false, reason: 'old ref does not match' };
    }
    repo.refs.delete(command.ref);
    repo.contents.delete(command.ref);
    repo.updated_at = TRIAL_NOW.iso;
    repo.pushed_at = TRIAL_NOW.iso;
    return { ref: command.ref, ok: true, reason: '' };
  }
  if (!repo.objects.has(command.newOid)) {
    return { ref: command.ref, ok: false, reason: 'object not found' };
  }
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return { ref: command.ref, ok: false, reason: 'already exists' };
    repo.refs.set(command.ref, command.newOid);
    updateContents(store, repo, command.ref, command.newOid);
    return { ref: command.ref, ok: true, reason: '' };
  }
  if (current === undefined) return { ref: command.ref, ok: false, reason: 'remote ref does not exist' };
  if (command.oldOid !== current) return { ref: command.ref, ok: false, reason: 'old ref does not match' };
  if (!isAncestor(repo, command.oldOid, command.newOid)) {
    return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(command.ref, command.newOid);
  updateContents(store, repo, command.ref, command.newOid);
  return { ref: command.ref, ok: true, reason: '' };
}

function handleReceivePack(ctx: Ctx, store: Store, repo: Repo): Resp {
  const body = ctx.rawBody;
  let commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let packBytes = Buffer.alloc(0);
  try {
    const { packets, rest } = decodeUntilFlush(body);
    packBytes = rest;
    let first = true;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const payload = packet.payload;
      const nul = payload.indexOf(0);
      let lineBuf = payload;
      if (nul >= 0) {
        if (first) {
          capabilities = payload
            .subarray(nul + 1)
            .toString('utf8')
            .replace(/\n$/, '')
            .split(' ')
            .filter((token) => token !== '');
        }
        lineBuf = payload.subarray(0, nul);
      }
      first = false;
      const line = lineBuf.toString('utf8').replace(/\n$/, '');
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
      if (match === null) throw new Error('bad receive-pack command line');
      commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
    }
    if (commands.length === 0) throw new Error('receive-pack with no commands');
  } catch {
    return errJson(400, 'malformed receive-pack request');
  }

  const sideband = capabilities.includes('side-band-64k');
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: obj.type, body: obj.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `unpack failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (!unpackOk) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
  } else {
    for (const command of commands) results.push(applyCommand(store, repo, command));
  }

  const lines: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const result of results) {
    lines.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  let response: Buffer;
  if (sideband) {
    // The report-status stream inside band 1 must itself end with a flush
    // packet: send-pack's reader has no gentle-EOF handling and dies with
    // "the remote end hung up unexpectedly" if the pipe closes after the
    // last report line without one. The bare flush after the banded packets
    // ends the sideband stream itself.
    const innerLines = [...lines, FLUSH];
    const framed = innerLines.map((line) => pktLine(Buffer.concat([Buffer.from([1]), line])));
    response = Buffer.concat([...framed, FLUSH]);
  } else {
    response = Buffer.concat([...lines, FLUSH]);
  }
  return { status: 200, raw: response, headers: { 'content-type': 'application/x-git-receive-pack-result' } };
}

// -- routing -----------------------------------------------------------------

/** The repo for a `/:owner/:name.git/...` path, or null (404, never 403). */
function gitRepo(ctx: Ctx, store: Store): Repo | null {
  const owner = ctx.params.owner ?? '';
  const dotted = ctx.params.repogit ?? '';
  if (!dotted.endsWith('.git')) return null;
  return store.getRepo(owner, dotted.slice(0, -4));
}

function handleInfoRefs(ctx: Ctx, store: Store): Resp {
  const service = ctx.query.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return errJson(404, 'Not Found');
  const repo = gitRepo(ctx, store);
  if (repo === null) return errJson(404, 'Repository not found');
  const wantsV2 = service === 'git-upload-pack' && (ctx.headers['git-protocol'] ?? '') === 'version=2';
  if (wantsV2) {
    return {
      status: 200,
      raw: v2Advertisement(),
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
    };
  }
  if (service === 'git-upload-pack') {
    return {
      status: 200,
      raw: v0Advertisement(
        repo,
        service,
        'side-band-64k shallow ofs-delta thin-pack symref=HEAD:refs/heads/main agent=makefun-git-forge/1.0',
      ),
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
    };
  }
  return {
    status: 200,
    raw: v0Advertisement(
      repo,
      service,
      'report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=makefun-git-forge/1.0',
    ),
    headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
  };
}

function handleUploadPack(ctx: Ctx, store: Store): Resp {
  const repo = gitRepo(ctx, store);
  if (repo === null) return errJson(404, 'Repository not found');
  let packets: Packet[];
  try {
    packets = decodeAll(ctx.rawBody);
  } catch {
    return errJson(400, 'malformed pkt-line stream');
  }
  const firstData = packets.find((packet) => packet.kind === 'data');
  const firstLine = firstData === undefined ? '' : firstData.payload.toString('utf8');
  const isV2 = (ctx.headers['git-protocol'] ?? '') === 'version=2' || firstLine.startsWith('command=');
  try {
    if (isV2) {
      if (firstLine.startsWith('command=ls-refs')) {
        return {
          status: 200,
          raw: handleLsRefs(repo, packets),
          headers: { 'content-type': 'application/x-git-upload-pack-result' },
        };
      }
      if (firstLine.startsWith('command=fetch')) {
        return {
          status: 200,
          raw: handleFetchV2(repo, packets),
          headers: { 'content-type': 'application/x-git-upload-pack-result' },
        };
      }
      return errJson(400, 'unknown upload-pack command');
    }
    return {
      status: 200,
      raw: handleFetchV0(repo, packets),
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
    };
  } catch {
    return errJson(400, 'malformed upload-pack request');
  }
}

export function registerGitRoutes(router: Router): void {
  router.add('GET', '/:owner/:repogit/info/refs', (ctx, store) => handleInfoRefs(ctx, store));
  router.add('POST', '/:owner/:repogit/git-upload-pack', (ctx, store) => handleUploadPack(ctx, store));
  router.add('POST', '/:owner/:repogit/git-receive-pack', (ctx, store) => {
    const repo = gitRepo(ctx, store);
    if (repo === null) return errJson(404, 'Repository not found');
    return handleReceivePack(ctx, store, repo);
  });
}

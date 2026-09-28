import { createHmac } from 'node:crypto';
import type { AppConfig } from '../config/index.js';

/**
 * Keyset (cursor) pagination.
 *
 * Offset pagination on a shared tenant table is a correctness and performance
 * trap: `LIMIT 25 OFFSET 5000` makes Postgres walk (and discard) 5025 index
 * entries per page, so page 200 of a large tenant is slower than page 1, and
 * concurrent inserts shift rows between pages so clients skip or duplicate
 * records. Keyset pagination on `(sort_value, id)` is O(page size) and stable.
 *
 * The cursor is an opaque HMAC-signed base64url payload rather than raw JSON:
 * clients must not learn that ids are sortable, and a tampered cursor must fail
 * closed at decode time instead of producing a weird query plan.
 */

export interface CursorPayload {
  /** Last sort key of the previous page. */
  v: string | number;
  /** Tiebreaker: the primary key. */
  id: string;
}

export class CursorError extends Error {
  readonly statusCode = 400;
  readonly code = 'BAD_REQUEST';
  constructor(message = 'Invalid cursor') {
    super(message);
    this.name = 'CursorError';
  }
}

export function encodeCursor(payload: CursorPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url').slice(0, 22);
  return `${body}.${sig}`;
}

export function decodeCursor(raw: string | undefined, secret: string): CursorPayload | null {
  if (!raw) {
    return null;
  }
  const [body, sig] = raw.split('.');
  if (!body || !sig) {
    throw new CursorError();
  }
  const expected = createHmac('sha256', secret).update(body).digest('base64url').slice(0, 22);
  if (sig.length !== expected.length || !timingSafeEqualStr(sig, expected)) {
    throw new CursorError('cursor signature mismatch');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError();
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('v' in parsed) ||
    !('id' in parsed) ||
    typeof (parsed as CursorPayload).id !== 'string'
  ) {
    throw new CursorError();
  }
  return parsed as CursorPayload;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i]! ^ bb[i]!;
  }
  return diff === 0;
}

/**
 * Build the WHERE/ORDER BY fragment for a keyset page.
 *
 * `$n` placeholders start at `startParam` so callers can compose with their
 * tenant/permission predicates without renumbering by hand.
 */
export function keysetCondition(
  cursor: CursorPayload | null,
  opts: { column: string; order: 'asc' | 'desc'; startParam: number; param: unknown },
): { sql: string; params: unknown[]; orderBy: string } {
  const { column, order, startParam, param } = opts;
  const dir = order === 'asc' ? '>' : '<';
  if (!cursor) {
    return {
      sql: '',
      params: [],
      orderBy: `"${column}" ${order.toUpperCase()}, id ${order.toUpperCase()}`,
    };
  }
  const vIdx = startParam;
  const idIdx = startParam + 1;
  return {
    sql: `(${column} ${dir} $${vIdx} OR (${column} = $${vIdx} AND id ${dir} $${idIdx}))`,
    params: [param, cursor.id],
    orderBy: `"${column}" ${order.toUpperCase()}, id ${order.toUpperCase()}`,
  };
}

export function pageMeta<T extends { limit: number }>(
  query: T,
  rows: unknown[],
  nextCursor: string | null,
) {
  return {
    limit: query.limit,
    nextCursor,
    hasMore: nextCursor !== null,
    count: rows.length,
  };
}

/** Convenience for "fetch limit+1, trim, hand back a cursor". */
export function trimPage<R>(rows: R[], limit: number): { rows: R[]; hasMore: boolean } {
  if (rows.length > limit) {
    return { rows: rows.slice(0, limit), hasMore: true };
  }
  return { rows, hasMore: false };
}

/**
 * Weak ETag for a single resource. Content-hash rather than version-number: the
 * client does not need to know our versioning scheme, and two replicas that
 * cached the same object must produce the same tag.
 */
export function etagFor(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return `W/"${(h >>> 0).toString(36)}"`;
}

/**
 * The concurrency token for a single versioned row: `W/"v<version>"`.
 *
 * Deliberately *not* a content hash: an ETag a client can read the next value
 * from (`version` is in the body too), and one that survives a change to the
 * DTO's shape. Lists keep `etagFor`, where there is no single row version to
 * name and the answer is about the *page* being identical.
 */
export function versionEtag(version: number): string {
  return `W/"v${version}"`;
}

/**
 * The version a conditional header asserts, or `null` when it does not assert
 * one we can honour. Accepts `W/"v12"`, `"v12"`, `v12` and the bare `12` that a
 * client reading `version` out of the body tends to send, including inside a
 * comma-separated `If-Match` list. `*` is NOT accepted: "any version" is exactly
 * the blind overwrite the precondition exists to prevent.
 */
export function parseVersionEtag(header: string | undefined): number | null {
  if (!header) {
    return null;
  }
  const trimmed = header.trim();
  if (trimmed === '*' || trimmed === '') {
    return null;
  }
  for (const part of trimmed.split(',')) {
    const token = part.trim().replace(/^W\//i, '').replace(/^"|"$/g, '').trim();
    const match = /^v?(\d+)$/.exec(token);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

export function cursorSecret(cfg: AppConfig): string {
  // Derive from the JWT secret so rotation is one operation, but never reuse it
  // directly: a leaked cursor-signing key must not be able to mint tokens.
  return `cursor:${cfg.env.JWT_SECRET.slice(0, 24)}`;
}

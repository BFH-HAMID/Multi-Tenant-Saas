import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** Opaque token material (refresh tokens, idempotency keys, job tokens). */
export function randomToken(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

export function base64Url(buf: Uint8Array | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : Buffer.from(buf);
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Refresh tokens and API keys are stored as SHA-256 digests: a DB dump must
 * not yield usable credentials. Passwords use argon2id instead (see
 * apps/api/src/modules/auth/passwords.ts) because they are low-entropy.
 */
export function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Compare against self to keep the timing profile flat, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function hmac(signingKey: string, payload: string): string {
  return base64Url(createHmac('sha256', signingKey).update(payload).digest());
}

export const newUuid = (): string => randomUUID();

/**
 * UUIDv7 (RFC 9562): 48-bit big-endian unix-ms prefix + random payload, with
 * version/variant bits set. We use it for primary keys because a time-ordered
 * key makes B-tree inserts append-heavy instead of random, which is worth
 * measurable insert throughput and less index bloat on a tenant-partitioned
 * workload. Postgres 18 has uuidv7() too, but generating client-side keeps the
 * id available before the INSERT (needed for outbox correlation).
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = Buffer.from(randomBytes(16));
  const ms = Math.floor(nowMs);
  // 48-bit big-endian unix-ms in bytes 0..5 (>> is 32-bit only, so divide).
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const newTenantId = uuidv7;

/** Deterministic job id for idempotent enqueue: same request → same job id. */
export function jobIdFor(...parts: string[]): string {
  return createHash('sha1').update(parts.join('|'), 'utf8').digest('hex').slice(0, 32);
}

/**
 * What actually goes into argon2: the NFKC-normalised password, SHA-256'd and
 * base64url-encoded.
 *
 * Two reasons, and both matter: (1) argon2 implementations differ on very long
 * inputs, and some silently truncate — a fixed 43-char digest removes the
 * question; (2) without normalisation, two visually identical passwords (a
 * compatibility ligature, a full-width character) hash differently and the user
 * is locked out for a reason nobody can see.
 *
 * This is a *pre-hash*, not a replacement for the KDF: argon2id still runs on
 * top with the memory/time cost, so nothing about brute-force resistance changes.
 *
 * It lives here rather than inside the API because the seed must derive byte-for-
 * byte the same input: a hash computed over the raw password can never verify
 * against a service that verifies against the digest, and that mismatch presents
 * as "wrong password" for every seeded account — which is exactly the bug this
 * comment exists to prevent.
 */
export function passwordKeyMaterial(plain: string): string {
  return createHash('sha256').update(plain.normalize('NFKC'), 'utf8').digest('base64url');
}

import { z } from 'zod';

/** Reusable DTO fragments. API routes and the (future) web client share these,
 *  which is the point of putting them in `packages/shared`. */

export const uuidSchema = z.string().uuid();

export const slugSchema = z
  .string()
  .min(2, 'too short')
  .max(40, 'too long')
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/, 'lowercase letters, digits and dashes only');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(5)
  .max(254)
  .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v), 'invalid email address');

export const passwordSchema = z
  .string()
  .min(12, 'passwords must be at least 12 characters')
  .max(200, 'passwords longer than 200 characters are truncated by NIST guidance')
  // Deliberately no complexity theatre: length + a breached-password check at
  // signup (see auth/service.ts) beats "must contain a 🧨 and a digit".
  .refine((v) => !/^[a-z]+$|^[0-9]+$/.test(v), 'too uniform to be a password');

/** Clamped, not rejected: a client asking for 5000 rows is a bug, not an error,
 *  and silently serving 100 beats a 422 in the middle of an infinite scroll. */
export const PAGE_MAX = 100;
export const PAGE_DEFAULT = 25;
export const paginationQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .optional()
    .transform((v) => Math.min(PAGE_MAX, Math.max(1, v ?? PAGE_DEFAULT))),
  cursor: z.string().min(1).max(128).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

/** Opaque base64url cursor: `{id, sortKey}` — see apps/api/src/lib/paginate.ts. */
export const cursorSchema = z.string().min(1).max(128);

export function pageMeta<T extends { limit: number }>(
  q: T,
  nextCursor: string | null,
): { limit: number; nextCursor: string | null; hasMore: boolean } {
  return { limit: q.limit, nextCursor, hasMore: nextCursor !== null };
}

export const problemDetailsSchema = z.object({
  type: z.string().url(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  tenantId: z.string().optional(),
  retryAfter: z.number().int().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetailsDto = z.infer<typeof problemDetailsSchema>;

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'allowed characters: A-Z a-z 0-9 . _ : -');

export const jsonSafe = z.unknown().refine((v) => {
  try {
    JSON.stringify(v);
    return true;
  } catch {
    return false;
  }
}, 'value must be JSON-serialisable');

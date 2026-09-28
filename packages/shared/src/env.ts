import { z } from 'zod';

/** Env parsing helpers shared by api + worker so both fail the same way. */

export const bool = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false', 'yes', 'no'])])
  .transform((v) => v === true || v === '1' || v === 'true' || v === 'yes');

export const int = (min?: number, max?: number) =>
  z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'number' ? v : Number(v)))
    .refine((v) => Number.isFinite(v), 'must be a number')
    .refine((v) => (min === undefined || v >= min) && (max === undefined || v <= max), {
      message: `out of range`,
    })
    .transform((v) => Math.trunc(v));

export const ms = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? v : Number(v)))
  .refine((v) => Number.isFinite(v) && v >= 0, 'must be a non-negative duration in ms');

/** `redis://`, `rediss://` and our in-process `memory://` scheme. */
export const redisUrl = z.string().refine((v) => /^(redis|rediss|memory):\/\//.test(v), {
  message: 'must start with redis://, rediss:// or memory://',
});

export const postgresUrl = z
  .string()
  .refine((v) => /^postgres(ql)?:\/\//.test(v), { message: 'must be a postgres URL' });

export function parseEnv<S extends z.ZodTypeAny>(
  schema: S,
  source: NodeJS.ProcessEnv = process.env,
) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid environment configuration:\n${issues}`);
  }
  return parsed.data as z.infer<S>;
}

/** Never print secrets in startup logs; show a fingerprint instead. */
export function secretFingerprint(value: string): string {
  if (value.length <= 8) {
    return 'set(len<=8)';
  }
  return `len=${value.length} sha=${hashPrefix(value)}`;
}

function hashPrefix(value: string): string {
  // Cheap non-cryptographic fingerprint; only used for log correlation.
  let h = 5381;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) {
      u.password = '***';
    }
    if (u.username) {
      u.username = `${u.username.slice(0, 2)}***`;
    }
    return u.toString();
  } catch {
    return raw.split('@').pop() ?? raw;
  }
}

import { hash, verify, type Options } from '@node-rs/argon2';
import { passwordKeyMaterial } from '@saas/shared';

/**
 * argon2id, with the OWASP 2024-ish parameters for a server-side login:
 * m=19 MiB, t=2, p=1. Chosen because it is memory-hard (GPU/ASIC unfriendly),
 * in the standard library-adjacent ecosystem, and *tunable without a DB
 * migration*: the parameters we used are recorded in the hash itself, and
 * `password_params` on the user row lets us log how many users still sit on an
 * older cost model.
 *
 * A `needsRehash` check runs at login, so cost upgrades happen lazily on a
 * successful password entry (the only moment we have the plaintext) instead of
 * forcing a password reset on every user.
 *
 * Why not bcrypt: still defensible, but bcrypt silently truncates at 72 bytes,
 * which is exactly the kind of surprise a passkey/long-passphrase era does not
 * need. Why not scrypt: less memory-hard per unit time at equal cost.
 */
/**
 * `@node-rs/argon2`'s defaults are already argon2id at v1.3, so the options we
 * pass are only the cost parameters — the encoded hash still records
 * `$argon2id$v=19$` and remains verifiable by any conformant implementation
 * (including a future non-Node service).
 */
const PARAMS = {
  memoryCost: 19_456, // KiB → 19 MiB, per OWASP for interactive logins
  timeCost: 2,
  parallelism: 1,
} satisfies Options;

export interface PasswordService {
  hash(plain: string): Promise<string>;
  verify(hashStr: string, plain: string): Promise<boolean>;
  needsUpgrade(hashStr: string): Promise<boolean>;
  params: string;
}

export function createPasswordService(log?: {
  error(o: object, m?: string): void;
}): PasswordService {
  return {
    params: 'argon2id:v19:m=19456,t=2,p=1',
    async hash(plain: string) {
      return hash(deriveKeyMaterial(plain), PARAMS);
    },
    async verify(hashStr: string, plain: string) {
      try {
        return await verify(hashStr, deriveKeyMaterial(plain));
      } catch (err) {
        // A malformed hash (manual DB edit, truncated column) is a server-side
        // data problem, not a wrong password: log it, then fail closed.
        log?.error({ err: String(err) }, 'password hash could not be parsed');
        return false;
      }
    },
    async needsUpgrade(hashStr: string) {
      return costDiffers(hashStr);
    },
  };
}

/**
 * Pre-hash with SHA-256 before argon2.
 *
 * Two reasons, and they are security reasons rather than performance ones:
 *  - argon2 implementations differ in how they treat very long inputs, and we
 *    accept passphrases up to 200 chars; hashing first gives a fixed-length
 *    key and no silent truncation policy;
 *  - NUL/newline/unicode-normalisation differences between the browser and the
 *    server stop being a lockout bug once the input is normalised.
 * This does *not* replace the server-side memory-hard function; the digest is
 * not secret, it is just a canonicalisation.
 */
/**
 * `needsRehash` equivalent: the PHC-style encoding carries the parameters
 * (`$argon2id$v=19$m=19456,t=2,p=1$salt$tag`), so a comparison against the
 * current cost model is a string parse. Anything unparseable is left alone
 * rather than force-rotated on a login.
 */
export function costDiffers(hashStr: string): boolean {
  const m = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hashStr);
  if (!m) {
    return false;
  }
  const [, version, memory, time, parallelism] = m;
  return (
    version !== '19' ||
    Number(memory) !== PARAMS.memoryCost ||
    Number(time) !== PARAMS.timeCost ||
    Number(parallelism) !== PARAMS.parallelism
  );
}

// The pre-hash is shared with the seed (see @saas/security) — one definition of
// "what we feed argon2", so a seeded hash and a signup hash are comparable.
function deriveKeyMaterial(plain: string): string {
  return passwordKeyMaterial(plain);
}

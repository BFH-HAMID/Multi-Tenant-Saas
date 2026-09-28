import { z } from 'zod';
import { emailSchema, passwordSchema, slugSchema, uuidSchema } from './common.js';
import { PLAN_IDS } from '../plans.js';

/**
 * Auth + signup DTOs.
 *
 * Signup is tenant-first (Slack/Linear style): a single call provisions the
 * tenant, its owner user and the membership in one transaction, because three
 * sequential calls from a browser would leave a half-created tenant if the tab
 * is closed — and every one of those orphans would need a janitor job.
 */

export const registerSchema = z.object({
  tenant: z.object({
    name: z.string().trim().min(2).max(120),
    slug: slugSchema,
    plan: z.enum(PLAN_IDS).default('free'),
  }),
  user: z.object({
    email: emailSchema,
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(80).optional(),
  }),
  /** Echoed into `audit_log` so marketing attribution does not need a column. */
  signupSource: z.string().max(64).optional(),
});
export type RegisterRequest = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  /** Optional: skip the workspace picker when the caller already knows. */
  tenantSlug: z.string().optional(),
});
export type LoginRequest = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(256),
});
export type RefreshRequest = z.infer<typeof refreshSchema>;

export const logoutSchema = z.object({
  refreshToken: z.string().min(20).max(256).optional(),
  /** Revoke every session for this user in this tenant. */
  allDevices: z.boolean().default(false),
});
export type LogoutRequest = z.infer<typeof logoutSchema>;

export const tokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int(),
  tenant: z.object({ id: uuidSchema, slug: z.string(), plan: z.string(), role: z.string() }),
});
export type TokensResponse = z.infer<typeof tokensSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  current: z.boolean(),
});
export type SessionDto = z.infer<typeof sessionSchema>;

export const meSchema = z.object({
  user: z.object({
    id: uuidSchema,
    email: z.string(),
    displayName: z.string().nullable(),
  }),
  tenant: z.object({
    id: uuidSchema,
    slug: z.string(),
    name: z.string(),
    plan: z.enum(PLAN_IDS),
    status: z.string(),
  }),
  role: z.string(),
  permissions: z.object({
    rateLimit: z.object({
      routeClass: z.string(),
      capacity: z.number(),
      refillPerSec: z.number(),
    }),
    maxMembers: z.number().int(),
    maxProjects: z.number().int(),
  }),
});
export type MeResponse = z.infer<typeof meSchema>;

import { z } from 'zod';
import { PLAN_IDS, ROUTE_CLASSES } from '../plans.js';
import { slugSchema, uuidSchema } from './common.js';

export const tenantDtoSchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  name: z.string(),
  plan: z.enum(PLAN_IDS),
  status: z.enum(['active', 'suspended', 'cancelled']),
  createdAt: z.string(),
  retentionDays: z.number().int(),
});
export type TenantDto = z.infer<typeof tenantDtoSchema>;

export const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema,
  plan: z.enum(PLAN_IDS).default('free'),
});
export type CreateTenantRequest = z.infer<typeof createTenantSchema>;

export const updateTenantSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    settings: z
      .object({
        timezone: z.string().max(64).optional(),
        requireMfa: z.boolean().optional(),
        allowedEmailDomains: z.array(z.string().max(253)).max(20).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'no fields to update');
export type UpdateTenantRequest = z.infer<typeof updateTenantSchema>;

/** Plan changes go through this endpoint; the limiter picks it up on the next
 *  request because geometry is derived from the tenant's plan, not stored. */
export const changePlanSchema = z.object({ plan: z.enum(PLAN_IDS) });
export type ChangePlanRequest = z.infer<typeof changePlanSchema>;

export const planDtoSchema = z.object({
  plan: z.enum(PLAN_IDS),
  quotas: z.object({
    maxMembers: z.number().int(),
    maxProjects: z.number().int(),
    maxConcurrentJobs: z.number().int(),
  }),
  rateLimits: z.record(
    z.string(),
    z.object({
      capacity: z.number(),
      refillPerSec: z.number(),
      sustainedPerMinute: z.number(),
      description: z.string(),
    }),
  ),
});
export type PlanDto = z.infer<typeof planDtoSchema>;

export function planToDto(
  plan: (typeof PLAN_IDS)[number],
  limits: {
    maxMembers: number;
    maxProjects: number;
    maxConcurrentJobs: number;
    routes: Record<string, { capacity: number; refillPerSec: number }>;
  },
): z.infer<typeof planDtoSchema> {
  const rateLimits: Record<string, PlanDto['rateLimits'][string]> = {};
  for (const [id, geom] of Object.entries(limits.routes)) {
    rateLimits[id] = {
      capacity: geom.capacity,
      refillPerSec: geom.refillPerSec,
      sustainedPerMinute: Math.round(geom.refillPerSec * 60),
      description: ROUTE_CLASSES[id]?.description ?? id,
    };
  }
  return {
    plan,
    quotas: {
      maxMembers: limits.maxMembers,
      maxProjects: limits.maxProjects,
      maxConcurrentJobs: limits.maxConcurrentJobs,
    },
    rateLimits,
  };
}

import { z } from 'zod';
import { paginationQuery, slugSchema, uuidSchema } from './common.js';

export const projectStatuses = ['active', 'archived'] as const;

export const projectDtoSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  name: z.string(),
  slug: z.string(),
  status: z.enum(projectStatuses),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  settings: z.record(z.string(), z.unknown()),
  ownerId: uuidSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Monotonic per-row counter: optimistic concurrency token and cache input. */
  version: z.number().int().nonnegative(),
});
export type ProjectDto = z.infer<typeof projectDtoSchema>;

const nameSchema = z.string().trim().min(1).max(120);
const slugField = slugSchema.max(60);

export const createProjectSchema = z
  .object({
    name: nameSchema,
    slug: slugField.optional(),
    description: z.string().trim().max(2000).optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: nameSchema.optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    status: z.enum(projectStatuses).optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'no fields to update');
export type UpdateProjectRequest = z.infer<typeof updateProjectSchema>;

export const listProjectsQuery = paginationQuery.extend({
  status: z.enum(projectStatuses).default('active'),
  q: z.string().max(64).optional(),
  tag: z.string().max(32).optional(),
  sort: z.enum(['createdAt', 'name', 'updatedAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuery>;

export const projectParamsSchema = z.object({ id: uuidSchema });

export const listProjectsResponse = z.object({
  data: z.array(projectDtoSchema),
  meta: z.object({
    limit: z.number(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
});
export type ListProjectsResponse = z.infer<typeof listProjectsResponse>;

/** Body of POST /projects/{id}/reports — the async job trigger. */
export const generateReportSchema = z
  .object({
    format: z.enum(['csv', 'json']).default('json'),
    // `.nullable().optional()`, not just `.optional()`: the API's own queue
    // producer writes `range: null` into the job payload (`body.range ?? null`),
    // and a plain `.optional()` rejects an explicit null — which would make every
    // report job a poison message in the worker while the HTTP request looked
    // perfectly valid. Accepting null here also lets clients clear a range.
    range: z
      .object({
        from: z.iso.datetime(),
        to: z.iso.datetime(),
      })
      .nullable()
      .optional(),
    includeArchived: z.boolean().default(false),
    /** Client-generated; dedupes double-clicks and retry storms. */
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict();
export type GenerateReportRequest = z.infer<typeof generateReportSchema>;

export const jobStatusSchema = z.object({
  jobId: z.string(),
  queue: z.string(),
  state: z.enum(['queued', 'active', 'completed', 'failed', 'dead', 'delayed', 'unknown']),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  createdAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  result: z.unknown().optional(),
});
export type JobStatusDto = z.infer<typeof jobStatusSchema>;

import { z } from 'zod';
import { ROLES } from '../types.js';

const assignableRoles = ['admin', 'member', 'viewer'] as const;
import { emailSchema, paginationQuery, uuidSchema } from './common.js';

export const memberDtoSchema = z.object({
  userId: uuidSchema,
  email: z.string(),
  displayName: z.string().nullable(),
  role: z.enum(ROLES),
  status: z.enum(['active', 'invited', 'disabled']),
  joinedAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
});
export type MemberDto = z.infer<typeof memberDtoSchema>;

export const listMembersQuery = paginationQuery.extend({
  role: z.enum(ROLES).optional(),
  q: z.string().max(64).optional(),
});
export type ListMembersQuery = z.infer<typeof listMembersQuery>;

export const inviteSchema = z.object({
  email: emailSchema,
  role: z.enum(assignableRoles).default('member'),
});
export type InviteRequest = z.infer<typeof inviteSchema>;

export const updateMemberSchema = z
  .object({ role: z.enum(ROLES) })
  .strict()
  .refine((v) => v.role !== 'owner', 'ownership transfer uses POST /tenants/current/transfer');
export type UpdateMemberRequest = z.infer<typeof updateMemberSchema>;

export const updateProfileSchema = z
  .object({ displayName: z.string().trim().min(1).max(80) })
  .strict();
export type UpdateProfileRequest = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(12).max(200) })
  .strict();
export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;

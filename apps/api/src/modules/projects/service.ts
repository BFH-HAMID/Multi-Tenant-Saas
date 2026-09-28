import {
  AppError,
  conflict,
  preconditionFailed,
  preconditionRequired,
  notFound,
  type CacheOutcome,
  type ListProjectsQuery,
  type ProjectDto,
} from '@saas/shared';
import type { Database } from '@saas/db';
import type { CacheStore } from '../../cache/store.js';
import { CACHE_TTL_MS } from '../../config/constants.js';
import {
  cursorSecret,
  decodeCursor,
  encodeCursor,
  keysetCondition,
  parseVersionEtag,
  trimPage,
  type CursorPayload,
} from '../../lib/paginate.js';
import type { AppConfig } from '../../config/index.js';
import type { Requester, ResolvedTenant } from '../../types.js';

interface ProjectRow {
  id: string;
  tenant_id: string;
  owner_id: string | null;
  name: string;
  slug: string;
  status: 'active' | 'archived';
  description: string | null;
  tags: string[] | null;
  settings: Record<string, unknown>;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface Page<T> {
  data: T[];
  meta: { limit: number; nextCursor: string | null; hasMore: boolean; count: number };
  etag: string;
  /** For the `x-cache` response header; also what the tests assert on. */
  cacheOutcome: CacheOutcome;
}

const SORT_COLUMN: Record<NonNullable<ListProjectsQuery['sort']>, string> = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  name: 'lower(name)',
};

/**
 * Projects: the sample business resource, and the reason the cache layer is
 * shaped the way it is.
 *
 * Read path  (`list`, `get`)  → cache-aside with a tenant+version-scoped key,
 *                               keyset pagination, ETag/304 on the item route.
 * Write path (`create`, `update`, `archive`, `delete`) → one transaction that
 *                               (a) runs inside the tenant's RLS context,
 *                               (b) lets the *database* enforce the plan quota
 *                                   (BEFORE INSERT trigger, so it is race-free),
 *                               (c) bumps the entity version so every cached page
 *                                   becomes unreachable, and
 *                               (d) writes the audit + outbox rows in the same tx.
 *
 * Invalidation ordering matters and is deliberate: the version is bumped *after*
 * the commit succeeds (see `invalidateAfterCommit`), so a rolled-back write can
 * never orphan a cache generation that never existed. The cost of that ordering
 * is a tiny window where a concurrent reader may re-cache a pre-write value;
 * bounded by TTL (≤15s) and by the fact that the write itself already landed.
 */
export class ProjectService {
  constructor(
    private readonly db: Database,
    private readonly cache: CacheStore,
    private readonly cfg: AppConfig,
  ) {}

  async list(
    tenant: ResolvedTenant,
    query: ListProjectsQuery,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<Page<ProjectDto>> {
    // The key holds the *whole page identity* (filters + cursor), because two
    // different pages of the same tenant are different answers. `hasMore` is
    // part of the cached value on purpose: recomputing it from
    // `rows.length === limit` after the extra row is trimmed would make the last
    // full page lie and emit a cursor to an empty page.
    const identity = [
      query.status,
      query.sort,
      query.order,
      query.q ?? '',
      query.tag ?? '',
      String(query.limit),
      query.cursor ?? '',
    ].join('\u0000');

    let outcome: CacheOutcome = 'bypass';
    const value = await this.cache.fetch<{ rows: ProjectDto[]; hasMore: boolean }>({
      tenantId: tenant.id,
      entity: 'projects',
      parts: [identity],
      ttlMs: CACHE_TTL_MS.projectList,
      limits: tenant.planLimits,
      bypass: opts.forceRefresh,
      observe: (o) => {
        outcome = o;
      },
      load: async () => {
        const { rows, hasMore } = await this.queryPage(tenant, query);
        return { rows: rows.map(toDto), hasMore };
      },
    });

    const last = value.rows[value.rows.length - 1];
    const nextCursor =
      value.hasMore && last
        ? encodeCursor(cursorPayloadFor(last, query.sort), cursorSecret(this.cfg))
        : null;

    return {
      data: value.rows,
      meta: { limit: query.limit, nextCursor, hasMore: value.hasMore, count: value.rows.length },
      etag: weak(value.rows),
      cacheOutcome: outcome,
    };
  }

  /**
   * The page query runs inside `withTenant` even though it already carries a
   * `tenant_id = app.current_tenant_id()` predicate: the GUC is set per
   * transaction, so outside one it is NULL and every row is filtered out — a
   * silently *empty* list rather than an error, which is the worst possible
   * failure mode for a multi-tenant read path. The predicate stays because RLS
   * alone would also permit a `SELECT` plan that scans other tenants' pages.
   */
  private async queryPage(
    tenant: ResolvedTenant,
    query: ListProjectsQuery,
  ): Promise<{ rows: ProjectRow[]; hasMore: boolean }> {
    const cursor: CursorPayload | null = query.cursor
      ? decodeCursor(query.cursor, cursorSecret(this.cfg))
      : null;
    const column = SORT_COLUMN[query.sort];
    const limit = query.limit + 1; // fetch one extra to know whether a next page exists

    const where: string[] = ['tenant_id = app.current_tenant_id()', 'status = $1'];
    const params: unknown[] = [query.status];
    const keyset = keysetCondition(cursor, {
      column: query.sort === 'name' ? 'lower(name)' : column,
      order: query.order,
      startParam: params.length + 1,
      param: query.sort === 'name' ? String(cursor?.v ?? '') : (cursor?.v ?? ''),
    });
    if (keyset.sql) {
      where.push(keyset.sql);
      params.push(...keyset.params);
    }
    if (query.q) {
      params.push(`%${query.q.replace(/[%_]/g, '')}%`);
      where.push(
        `(name ILIKE $${params.length} OR coalesce(description,'') ILIKE $${params.length})`,
      );
    }
    if (query.tag) {
      params.push(query.tag);
      where.push(`$${params.length} = ANY(tags)`);
    }

    const rows = await this.db.withTenant({ tenantId: tenant.id, readOnly: true }, async (tx) => {
      const res = await tx.query<ProjectRow>(
        `SELECT id, tenant_id, owner_id, name, slug, status, description, tags, settings,
                version::int AS version, created_at, updated_at
           FROM projects
          WHERE ${where.join(' AND ')}
          ORDER BY ${keyset.orderBy}
          LIMIT ${limit}`,
        params,
      );
      return res.rows;
    });
    return trimPage(rows, query.limit);
  }

  /**
   * Whole-workspace export: deliberately uncached, single query, and charged to
   * the `bulk` route class. It exists so the noisy-neighbour test has something
   * genuinely expensive for one tenant to hammer while another stays healthy.
   */
  async export(tenant: ResolvedTenant): Promise<ProjectDto[]> {
    const rows = await this.db.withTenant(
      { tenantId: tenant.id, readOnly: true },
      async (tx) =>
        (
          await tx.query<ProjectRow>(
            `SELECT id, tenant_id, owner_id, name, slug, status, description, tags, settings, version::int AS version, created_at, updated_at
             FROM projects
            WHERE tenant_id = app.current_tenant_id()
            ORDER BY created_at DESC, id
            LIMIT 2000`,
          )
        ).rows,
    );
    return rows.map(toDto);
  }

  async get(tenant: ResolvedTenant, id: string): Promise<ProjectDto> {
    const cached = await this.cache.getItem<ProjectDto>(tenant.id, 'project', id);
    if (cached) {
      return cached;
    }
    const rows = await this.db.withTenant(
      { tenantId: tenant.id, readOnly: true },
      async (tx) =>
        (
          await tx.query<ProjectRow>(
            `SELECT id, tenant_id, owner_id, name, slug, status, description, tags, settings,
                          version::int AS version, created_at, updated_at
                     FROM projects WHERE id = $1`,
            [id],
          )
        ).rows,
    );
    const row = rows[0];
    if (!row) {
      throw notFound('Project');
    }
    const dto = toDto(row);
    await this.cache.setItem(
      tenant.id,
      'project',
      id,
      dto,
      CACHE_TTL_MS.projectItem * tenant.planLimits.cacheTtlScale,
    );
    return dto;
  }

  async create(
    tenant: ResolvedTenant,
    actor: Requester,
    input: {
      name: string;
      slug?: string | undefined;
      description?: string | undefined;
      tags?: string[] | undefined;
      settings?: Record<string, unknown> | undefined;
    },
    opts: { idempotencyKey?: string | undefined; requestId?: string | undefined } = {},
  ): Promise<ProjectDto> {
    const slug = input.slug ?? slugify(input.name);

    return this.db.withTenant(
      { tenantId: tenant.id, userId: actor.userId, role: actor.role, requestId: opts.requestId },
      async (tx) => {
        // Plan quota is enforced *here* (by trigger, inside the tx) rather than
        // by a COUNT-then-INSERT in the handler: the latter is a TOCTOU race that
        // a burst of parallel creates happily wins, and the burst is exactly what
        // a free-tier integration does on boot.
        const { rows } = await tx.query<ProjectRow>(
          `INSERT INTO projects (tenant_id, owner_id, name, slug, description, tags, settings)
           VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5, $6::jsonb)
           RETURNING id, tenant_id, owner_id, name, slug, status, description, tags, settings,
                    version::int AS version, created_at, updated_at`,
          [
            actor.userId,
            input.name,
            slug,
            input.description ?? null,
            input.tags ?? [],
            JSON.stringify(input.settings ?? {}),
          ],
        );
        const created = rows[0];
        if (!created) {
          throw new AppError('INTERNAL', 'insert returned no row', 500);
        }
        await tx.query('SELECT app.audit($1,$2,$3,$4::jsonb)', [
          'project.created',
          'project',
          created.id,
          '{}',
        ]);
        const dto = toDto(created);
        await this.afterWrite(tenant, { id: dto.id, dto });
        return dto;
      },
    );
  }

  async update(
    tenant: ResolvedTenant,
    actor: Requester,
    id: string,
    patch: Partial<Pick<ProjectDto, 'name' | 'description' | 'status' | 'tags' | 'settings'>>,
    opts: { ifMatch?: string | undefined } = {},
  ): Promise<ProjectDto> {
    // A blind overwrite on a *shared* resource is not a feature: the loser of a
    // concurrent edit would silently delete the winner's change. Requiring a
    // precondition (428) makes "read, then write" the only path, and it costs a
    // client one header.
    if (!opts.ifMatch) {
      throw preconditionRequired(
        'If-Match is required: a project is edited by a team, not by one browser tab',
        {
          hint: 'GET /v1/projects/:id, keep its etag, then PATCH with If-Match: <that etag>',
        },
      );
    }
    // The asserted version, never the new one: a client that could choose
    // `version` would be able to mint whatever concurrency token it liked.
    const expectedVersion = parseVersionEtag(opts.ifMatch);
    if (expectedVersion === null) {
      throw preconditionFailed(
        'If-Match must be the etag from GET /v1/projects/:id (e.g. W/"v3")',
        { received: opts.ifMatch.slice(0, 64) },
      );
    }

    return this.db.withTenant(
      { tenantId: tenant.id, userId: actor.userId, role: actor.role },
      async (tx) => {
        // `AND version = $7` is the whole point of the precondition: the update is
        // a compare-and-swap, so two concurrent writers cannot both win, and the
        // loser learns about it inside the same transaction that would have
        // clobbered them.
        const res = await tx.query<ProjectRow>(
          `UPDATE projects
              SET name = coalesce($2, name),
                description = coalesce($3, description),
                status = coalesce($4, status),
                tags = coalesce($5, tags),
                settings = coalesce($6::jsonb, settings),
                version = version + 1
          WHERE id = $1 AND tenant_id = app.current_tenant_id() AND version = $7
          RETURNING id, tenant_id, owner_id, name, slug, status, description, tags, settings,
                    version::int AS version, created_at, updated_at`,
          [
            id,
            patch.name ?? null,
            'description' in patch ? (patch.description ?? null) : null,
            patch.status ?? null,
            patch.tags ?? null,
            patch.settings ? JSON.stringify(patch.settings) : null,
            expectedVersion,
          ],
        );
        const row = res.rows[0];
        if (!row) {
          // Either it never existed in this tenant, someone deleted it, or its
          // version moved under us. RLS makes the first two indistinguishable *by
          // design*: we answer 404 and never confirm that another tenant's id exists.
          const current = await tx.query<{ version: number }>(
            'SELECT version::int AS version FROM projects WHERE id = $1',
            [id],
          );
          const found = current.rows[0];
          if (!found) {
            throw notFound('Project');
          }
          throw conflict('Project was modified by someone else; re-read it before writing again', {
            expectedVersion,
            currentVersion: found.version,
          });
        }
        await tx.query('SELECT app.audit($1,$2,$3,$4::jsonb)', [
          'project.updated',
          'project',
          row.id,
          JSON.stringify({ fields: Object.keys(patch) }),
        ]);
        const dto = toDto(row);
        await this.afterWrite(tenant, { id: dto.id, dto });
        return dto;
      },
    );
  }

  async remove(tenant: ResolvedTenant, actor: Requester, id: string): Promise<void> {
    // `role` matters here beyond the route check: the projects RLS policy has a
    // WITH CHECK of `is_at_least('member')`, and a DELETE of an *archived* row is
    // admin-only in the plan table of policies — so the GUC must carry the real
    // role rather than a placeholder.
    await this.db.withTenant(
      { tenantId: tenant.id, userId: actor.userId, role: actor.role },
      async (tx) => {
        const res = await tx.query('DELETE FROM projects WHERE id = $1 RETURNING id', [id]);
        if (res.rows.length === 0) {
          throw notFound('Project');
        }
        await tx.query('SELECT app.audit($1,$2,$3,$4::jsonb)', [
          'project.deleted',
          'project',
          id,
          '{}',
        ]);
        await this.afterWrite(tenant, { id, dto: null });
      },
    );
  }

  /**
   * Cache settlement after a write, for both key families:
   *
   *   - pages are *versioned* keys, so bumping the tenant's `projects` counter
   *     retires every cached page at once;
   *   - item keys are NOT versioned (see `CacheStore.itemKey`), so the specific
   *     entry has to be deleted. Forgetting that on a delete is a data bug, not a
   *     staleness wrinkle: the row is gone and the cache keeps serving it.
   */
  private async afterWrite(
    tenant: ResolvedTenant,
    mutation: { id: string; dto: ProjectDto | null },
  ): Promise<void> {
    await this.cache.invalidate(tenant.id, 'projects');
    await this.cache.deleteRaw(this.cache.itemKey(tenant.id, 'project', mutation.id));
    if (mutation.dto) {
      await this.cache.setItem(
        tenant.id,
        'project',
        mutation.dto.id,
        mutation.dto,
        CACHE_TTL_MS.projectItem * tenant.planLimits.cacheTtlScale,
      );
    }
  }

  /** Counts for the tenant summary; deliberately uncached (cheap, and a stale
   *  number on a quota screen is how you get support tickets). */
  async counts(tenantId: string): Promise<{ projects: number; archived: number }> {
    const rows = await this.db.withTenant(
      { tenantId, readOnly: true },
      async (tx) =>
        (
          await tx.query<{ projects: string; archived: string }>(
            `SELECT count(*)::text AS projects,
                  count(*) FILTER (WHERE status = 'archived')::text AS archived
             FROM projects`,
          )
        ).rows,
    );
    return {
      projects: Number(rows[0]?.projects ?? 0),
      archived: Number(rows[0]?.archived ?? 0),
    };
  }
}

function toDto(r: ProjectRow): ProjectDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    description: r.description,
    tags: r.tags ?? [],
    settings: r.settings ?? {},
    ownerId: r.owner_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    version: Number(r.version),
  } as ProjectDto & { version: number };
}

function cursorPayloadFor(dto: ProjectDto, sort: ListProjectsQuery['sort']): CursorPayload {
  const value =
    sort === 'name' ? dto.name.toLowerCase() : sort === 'updatedAt' ? dto.updatedAt : dto.createdAt;
  return { v: value, id: dto.id };
}

function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function weak(payload: unknown): string {
  // A weak ETag is the honest choice: the value is equivalent, not identical
  // (a cached page may have been produced by another replica).
  return `W/"${hash32(JSON.stringify(payload))}"`;
}

function hash32(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(36);
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

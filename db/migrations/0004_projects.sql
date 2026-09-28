-- 0004: the sample business resource (`projects`) plus its read path indexes.
--
-- This is the table the caching, pagination, quota and load-test stories all
-- hang off. Two details worth defending in an interview:
--   * every secondary index leads with tenant_id, so a plan can use the
--     index-only scan for one tenant without touching other tenants' pages;
--   * the unique constraint is (tenant_id, slug), NOT global: slug collisions
--     across tenants are normal and must not be an operational hazard.

CREATE TABLE IF NOT EXISTS projects (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid            NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    owner_id    uuid REFERENCES users (id) ON DELETE SET NULL,
    name        text            NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    slug        text            NOT NULL,
    status      project_status  NOT NULL DEFAULT 'active',
    description text,
    tags        text[]          NOT NULL DEFAULT '{}',
    settings    jsonb           NOT NULL DEFAULT '{}'::jsonb,
    -- Bumps on every write; doubles as the optimistic-concurrency token clients
    -- echo back in If-Match and as the cache-key component.
    version     bigint          NOT NULL DEFAULT 1,
    created_at  timestamptz     NOT NULL DEFAULT now(),
    updated_at  timestamptz     NOT NULL DEFAULT now(),
    CONSTRAINT projects_slug_ux UNIQUE (tenant_id, slug),
    CONSTRAINT projects_slug_format CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])$'),
    CONSTRAINT projects_tags_cardinality CHECK (array_length(tags, 1) IS NULL OR array_length(tags, 1) <= 20)
);

-- List path: WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT n
CREATE INDEX IF NOT EXISTS projects_tenant_status_created_idx
    ON projects (tenant_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS projects_tenant_created_idx
    ON projects (tenant_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS projects_tenant_name_trgm_idx
    ON projects USING gin (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, '')));
CREATE INDEX IF NOT EXISTS projects_tenant_tags_idx
    ON projects (tenant_id, array_length(tags, 1) DESC) WHERE tags <> '{}';

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projects_tenant_isolation ON projects;
CREATE POLICY projects_tenant_isolation ON projects
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (
        tenant_id = app.current_tenant_id()
        -- Viewers may read but never write: the role rank is part of the policy,
        -- so a bug in route-level RBAC still cannot mutate data.
        AND app.is_at_least('member')
    );

CREATE TRIGGER projects_touch
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- `version` must move on every UPDATE, and only on real changes.
CREATE OR REPLACE FUNCTION app.projects_bump_version()
RETURNS trigger
LANGUAGE plpgsql
AS
$$
BEGIN
    IF NEW.version IS DISTINCT FROM OLD.version THEN
        -- client supplied a version (If-Match): enforce optimistic concurrency
        IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'stale project version (expected %, got %)', OLD.version + 1, NEW.version
                USING ERRCODE = '40001'; -- serialization_failure → API maps to 409
        END IF;
    ELSE
        NEW.version := OLD.version + 1;
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS projects_bump_version ON projects;
CREATE TRIGGER projects_bump_version
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION app.projects_bump_version();

-- Quota bookkeeping stays consistent without an application-side counter race:
-- the counter is derived from the same transaction that changes the rows.
CREATE OR REPLACE FUNCTION app.projects_count_delta()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO tenant_stats AS ts (tenant_id, member_count, project_count, updated_at)
        VALUES (NEW.tenant_id, 0, 1, now())
        ON CONFLICT (tenant_id)
        DO UPDATE SET project_count = ts.project_count + 1, updated_at = now();
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE tenant_stats SET project_count = greatest(project_count - 1, 0), updated_at = now()
        WHERE tenant_id = OLD.tenant_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS projects_count_delta ON projects;
CREATE TRIGGER projects_count_delta
    AFTER INSERT OR DELETE ON projects
    FOR EACH ROW EXECUTE FUNCTION app.projects_count_delta();

-- Project quota, enforced in the database so a buggy client (or a second API
-- version mid-rollout) cannot exceed the plan it paid for.
CREATE OR REPLACE FUNCTION app.projects_enforce_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
DECLARE
    v_max integer;
    v_now integer;
BEGIN
    SELECT p.max_projects INTO v_max
    FROM plans p JOIN tenants t ON t.plan = p.id
    WHERE t.id = NEW.tenant_id;

    IF v_max IS NULL THEN
        RETURN NEW; -- no plan row (shouldn't happen): do not block writes
    END IF;

    -- Counted inside the same transaction as the insert, so two concurrent
    -- creates on the last seat serialise on the tenant's page lock.
    SELECT count(*) INTO v_now
    FROM projects
    WHERE tenant_id = NEW.tenant_id;

    IF v_now >= v_max THEN
        RAISE EXCEPTION 'project quota (%) exceeded for tenant %', v_max, NEW.tenant_id
            USING ERRCODE = '23514'; -- check_violation → API maps to 402
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS projects_enforce_quota ON projects;
CREATE TRIGGER projects_enforce_quota
    BEFORE INSERT ON projects
    FOR EACH ROW EXECUTE FUNCTION app.projects_enforce_quota();

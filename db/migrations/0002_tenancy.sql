-- 0002: tenants, users, memberships + the RLS policies that make tenancy real.
--
-- Isolation model (docs/adr/0001-shared-db-rls.md):
--   * one tablespace, tenant_id column everywhere, RLS on every tenant table;
--   * `tenants` itself is tenant-scoped too: a caller may only read its own row;
--   * `users` is a *global* identity (one person can join N workspaces), so its
--     policy is "you can see users who share your tenant", expressed as an
--     EXISTS over tenant_members;
--   * cross-tenant lookups that must happen *before* a tenant is known
--     (login, signup, tenant-by-slug) go through SECURITY DEFINER functions in
--     the app schema. That keeps "no broad SELECT" enforceable with GRANTs
--     instead of code review.

-- ------------------------------------------------------------- tenants ------
CREATE TABLE IF NOT EXISTS tenants (
    -- The API supplies a UUIDv7 (time-ordered → append-heavy B-tree); the DB
    -- default is a backstop for psql/seed/operator fixes, not the hot path.
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            text        NOT NULL,
    name            text        NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
    plan            text        NOT NULL DEFAULT 'free' REFERENCES plans (id),
    status          tenant_status NOT NULL DEFAULT 'active',
    settings        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    retention_days  integer     NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- slug is the subdomain label, so it must be lowercase and URL-safe.
    CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])$')
);

CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_uidx ON tenants (slug);

CREATE TRIGGER tenants_touch
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- --------------------------------------------------------------- users ------
-- Case-insensitive email without the citext extension dependency: a stored
-- generated column, which is indexable and portable.
CREATE TABLE IF NOT EXISTS users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           text        NOT NULL,
    email_norm      text        GENERATED ALWAYS AS (lower(btrim(email))) STORED,
    display_name    text,
    password_hash   text        NOT NULL,
    -- Lets us bump the cost model without invalidating logins.
    password_params text        NOT NULL DEFAULT 'argon2id:v19:m=19456,t=2,p=1',
    email_verified_at timestamptz,
    disabled_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_norm_uidx UNIQUE (email_norm)
);

CREATE INDEX IF NOT EXISTS users_email_norm_bidx ON users (email_norm varchar_pattern_ops);

CREATE TRIGGER users_touch
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -------------------------------------------------------- memberships ------
CREATE TABLE IF NOT EXISTS tenant_members (
    tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role            member_role NOT NULL DEFAULT 'member',
    status          member_status NOT NULL DEFAULT 'active',
    invited_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    joined_at       timestamptz,
    last_seen_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS tenant_members_user_idx ON tenant_members (user_id);
-- Exactly one owner per tenant, enforced in the database (not by app code).
CREATE UNIQUE INDEX IF NOT EXISTS tenant_members_one_owner_ux
    ON tenant_members (tenant_id)
    WHERE role = 'owner' AND status = 'active';

CREATE TRIGGER tenant_members_touch
    BEFORE UPDATE ON tenant_members
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Cheaper than a COUNT(*) on the hot quota check path.
CREATE TABLE IF NOT EXISTS tenant_stats (
    tenant_id       uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
    member_count    integer NOT NULL DEFAULT 0 CHECK (member_count >= 0),
    project_count   integer NOT NULL DEFAULT 0 CHECK (project_count >= 0),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------- RLS: tenants -----
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_self_select ON tenants;
CREATE POLICY tenants_self_select ON tenants
    FOR SELECT
    USING (id = app.current_tenant_id());

-- A tenant row is only mutated through app.update_tenant_* helpers or by an
-- operator with BYPASSRLS; members may edit their own workspace settings.
DROP POLICY IF EXISTS tenants_owner_update ON tenants;
CREATE POLICY tenants_owner_update ON tenants
    FOR UPDATE
    USING (id = app.current_tenant_id() AND app.current_tenant_role() IN ('owner', 'admin'))
    WITH CHECK (id = app.current_tenant_id());

-- ----------------------------------------------------------- RLS: users -----
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_shared_tenant_select ON users;
CREATE POLICY users_shared_tenant_select ON users
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM tenant_members me
            WHERE me.user_id = users.id
              AND me.tenant_id = app.current_tenant_id()
              AND me.status = 'active'
        )
    );

DROP POLICY IF EXISTS users_self_update ON users;
CREATE POLICY users_self_update ON users
    FOR UPDATE
    USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid)
    WITH CHECK (id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- ------------------------------------------------------ RLS: memberships ----
ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_members FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_members_tenant_isolation ON tenant_members;
CREATE POLICY tenant_members_tenant_isolation ON tenant_members
    FOR SELECT
    USING (tenant_id = app.current_tenant_id());

-- Writes need an admin inside the tenant: otherwise `member` could promote
-- itself (the tenant_id predicate alone does not stop that, because the row it
-- edits *is* its own membership row).
DROP POLICY IF EXISTS tenant_members_admin_write ON tenant_members;
CREATE POLICY tenant_members_admin_write ON tenant_members
    FOR ALL
    USING (tenant_id = app.current_tenant_id() AND app.is_at_least('admin'))
    WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_at_least('admin'));

ALTER TABLE tenant_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_stats FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_stats_tenant_isolation ON tenant_stats;
CREATE POLICY tenant_stats_tenant_isolation ON tenant_stats
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- --------------------------------------- SECURITY DEFINER escape hatches -----
-- These are the *only* ways to touch identity data without a tenant context,
-- and each is narrow on purpose: no "run any query" helper, no RETURN * of
-- whole tables.

-- Login: resolve an email to a user before any tenant is known.
CREATE OR REPLACE FUNCTION app.find_user_by_email(p_email text)
RETURNS TABLE (
    user_id uuid,
    email text,
    password_hash text,
    disabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS
$$
    SELECT u.id, u.email, u.password_hash, u.disabled_at IS NOT NULL
    FROM users u
    WHERE u.email_norm = lower(btrim(p_email))
$$;

REVOKE ALL ON FUNCTION app.find_user_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_user_by_email(text) TO app_user;

-- Tenant discovery for login: which workspaces may this user join?
CREATE OR REPLACE FUNCTION app.tenants_for_user(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, slug text, name text, plan text, role member_role)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS
$$
    SELECT m.tenant_id, t.slug, t.name, t.plan, m.role
    FROM tenant_members m
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = p_user_id
      AND m.status = 'active'
      AND t.status = 'active'
    ORDER BY t.name
$$;

REVOKE ALL ON FUNCTION app.tenants_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenants_for_user(uuid) TO app_user;

CREATE OR REPLACE FUNCTION app.tenant_by_slug(p_slug text)
RETURNS TABLE (tenant_id uuid, plan text, status tenant_status)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS
$$
    SELECT t.id, t.plan, t.status FROM tenants t WHERE t.slug = p_slug
$$;

REVOKE ALL ON FUNCTION app.tenant_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_by_slug(text) TO app_user;

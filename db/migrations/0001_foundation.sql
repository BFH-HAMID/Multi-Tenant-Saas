-- 0001: enums and the plans catalogue.
--
-- Roles, the `app` schema and every policy helper live in 0000_app_schema.sql.

DO
$$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tenant_status') THEN
        CREATE TYPE tenant_status AS ENUM ('active', 'suspended', 'cancelled');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_role') THEN
        CREATE TYPE member_role AS ENUM ('owner', 'admin', 'member', 'viewer');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_status') THEN
        CREATE TYPE member_status AS ENUM ('active', 'invited', 'disabled');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_status') THEN
        CREATE TYPE project_status AS ENUM ('active', 'archived');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'outbox_status') THEN
        CREATE TYPE outbox_status AS ENUM ('pending', 'published', 'failed', 'discarded');
    END IF;
END
$$;

-- -------------------------------------------------------------- plans -------
-- Reporting/billing mirror of packages/shared/src/plans.ts. The request path
-- resolves limits from the code catalogue (one fewer query per request); this
-- table exists so psql, analytics and an admin UI have an authoritative
-- snapshot of what was sold, and so `ALTER TENANT ... SET app.plan` style
-- experiments have somewhere to live.
CREATE TABLE IF NOT EXISTS plans (
    id                  text PRIMARY KEY CHECK (id IN ('free', 'pro', 'enterprise')),
    display_name        text          NOT NULL,
    max_members         integer       NOT NULL CHECK (max_members > 0),
    max_projects        integer       NOT NULL CHECK (max_projects > 0),
    max_concurrent_jobs integer       NOT NULL CHECK (max_concurrent_jobs > 0),
    cache_ttl_scale     numeric(4, 2) NOT NULL DEFAULT 1,
    rate_limits         jsonb         NOT NULL,
    CHECK (jsonb_typeof(rate_limits) = 'object')
);

INSERT INTO plans (id, display_name, max_members, max_projects, max_concurrent_jobs, cache_ttl_scale, rate_limits)
VALUES
    ('free', 'Free', 5, 10, 1, 1,
     '{"read":{"capacity":120,"refillPerSec":5},"write":{"capacity":30,"refillPerSec":1},"auth":{"capacity":10,"refillPerSec":0.3333},"bulk":{"capacity":2,"refillPerSec":0.0333}}'),
    ('pro', 'Pro', 50, 250, 5, 2,
     '{"read":{"capacity":1200,"refillPerSec":100},"write":{"capacity":300,"refillPerSec":20},"auth":{"capacity":60,"refillPerSec":2},"bulk":{"capacity":20,"refillPerSec":0.5}}'),
    ('enterprise', 'Enterprise', 5000, 100000, 50, 4,
     '{"read":{"capacity":12000,"refillPerSec":1000},"write":{"capacity":3000,"refillPerSec":200},"auth":{"capacity":600,"refillPerSec":20},"bulk":{"capacity":200,"refillPerSec":5}}')
ON CONFLICT (id) DO UPDATE
SET display_name        = EXCLUDED.display_name,
    max_members         = EXCLUDED.max_members,
    max_projects        = EXCLUDED.max_projects,
    max_concurrent_jobs = EXCLUDED.max_concurrent_jobs,
    cache_ttl_scale     = EXCLUDED.cache_ttl_scale,
    rate_limits         = EXCLUDED.rate_limits;

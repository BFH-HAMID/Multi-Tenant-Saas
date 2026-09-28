-- 0000: application schema + the helpers every policy depends on.
--
-- Runs first, and defines nothing that references a table, so that later
-- migrations can use these functions inside CREATE POLICY (policies are parsed
-- and validated at creation time — a forward reference would fail the
-- migration).

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------- roles -----
-- app_user      : the role the API and worker connect as. No BYPASSRLS, no DDL,
--                 no cross-tenant SELECT — every read is policy-filtered.
-- app_migrator  : owns objects; used by the migration runner only.
-- app_admin     : BYPASSRLS. Never a login role: reachable only as the definer
--                 of the narrow SECURITY DEFINER functions below.
DO
$$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
        CREATE ROLE app_migrator NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
        CREATE ROLE app_admin NOLOGIN NOINHERIT BYPASSRLS;
    END IF;
END
$$;

-- Membership in the bypass role is what lets a SECURITY DEFINER function escape
-- RLS; the *login* role never has it.
GRANT app_admin TO CURRENT_USER;

GRANT USAGE ON SCHEMA app TO app_user;

-- ------------------------------------------------- request-scoped GUCs ------
-- The API sets these with SET LOCAL inside each request transaction:
--   app.tenant_id   uuid  — resolved tenant (RLS anchor)
--   app.user_id     uuid  — authenticated caller
--   app.tenant_role text  — role inside that tenant (owner/admin/member/viewer)
--   app.request_id  text  — correlation id, lands in audit_log
-- SET LOCAL (not SET) matters: the value is rolled back with the transaction, so
-- a pooled connection can never carry tenant A's context into tenant B's query.

CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.current_tenant_role()
RETURNS text
LANGUAGE sql
STABLE
AS
$$ SELECT NULLIF(current_setting('app.tenant_role', true), '') $$;

CREATE OR REPLACE FUNCTION app.current_request_id()
RETURNS text
LANGUAGE sql
STABLE
AS
$$ SELECT NULLIF(current_setting('app.request_id', true), '') $$;

CREATE OR REPLACE FUNCTION app.require_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS
$$
DECLARE
    tid uuid := app.current_tenant_id();
BEGIN
    IF tid IS NULL THEN
        RAISE EXCEPTION 'app.tenant_id is not set (missing tenant context)'
            USING ERRCODE = '42501'; -- insufficient_privilege, not a server error
    END IF;
    RETURN tid;
END
$$;

CREATE OR REPLACE FUNCTION app.require_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS
$$
DECLARE
    uid uuid := app.current_user_id();
BEGIN
    IF uid IS NULL THEN
        RAISE EXCEPTION 'app.user_id is not set (missing caller context)'
            USING ERRCODE = '42501';
    END IF;
    RETURN uid;
END
$$;

CREATE OR REPLACE FUNCTION app.is_at_least(required text)
RETURNS boolean
LANGUAGE sql
STABLE
AS
$$
    -- Rank-based instead of a set membership test per route, so "admin can do
    -- everything a member can" is one number comparison.
    SELECT coalesce(
        CASE app.current_tenant_role()
            WHEN 'owner' THEN 40
            WHEN 'admin' THEN 30
            WHEN 'member' THEN 20
            WHEN 'viewer' THEN 10
            ELSE 0
        END
        >=
        CASE required
            WHEN 'owner' THEN 40
            WHEN 'admin' THEN 30
            WHEN 'member' THEN 20
            WHEN 'viewer' THEN 10
            ELSE 100
        END,
        false
    )
$$;

-- ------------------------------------------------------------- triggers -----
CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS
$$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END
$$;

COMMENT ON SCHEMA app IS 'Multi-tenant plumbing: helpers, definer functions, no tables.';
COMMENT ON FUNCTION app.current_tenant_id() IS 'Tenant id from the per-transaction GUC; NULL means "no tenant context" and fail-closes every policy.';

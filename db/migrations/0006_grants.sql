-- 0006: privileges. RLS decides *which rows*; grants decide *which verbs*.
-- Both are needed: without the REVOKEs a future table added without a policy
-- would be readable by the app role by default.

-- ----------------------------------------------------------- app_user -------
-- The runtime role. Table-level DML yes, but never TRUNCATE/REFERENCES/TRIGGER
-- and never the migration bookkeeping table.
GRANT USAGE ON SCHEMA public, app TO app_user;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    tenants,
    users,
    tenant_members,
    tenant_stats,
    projects,
    refresh_tokens,
    invitations,
    outbox,
    idempotency_keys,
    audit_log
TO app_user;

GRANT SELECT ON plans TO app_user;
GRANT SELECT ON app.outbox_depth TO app_user;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC; -- no temp tables, no sneaked-in types
REVOKE ALL ON tenants FROM app_user;
GRANT SELECT, UPDATE ON tenants TO app_user; -- tenants rows: read + settings only
REVOKE ALL ON plans FROM PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA app   GRANT EXECUTE ON FUNCTIONS TO app_user;

-- Only the narrow helpers are executable; everything else in `app` is internal.
GRANT EXECUTE ON FUNCTION
    app.current_tenant_id(),
    app.current_user_id(),
    app.current_tenant_role(),
    app.current_request_id(),
    app.require_tenant_id(),
    app.require_user_id(),
    app.is_at_least(text),
    app.find_user_by_email(text),
    app.tenants_for_user(uuid),
    app.tenant_by_slug(text),
    app.register_tenant(uuid, text, text, text, uuid, text, text, text, text),
    app.accept_invitation(char(64)),
    app.revoke_family(uuid, uuid, text),
    app.outbox_enqueue(uuid, text, jsonb, text),
    app.outbox_claim(integer, integer),
    app.outbox_mark_published(bigint[]),
    app.outbox_mark_failed(bigint, text, integer),
    app.audit(text, text, text, jsonb)
TO app_user;

-- ------------------------------------------------------ definer owners ------
-- SECURITY DEFINER functions run with their *owner's* rights. Owning them with
-- app_admin (BYPASSRLS, NOLOGIN) instead of a superuser means the escape hatch
-- from RLS is a role that cannot be logged into and has no DDL rights.
DO
$$
BEGIN
    -- Skip silently when the migration is executed by a superuser-managed
    -- service (e.g. RDS master) that is not a member of app_admin.
    IF exists (SELECT 1 FROM pg_auth_members) AND current_setting('is_superuser') = 'on' THEN
        BEGIN
            ALTER FUNCTION app.find_user_by_email(text) OWNER TO app_admin;
            ALTER FUNCTION app.tenants_for_user(uuid) OWNER TO app_admin;
            ALTER FUNCTION app.tenant_by_slug(text) OWNER TO app_admin;
            ALTER FUNCTION app.register_tenant(uuid, text, text, text, uuid, text, text, text, text) OWNER TO app_admin;
            ALTER FUNCTION app.accept_invitation(char(64)) OWNER TO app_admin;
            ALTER FUNCTION app.revoke_family(uuid, uuid, text) OWNER TO app_admin;
            ALTER FUNCTION app.outbox_claim(integer, integer) OWNER TO app_admin;
            ALTER FUNCTION app.outbox_mark_published(bigint[]) OWNER TO app_admin;
            ALTER FUNCTION app.outbox_mark_failed(bigint, text, integer) OWNER TO app_admin;
            ALTER FUNCTION app.audit(text, text, text, jsonb) OWNER TO app_admin;
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'could not reassign definer functions to app_admin (running as %); leaving owners as-is', CURRENT_USER;
        END;
    END IF;
END
$$;

-- app_admin needs the data rights to do what those functions do, but nothing
-- else: no CREATE, no TRUNCATE.
GRANT SELECT, INSERT, UPDATE ON
    tenants, users, tenant_members, tenant_stats, projects,
    refresh_tokens, invitations, outbox, idempotency_keys, audit_log
TO app_admin;
GRANT USAGE ON SCHEMA public TO app_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO app_admin;

-- ---------------------------------------------------------------- check ----
-- A guard rail for future migrations: any tenant table (has tenant_id) must have
-- RLS enabled and enforced. The test in db/tests/schemaInvariants.int.test.ts
-- asserts the same thing from SQL, so this comment is not the only defence.
CREATE OR REPLACE VIEW app.unprotected_tenant_tables AS
SELECT c.oid::regclass AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname = 'public'
  AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
  )
  AND (c.relrowsecurity IS NOT TRUE OR c.relforcerowsecurity IS NOT TRUE);

COMMENT ON VIEW app.unprotected_tenant_tables IS
    'Must always be empty: every public table with a tenant_id column must have RLS enabled AND forced.';

GRANT SELECT ON app.unprotected_tenant_tables TO app_user;

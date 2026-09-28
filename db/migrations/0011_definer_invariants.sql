-- 0011: make the SECURITY DEFINER contract a property of the schema, not of each
-- migration author's memory.
--
-- Why this exists: a definer function runs as its *owner*, and ownership is
-- whatever role happened to execute the CREATE FUNCTION. In development that is a
-- superuser (which silently bypasses both RLS and schema privileges), so a
-- function that only works for a superuser looks fine right up until it runs in
-- production. That is exactly what happened with `app.audit`: its body calls
-- `app.current_tenant_id()`, and the owner at the time had no USAGE on schema
-- `app`, so every write path that audits itself failed with
-- "permission denied for schema app" — a 42501 surfaced as 403.
--
-- This migration therefore enforces the invariant for *all* definer functions in
-- `app`, present and future (it is idempotent, and `db/tests/schemaInvariants`
-- asserts the same properties on every CI run):
--   1. app_admin may read the app schema (the helpers live there);
--   2. every SECURITY DEFINER function in app is owned by app_admin, so its
--      privileges are a fixed, auditable set instead of "whoever deployed last";
--   3. each one pins `search_path = public, app` (otherwise a caller could shadow
--      an unqualified name via `pg_temp`);
--   4. EXECUTE is granted to app_user and revoked from PUBLIC — the callable set
--      is explicit;
--   5. no definer function is left owned by a login role.

GRANT USAGE ON SCHEMA app TO app_admin;

-- Re-owning a definer function changes the privileges it runs *with*, so the new
-- owner needs exactly the rights its body uses. These two are the tables that
-- only later migrations made reachable from definer code: `plans` (the project
-- quota trigger is SECURITY DEFINER and reads the plan row) and `report_jobs`
-- (the worker-side state machine). Without these the failure mode is a 42501
-- raised from inside a trigger — which the API maps to a 403 and which is
-- completely inexplicable unless you know who owns the function.
GRANT SELECT ON plans TO app_admin;
GRANT SELECT, INSERT, UPDATE ON report_jobs TO app_admin;

-- The same reasoning applies to DELETE: `app.idempotency_prune`,
-- `app.prune_sessions` and the outbox publisher all *remove* rows from inside a
-- definer function. 0006 gave app_admin SELECT/INSERT/UPDATE only, so those
-- helpers raised "permission denied for table …" — from a maintenance path that
-- runs once at boot, where the error is invisible unless someone reads the log.
GRANT DELETE ON
    tenants, users, tenant_members, tenant_stats, projects,
    refresh_tokens, invitations, outbox, idempotency_keys, audit_log, report_jobs
TO app_admin;

-- The sweep, as a callable function: 0011 runs it once, and any later migration
-- that adds a definer helper ends with `SELECT app.enforce_definer_invariants();`
-- instead of copy-pasting this block (copies of an invariant are how an
-- invariant stops being true).
-- Deliberately NOT security definer: this function changes function *ownership*,
-- which only the current owner (the migration role) may do. Wrapping it in
-- SECURITY DEFINER would run it as app_admin — which owns nothing at that moment
-- — and every later migration that calls it would fail with "must be owner of
-- function …". It is a DDL utility, so it is callable by nobody but the migrator.
CREATE OR REPLACE FUNCTION app.enforce_definer_invariants()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, app
AS
$$
DECLARE
    r record;
    n integer := 0;
BEGIN
    FOR r IN
        SELECT p.oid, p.proname, nsp.nspname
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace nsp ON nsp.oid = p.pronamespace
        WHERE nsp.nspname = 'app'
          AND p.prosecdef
    LOOP
        EXECUTE format('ALTER FUNCTION %s.%s OWNER TO app_admin', quote_ident(r.nspname), r.proname);
        EXECUTE format('ALTER FUNCTION %s.%s SET search_path = public, app', quote_ident(r.nspname), r.proname);
        EXECUTE format('REVOKE ALL ON FUNCTION %s.%s FROM PUBLIC', quote_ident(r.nspname), r.proname);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s.%s TO app_user', quote_ident(r.nspname), r.proname);
        n := n + 1;
    END LOOP;
    RETURN n;
END
$$;

SELECT app.enforce_definer_invariants();

REVOKE ALL ON FUNCTION app.enforce_definer_invariants() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_definer_invariants() FROM app_user;

-- Triggers are not SECURITY DEFINER, but their functions still must not depend on
-- the session's search_path; pin it for everything in `app` that is not a
-- *support* function owned by the schema administrator.
DO
$$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.oid, p.proname, n.nspname
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.prosecdef = false
          AND p.proconfig IS NULL
    LOOP
        EXECUTE format('ALTER FUNCTION %s.%s SET search_path = public, app', quote_ident(r.nspname), r.proname);
    END LOOP;
END
$$;

-- Views in `app` (e.g. `app.outbox_depth`) are expanded at query time with the
-- *caller's* privileges, so they must be plain views over RLS-protected tables —
-- never a security boundary. Assert nothing in app is a matview (which would
-- bypass RLS for its readers).
DO
$$
DECLARE
    v_kind text;
BEGIN
    SELECT c.relpersistence INTO v_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app'
      AND c.relkind = 'm'
    LIMIT 1;
    IF v_kind IS NOT NULL THEN
        RAISE EXCEPTION 'materialized view in schema app: matviews bypass RLS for their readers';
    END IF;
END
$$;

-- 0009: idempotency accessors, self-service tenant creation, and one privilege
-- fix found while wiring the API.
--
-- (1) Idempotency: the request pipeline needs to consult the durable record
--     *before* a tenant context exists (the preHandler runs outside the
--     business transaction), and to write it *after* that transaction is gone.
--     Rather than setting the GUC twice per request, the lookup/update pair is a
--     narrow definer function that takes the tenant id explicitly.
-- (2) `POST /v1/tenants` creates an additional workspace for an existing user;
--     `tenants` has no INSERT policy for the app role on purpose (tenant
--     provisioning is a controlled operation), so it goes through a function.
-- (3) `invitations` had a tenant-scoped policy but no role check, which let any
--     member insert an invitation *for their own address* with role=admin and
--     then walk `app.accept_invitation` straight into ownership privileges.
--     The tenant boundary was correct; the authorisation inside it was not. This
--     is the pattern worth remembering: RLS answers "whose rows?", never "may
--     this actor do this?".

-- ------------------------------------------------------------ privilege fix --
DROP POLICY IF EXISTS invitations_tenant_isolation ON invitations;
CREATE POLICY invitations_tenant_isolation ON invitations
    FOR SELECT
    USING (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS invitations_admin_write ON invitations;
CREATE POLICY invitations_admin_write ON invitations
    FOR ALL
    USING (tenant_id = app.current_tenant_id() AND app.is_at_least('admin'))
    WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_at_least('admin'));

-- ------------------------------------------------------------- idempotency --
-- 'new'      → caller may proceed (and must then reserve the key in its tx)
-- 'replay'   → return the stored response verbatim
-- 'inflight' → a concurrent request with this key has not finished
-- 'conflict' → same key, different request fingerprint
CREATE OR REPLACE FUNCTION app.idempotency_lookup(
    p_tenant uuid,
    p_key text,
    p_hash text
)
RETURNS TABLE (state text, response_status integer, response_body jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS
$$
    SELECT CASE
               WHEN k.completed_at IS NULL AND k.request_hash = p_hash THEN 'inflight'
               WHEN k.completed_at IS NOT NULL AND k.request_hash = p_hash THEN 'replay'
               WHEN k.request_hash <> p_hash THEN 'conflict'
               ELSE 'new'
           END,
           CASE WHEN k.completed_at IS NOT NULL THEN k.response_status END,
           CASE WHEN k.completed_at IS NOT NULL THEN k.response_body END
    FROM idempotency_keys k
    WHERE k.tenant_id = p_tenant
      AND k.key = p_key
      AND k.expires_at > now()
$$;

-- Reserve inside the caller's transaction: if the transaction rolls back, the
-- reservation disappears with it, so a failed request never burns a key.
CREATE OR REPLACE FUNCTION app.idempotency_reserve(
    p_tenant uuid,
    p_key text,
    p_hash text,
    p_ttl_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
BEGIN
    -- A stored-but-expired row is *renewed*, not treated as a conflict: the
    -- window we promise is a TTL, and the janitor has not got to it yet.
    INSERT INTO idempotency_keys (tenant_id, key, request_hash, expires_at)
    VALUES (p_tenant, p_key, p_hash, now() + make_interval(secs => greatest(60, p_ttl_seconds)))
    ON CONFLICT (tenant_id, key) DO UPDATE
        SET request_hash = EXCLUDED.request_hash,
            expires_at = EXCLUDED.expires_at,
            completed_at = NULL,
            response_status = NULL,
            response_body = NULL
        WHERE idempotency_keys.expires_at < now();

    IF FOUND THEN
        RETURN true;
    END IF;

    -- Row exists and is live: same fingerprint is a genuine retry (the caller
    -- replays), a different one is a client bug we must surface.
    IF EXISTS (
        SELECT 1 FROM idempotency_keys
        WHERE tenant_id = p_tenant AND key = p_key AND request_hash <> p_hash
    ) THEN
        RAISE EXCEPTION 'idempotency key reused with a different request' USING ERRCODE = '40001';
    END IF;
    RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION app.idempotency_complete(
    p_tenant uuid,
    p_key text,
    p_status integer,
    p_body jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS
$$
    UPDATE idempotency_keys
    SET response_status = p_status,
        response_body = p_body,
        completed_at = now()
    WHERE tenant_id = p_tenant
      AND key = p_key
      AND completed_at IS NULL
$$;

CREATE OR REPLACE FUNCTION app.idempotency_release(p_tenant uuid, p_key text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS
$$
    DELETE FROM idempotency_keys
    WHERE tenant_id = p_tenant AND key = p_key AND completed_at IS NULL
$$;

CREATE OR REPLACE FUNCTION app.idempotency_prune(p_batch integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
DECLARE
    n integer;
BEGIN
    WITH del AS (
        DELETE FROM idempotency_keys
        WHERE (tenant_id, key) IN (
            SELECT tenant_id, key FROM idempotency_keys
            WHERE expires_at < now()
            LIMIT p_batch
            FOR UPDATE SKIP LOCKED
        )
        RETURNING 1
    )
    SELECT count(*) INTO n FROM del;
    RETURN n;
END
$$;

-- ---------------------------------------------------- tenant self-service ---
CREATE OR REPLACE FUNCTION app.create_tenant_for_user(
    p_tenant_id uuid,
    p_slug text,
    p_name text,
    p_plan text,
    p_user_id uuid
)
RETURNS TABLE (o_tenant_id uuid, o_role member_role, o_plan text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
DECLARE
    v_slug text := lower(btrim(p_slug));
BEGIN
    IF v_slug !~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])$' THEN
        RAISE EXCEPTION 'invalid tenant slug' USING ERRCODE = '22023';
    END IF;
    IF p_plan NOT IN ('free', 'pro', 'enterprise') THEN
        RAISE EXCEPTION 'unknown plan %', p_plan USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM tenants WHERE slug = v_slug) THEN
        RAISE EXCEPTION 'tenant slug % is taken', v_slug USING ERRCODE = '23505';
    END IF;

    -- One workspace per tenant per user; a user joining an existing workspace
    -- happens through an invitation, never through this function.
    INSERT INTO tenants (id, slug, name, plan)
    VALUES (p_tenant_id, v_slug, btrim(p_name), p_plan)
    RETURNING tenants.id INTO o_tenant_id;

    INSERT INTO tenant_members (tenant_id, user_id, role, status, joined_at)
    VALUES (o_tenant_id, p_user_id, 'owner', 'active', now())
    RETURNING tenant_members.role INTO o_role;

    INSERT INTO tenant_stats (tenant_id, member_count, project_count)
    VALUES (o_tenant_id, 1, 0)
    ON CONFLICT (tenant_id) DO NOTHING;

    o_plan := p_plan;
    RETURN NEXT;
END
$$;

-- --------------------------------------------------------------- grants -----
REVOKE ALL ON FUNCTION app.idempotency_lookup(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.idempotency_reserve(uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.idempotency_complete(uuid, text, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.idempotency_release(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.idempotency_prune(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_tenant_for_user(uuid, text, text, text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.idempotency_lookup(uuid, text, text) TO app_user;
GRANT EXECUTE ON FUNCTION app.idempotency_reserve(uuid, text, text, integer) TO app_user;
GRANT EXECUTE ON FUNCTION app.idempotency_complete(uuid, text, integer, jsonb) TO app_user;
GRANT EXECUTE ON FUNCTION app.idempotency_release(uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION app.idempotency_prune(integer) TO app_user;
GRANT EXECUTE ON FUNCTION app.create_tenant_for_user(uuid, text, text, text, uuid) TO app_user;

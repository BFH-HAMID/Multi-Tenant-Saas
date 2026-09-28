-- 0008: the identity/session escape hatches, expressed as SQL.
--
-- Why session rotation lives here rather than in the API: the operation is
-- "read the presented token, mark it rotated, insert its successor, and — if it
-- was already used — kill the whole family". As three application queries that
-- is a check-then-act race that a concurrent double-refresh can win (two valid
-- sessions from one stolen token, with reuse detection defeated). As one
-- SECURITY DEFINER function it is a single atomic statement, and the API role
-- still needs no SELECT on `refresh_tokens` across tenants.

-- Tenant lookup *before* a tenant context exists (login, /v1/tenants).
CREATE OR REPLACE FUNCTION app.tenant_by_id(p_tenant_id uuid)
RETURNS TABLE (tenant_id uuid, slug text, name text, plan text, status tenant_status, retention_days integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS
$$
    SELECT t.id, t.slug, t.name, t.plan, t.status, t.retention_days
    FROM tenants t
    WHERE t.id = p_tenant_id
$$;

CREATE OR REPLACE FUNCTION app.membership_role(p_user_id uuid, p_tenant_id uuid)
RETURNS TABLE (role member_role, status member_status, tenant_plan text, tenant_status tenant_status)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS
$$
    SELECT m.role, m.status, t.plan, t.status
    FROM tenant_members m
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = p_user_id
      AND m.tenant_id = p_tenant_id
$$;

-- Touch presence without granting UPDATE on tenant_members.
CREATE OR REPLACE FUNCTION app.touch_membership(p_user_id uuid, p_tenant_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS
$$
    UPDATE tenant_members
    SET last_seen_at = now()
    WHERE user_id = p_user_id
      AND tenant_id = p_tenant_id
      AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')
$$;

-- Login: mint a session family.
CREATE OR REPLACE FUNCTION app.session_login(
    p_user_id uuid,
    p_tenant_id uuid,
    p_digest char(64),
    p_ip inet,
    p_user_agent text,
    p_ttl_days integer
)
-- OUT columns are o_-prefixed everywhere in this repo: plpgsql substitutes any
-- identifier in a SQL statement that matches a variable, and an OUT column named
-- `expires_at` next to a real `expires_at` column is "column reference is
-- ambiguous".
RETURNS TABLE (o_session_id uuid, o_family_id uuid, o_expires_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS
$$
    WITH ins AS (
        INSERT INTO refresh_tokens (id, tenant_id, user_id, family_id, token_digest, created_by_ip, user_agent, expires_at)
        VALUES (
            gen_random_uuid(), p_tenant_id, p_user_id, gen_random_uuid(), p_digest, p_ip,
            left(nullif(btrim(coalesce(p_user_agent, '')), ''), 400),
            now() + make_interval(days => greatest(1, p_ttl_days))
        )
        RETURNING id, family_id, expires_at
    )
    SELECT i.id, i.family_id, i.expires_at FROM ins i
$$;

-- Refresh: rotate, or detect reuse. One statement, so the race does not exist.
--   'ok'        → rotated; the caller got a new token
--   'reused'    → this digest had already been spent: family revoked
--   'expired'   → present but past expiry
--   'unknown'   → no such digest (also the wrong-tenant case)
CREATE OR REPLACE FUNCTION app.session_rotate(
    p_digest char(64),
    p_new_digest char(64),
    p_ip inet,
    p_user_agent text,
    p_ttl_days integer
)
RETURNS TABLE (
    o_result text,
    o_user_id uuid,
    o_tenant_id uuid,
    o_role member_role,
    o_session_id uuid,
    o_family_id uuid,
    o_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
DECLARE
    cur refresh_tokens%ROWTYPE;
    v_role member_role;
    v_new record;
BEGIN
    SELECT * INTO cur
    FROM refresh_tokens
    WHERE token_digest = p_digest
    FOR UPDATE;                    -- serialises concurrent rotations of the same token

    IF NOT FOUND THEN
        o_result := 'unknown';
        RETURN NEXT;
        RETURN;
        RETURN;
    END IF;

    IF cur.revoked_at IS NOT NULL OR cur.replaced_by IS NOT NULL THEN
        PERFORM app.revoke_family(cur.tenant_id, cur.family_id, 'refresh-reuse');
        o_result := 'reused';
        o_user_id := cur.user_id;
        o_tenant_id := cur.tenant_id;
        o_family_id := cur.family_id;
        RETURN NEXT;
        RETURN;
    END IF;

    IF cur.expires_at <= now() THEN
        UPDATE refresh_tokens SET revoked_at = now() WHERE id = cur.id;
        o_result := 'expired';
        o_user_id := cur.user_id;
        o_tenant_id := cur.tenant_id;
        o_family_id := cur.family_id;
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT m.role INTO v_role
    FROM tenant_members m
    WHERE m.user_id = cur.user_id AND m.tenant_id = cur.tenant_id AND m.status = 'active';

    IF v_role IS NULL THEN
        PERFORM app.revoke_family(cur.tenant_id, cur.family_id, 'membership-lapsed');
        o_result := 'revoked';
        o_user_id := cur.user_id;
        o_tenant_id := cur.tenant_id;
        o_family_id := cur.family_id;
        RETURN NEXT;
        RETURN;
    END IF;

    INSERT INTO refresh_tokens (id, tenant_id, user_id, family_id, token_digest, created_by_ip, user_agent, expires_at)
    VALUES (
        gen_random_uuid(), cur.tenant_id, cur.user_id, cur.family_id, p_new_digest, p_ip,
        left(nullif(btrim(coalesce(p_user_agent, '')), ''), 400),
        now() + make_interval(days => greatest(1, p_ttl_days))
    )
    RETURNING id, expires_at INTO v_new;

    UPDATE refresh_tokens
    SET replaced_by = v_new.id, rotated_at = now()
    WHERE id = cur.id;

    o_result := 'ok';
    o_user_id := cur.user_id;
    o_tenant_id := cur.tenant_id;
    o_role := v_role;
    o_session_id := v_new.id;
    o_family_id := cur.family_id;
    o_expires_at := v_new.expires_at;
    RETURN NEXT;
END
$$;

-- Logout / revocation of a single session.
CREATE OR REPLACE FUNCTION app.session_revoke(p_digest char(64))
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS
$$
    WITH f AS (
        SELECT tenant_id, family_id FROM refresh_tokens WHERE token_digest = p_digest
    ), d AS (
        UPDATE refresh_tokens rt
        SET revoked_at = now(), user_agent = coalesce(rt.user_agent, '') || ' | logout'
        FROM f
        WHERE rt.tenant_id = f.tenant_id AND rt.family_id = f.family_id AND rt.revoked_at IS NULL
        RETURNING 1
    )
    SELECT count(*)::integer FROM d
$$;

CREATE OR REPLACE FUNCTION app.session_revoke_all(p_user_id uuid, p_tenant_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS
$$
    WITH d AS (
        UPDATE refresh_tokens
        SET revoked_at = now(), user_agent = coalesce(user_agent, '') || ' | logout-all'
        WHERE user_id = p_user_id AND tenant_id = p_tenant_id AND revoked_at IS NULL
        RETURNING 1
    )
    SELECT count(*)::integer FROM d
$$;

-- Sessions list for "sign out everywhere else".
CREATE OR REPLACE FUNCTION app.sessions_for(p_user_id uuid, p_tenant_id uuid, p_current_id uuid)
RETURNS TABLE (o_id uuid, o_created_at timestamptz, o_user_agent text, o_ip inet, o_current boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS
$$
    SELECT rt.id, rt.created_at, rt.user_agent, rt.created_by_ip, rt.id = p_current_id
    FROM refresh_tokens rt
    WHERE rt.user_id = p_user_id
      AND rt.tenant_id = p_tenant_id
      AND rt.revoked_at IS NULL
      AND rt.expires_at > now()
    ORDER BY rt.created_at DESC
    LIMIT 50
$$;

REVOKE ALL ON FUNCTION app.tenant_by_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.membership_role(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.touch_membership(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.session_login(uuid, uuid, char(64), inet, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.session_rotate(char(64), char(64), inet, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.session_revoke(char(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.session_revoke_all(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.sessions_for(uuid, uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.tenant_by_id(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION app.membership_role(uuid, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION app.touch_membership(uuid, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION app.session_login(uuid, uuid, char(64), inet, text, integer) TO app_user;
GRANT EXECUTE ON FUNCTION app.session_rotate(char(64), char(64), inet, text, integer) TO app_user;
GRANT EXECUTE ON FUNCTION app.session_revoke(char(64)) TO app_user;
GRANT EXECUTE ON FUNCTION app.session_revoke_all(uuid, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION app.sessions_for(uuid, uuid, uuid) TO app_user;

-- Janitor: expired/terminal rows have no business staying in the table.
CREATE OR REPLACE FUNCTION app.prune_sessions(p_batch integer DEFAULT 5000)
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
        DELETE FROM refresh_tokens
        WHERE id IN (
            SELECT id FROM refresh_tokens
            WHERE expires_at < now() - interval '1 day'
               OR revoked_at < now() - interval '1 day'
            LIMIT p_batch
            FOR UPDATE SKIP LOCKED
        )
        RETURNING 1
    )
    SELECT count(*) INTO n FROM del;
    RETURN n;
END
$$;

REVOKE ALL ON FUNCTION app.prune_sessions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prune_sessions(integer) TO app_user;

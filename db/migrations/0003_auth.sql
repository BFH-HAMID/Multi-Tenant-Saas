-- 0003: sessions/refresh tokens, registration, invitations.
--
-- Refresh tokens are rotation-only and stored as SHA-256 digests: a stolen
-- dump must not yield usable credentials, and a hash lookup is index-only.
-- `family_id` gives us reuse detection — presenting an already-rotated token
-- means the chain leaked, so the whole family dies.

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    family_id       uuid        NOT NULL,
    token_digest    char(64)    NOT NULL,
    replaced_by     uuid REFERENCES refresh_tokens (id) ON DELETE SET NULL,
    created_by_ip   inet,
    user_agent      text,
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz,
    rotated_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT refresh_tokens_digest_uidx UNIQUE (token_digest),
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (tenant_id, family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expiry_idx ON refresh_tokens (expires_at)
    WHERE revoked_at IS NULL;

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS refresh_tokens_tenant_isolation ON refresh_tokens;
CREATE POLICY refresh_tokens_tenant_isolation ON refresh_tokens
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id());

-- A rotated row loses its tenant-scoped visibility (the holder no longer has a
-- valid access token), so session management happens through this definer
-- helper instead of a policy exception.
CREATE OR REPLACE FUNCTION app.revoke_family(p_tenant uuid, p_family uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
DECLARE
    n integer;
BEGIN
    UPDATE refresh_tokens
    SET revoked_at = now(),
        user_agent = coalesce(user_agent, '') || ' | revoked:' || p_reason
    WHERE tenant_id = p_tenant
      AND family_id = p_family
      AND revoked_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END
$$;

REVOKE ALL ON FUNCTION app.revoke_family(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.revoke_family(uuid, uuid, text) TO app_user;

-- ------------------------------------------------------------- signup -------
-- One statement = one tenant provisioned. Doing this from the API with three
-- sequential writes leaves an orphan tenant if the process dies in the middle
-- (and every orphan needs a janitor); inside a SECURITY DEFINER function the
-- transaction boundary is the guarantee.
--
-- The caller passes an *argon2 hash*, never a password: the cost model is an
-- application concern (and must stay tunable without a DB migration).
CREATE OR REPLACE FUNCTION app.register_tenant(
    p_tenant_id uuid,
    p_slug text,
    p_name text,
    p_plan text,
    p_user_id uuid,
    p_email text,
    p_password_hash text,
    p_display_name text,
    p_source text
)
-- NOTE on names: plpgsql substitutes any identifier that matches a parameter,
-- so OUT columns are prefixed with o_ to avoid shadowing real columns
-- (`column reference "tenant_id" is ambiguous`).
RETURNS TABLE (o_tenant_id uuid, o_user_id uuid, o_role member_role, o_plan text)
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
    IF EXISTS (SELECT 1 FROM users WHERE email_norm = lower(btrim(p_email))) THEN
        RAISE EXCEPTION 'email already registered' USING ERRCODE = '23505';
    END IF;

    INSERT INTO tenants (id, slug, name, plan, settings)
    VALUES (p_tenant_id, v_slug, p_name, p_plan, jsonb_build_object('signupSource', p_source))
    RETURNING tenants.id INTO o_tenant_id;

    INSERT INTO users (id, email, display_name, password_hash, email_verified_at)
    VALUES (p_user_id, p_email, nullif(btrim(coalesce(p_display_name, '')), ''), p_password_hash, now())
    RETURNING users.id INTO o_user_id;

    INSERT INTO tenant_members (tenant_id, user_id, role, status, joined_at)
    VALUES (o_tenant_id, o_user_id, 'owner', 'active', now())
    RETURNING tenant_members.role INTO o_role;

    INSERT INTO tenant_stats (tenant_id, member_count, project_count)
    VALUES (o_tenant_id, 1, 0)
    ON CONFLICT (tenant_id) DO UPDATE
    SET member_count = tenant_stats.member_count + 1, updated_at = now();

    o_plan := p_plan;
    RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION app.register_tenant(uuid, text, text, text, uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.register_tenant(uuid, text, text, text, uuid, text, text, text, text) TO app_user;

-- Accepting an invitation (invite tokens are stored hashed, same idea as
-- refresh tokens).
CREATE TABLE IF NOT EXISTS invitations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    email           text        NOT NULL,
    email_norm      text        GENERATED ALWAYS AS (lower(btrim(email))) STORED,
    role            member_role NOT NULL DEFAULT 'member',
    token_digest    char(64)    NOT NULL,
    invited_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    expires_at      timestamptz NOT NULL,
    accepted_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT invitations_digest_uidx UNIQUE (token_digest)
);

CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_ux
    ON invitations (tenant_id, email_norm)
    WHERE accepted_at IS NULL;

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invitations_tenant_isolation ON invitations;
CREATE POLICY invitations_tenant_isolation ON invitations
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Quota-aware membership insert (single seat check + insert, no TOCTOU race).
CREATE OR REPLACE FUNCTION app.accept_invitation(p_token_digest char(64))
RETURNS TABLE (o_tenant_id uuid, o_user_id uuid, o_role member_role)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
DECLARE
    v_user uuid := app.require_user_id();
    v_inv invitations%ROWTYPE;
    v_max integer;
BEGIN
    SELECT * INTO v_inv
    FROM invitations
    WHERE token_digest = p_token_digest
      AND accepted_at IS NULL
      AND expires_at > now()
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'invitation not found or expired' USING ERRCODE = 'P0002';
    END IF;

    IF v_inv.email_norm <> (SELECT email_norm FROM users WHERE id = v_user) THEN
        RAISE EXCEPTION 'invitation was issued for a different address' USING ERRCODE = '42501';
    END IF;

    SELECT max_members INTO v_max
    FROM plans p JOIN tenants t ON t.id = v_inv.tenant_id WHERE p.id = t.plan;

    IF (SELECT count(*) FROM tenant_members m WHERE m.tenant_id = v_inv.tenant_id) >= v_max THEN
        RAISE EXCEPTION 'tenant has reached its seat quota (%)', v_max USING ERRCODE = '23514';
    END IF;

    INSERT INTO tenant_members (tenant_id, user_id, role, status, joined_at, invited_by)
    VALUES (v_inv.tenant_id, v_user, v_inv.role, 'active', now(), v_inv.invited_by)
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active', role = EXCLUDED.role;

    UPDATE invitations SET accepted_at = now() WHERE id = v_inv.id;
    UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = v_user;

    RETURN QUERY SELECT v_inv.tenant_id, v_user, v_inv.role;
    -- o_tenant_id/o_user_id/o_role are the OUT columns
END
$$;

REVOKE ALL ON FUNCTION app.accept_invitation(char(64)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_invitation(char(64)) TO app_user;

-- Password changes must invalidate sessions; a trigger keeps that invariant
-- true even if someone later adds a direct UPDATE path.
CREATE OR REPLACE FUNCTION app.users_password_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
BEGIN
    IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
        UPDATE refresh_tokens rt
        SET revoked_at = now(), user_agent = coalesce(rt.user_agent, '') || ' | pwd-change'
        WHERE rt.user_id = NEW.id
          AND rt.revoked_at IS NULL;
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS users_password_changed ON users;
CREATE TRIGGER users_password_changed
    AFTER UPDATE OF password_hash ON users
    FOR EACH ROW EXECUTE FUNCTION app.users_password_changed();

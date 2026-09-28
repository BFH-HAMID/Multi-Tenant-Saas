-- 0010: plan changes as an explicit, checked operation.
--
-- `tenants.plan` is the only business column a tenant may not write itself: it
-- selects that tenant's own rate-limit geometry, quotas and cache TTLs. The RLS
-- UPDATE policy on `tenants` would otherwise let an owner `PATCH` themselves onto
-- enterprise. Keeping the write behind a definer function also gives us the one
-- place where "downgrade is impossible while over quota" is enforced atomically
-- with the row lock — a COUNT-then-UPDATE in the API would race with concurrent
-- project creation.
CREATE OR REPLACE FUNCTION app.update_tenant_plan(
    p_tenant uuid,
    p_plan text,
    p_changed_by uuid
)
RETURNS TABLE (o_ok boolean, o_reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
DECLARE
    v_max_projects integer;
    v_max_members integer;
    v_projects integer;
    v_members integer;
BEGIN
    SELECT p.max_projects, p.max_members
    INTO v_max_projects, v_max_members
    FROM plans p
    WHERE p.id = p_plan;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, format('unknown plan %s', p_plan);
        RETURN;
    END IF;

    -- Lock the tenant row first: this serialises plan changes against the quota
    -- triggers on projects/members for the same tenant.
    PERFORM 1 FROM tenants t WHERE t.id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'unknown tenant';
        RETURN;
    END IF;

    SELECT count(*) INTO v_projects FROM projects pr
    WHERE pr.tenant_id = p_tenant AND pr.status = 'active';
    SELECT count(*) INTO v_members FROM tenant_members m
    WHERE m.tenant_id = p_tenant AND m.status = 'active';

    IF v_max_projects IS NOT NULL AND v_projects > v_max_projects THEN
        RETURN QUERY SELECT false, format(
            'workspace has %s active projects; plan %s allows at most %s',
            v_projects, p_plan, v_max_projects);
        RETURN;
    END IF;
    IF v_max_members IS NOT NULL AND v_members > v_max_members THEN
        RETURN QUERY SELECT false, format(
            'workspace has %s members; plan %s allows at most %s',
            v_members, p_plan, v_max_members);
        RETURN;
    END IF;

    UPDATE tenants SET plan = p_plan WHERE id = p_tenant;

    INSERT INTO audit_log (tenant_id, actor_user_id, action, target_type, target_id, detail, request_id)
    VALUES (p_tenant, p_changed_by, 'tenant.plan_changed', 'tenant', p_tenant::text,
            jsonb_build_object('plan', p_plan), app.current_request_id());

    RETURN QUERY SELECT true, NULL::text;
END
$$;

REVOKE ALL ON FUNCTION app.update_tenant_plan(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.update_tenant_plan(uuid, text, uuid) TO app_user;

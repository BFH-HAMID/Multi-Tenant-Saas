-- 0005: reliability primitives — transactional outbox, idempotency keys, audit
-- log, plus the lease-based relay interface.
--
-- Why an outbox: "write the row, then enqueue the job" is a dual-write. If the
-- enqueue fails (or the pod dies in between) the user sees success and the email
-- never arrives; if the enqueue succeeds and the commit rolls back, the user
-- never asked for it. Only one of the two can be atomic with Postgres, so we
-- make the DB write atomic and *reliably* relay to BullMQ afterwards. The queue
-- side is then at-least-once, which idempotency keys make harmless.
-- docs/adr/0005-outbox-and-idempotency.md

CREATE TABLE IF NOT EXISTS outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- topic is the job name (`report.generate`), queue derived from it.
    topic           text        NOT NULL,
    payload         jsonb       NOT NULL,
    headers         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Dedupe key echoed into the queue so the consumer can be idempotent.
    idempotency_key text        NOT NULL,
    status          outbox_status NOT NULL DEFAULT 'pending',
    attempts        integer     NOT NULL DEFAULT 0,
    max_attempts    integer     NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    lease_until     timestamptz,
    last_error      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz,
    CONSTRAINT outbox_idem_ux UNIQUE (tenant_id, idempotency_key)
);

-- The relay's hot query: pending rows whose backoff has elapsed. Partial index
-- keeps it small as history accumulates, which is the difference between a
-- 0.5ms claim and a seq scan at 10M rows.
CREATE INDEX IF NOT EXISTS outbox_claim_idx
    ON outbox (next_attempt_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS outbox_tenant_recent_idx
    ON outbox (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS outbox_expired_leases_idx
    ON outbox (lease_until)
    WHERE status = 'pending' AND lease_until IS NOT NULL;

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbox_tenant_isolation ON outbox;
CREATE POLICY outbox_tenant_isolation ON outbox
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

CREATE OR REPLACE FUNCTION app.outbox_enqueue(
    p_tenant uuid,
    p_topic text,
    p_payload jsonb,
    p_idempotency_key text
)
RETURNS bigint
LANGUAGE sql
AS
$$
    INSERT INTO outbox (tenant_id, topic, payload, idempotency_key, headers)
    VALUES (p_tenant, p_topic, p_payload, p_idempotency_key,
            jsonb_build_object('requestId', app.current_request_id()))
    -- A retried HTTP request must not queue a second job: the key is the
    -- tenant+Idempotency-Key pair, so the original row is kept as-is.
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    RETURNING id
$$;

REVOKE ALL ON FUNCTION app.outbox_enqueue(uuid, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_enqueue(uuid, text, jsonb, text) TO app_user;

-- The relay's only privileged operation. SECURITY DEFINER + a short lease:
-- * the worker is not given cross-tenant SELECT on outbox,
-- * two relays can run at once without double-publishing (SKIP LOCKED),
-- * a relay that dies mid-batch loses the lease and the rows come back.
CREATE OR REPLACE FUNCTION app.outbox_claim(p_batch_size integer, p_lease_seconds integer)
-- OUT columns are o_-prefixed: plpgsql would otherwise treat a bare
-- `tenant_id`/`attempts` inside the body as the variable, not the column.
RETURNS TABLE (
    o_id bigint,
    o_tenant_id uuid,
    o_topic text,
    o_payload jsonb,
    o_headers jsonb,
    o_idempotency_key text,
    o_attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
BEGIN
    IF p_batch_size < 1 OR p_batch_size > 1000 THEN
        RAISE EXCEPTION 'batch size must be in 1..1000';
    END IF;

    RETURN QUERY
    WITH picked AS (
        SELECT o.id
        FROM outbox o
        WHERE o.status = 'pending'
          AND o.next_attempt_at <= now()
          AND (o.lease_until IS NULL OR o.lease_until < now())
        ORDER BY o.next_attempt_at, o.id
        -- NOWAIT rather than WAIT: a stalled relay must not become a queue of
        -- blocked relays behind it. Losing the race is the expected outcome.
        FOR UPDATE OF o SKIP LOCKED
        LIMIT p_batch_size
    )
    UPDATE outbox o
    SET attempts = o.attempts + 1,
        lease_until = now() + make_interval(secs => p_lease_seconds)
    FROM picked
    WHERE o.id = picked.id
    RETURNING o.id, o.tenant_id, o.topic, o.payload, o.headers, o.idempotency_key, o.attempts;
END
$$;

REVOKE ALL ON FUNCTION app.outbox_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_claim(integer, integer) TO app_user;

CREATE OR REPLACE FUNCTION app.outbox_mark_published(p_ids bigint[])
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS
$$
    WITH u AS (
        UPDATE outbox
        SET status = 'published', published_at = now(), lease_until = NULL, last_error = NULL
        WHERE id = ANY (p_ids)
        RETURNING 1
    )
    SELECT count(*) FROM u
$$;

CREATE OR REPLACE FUNCTION app.outbox_mark_failed(
    p_id bigint,
    p_error text,
    p_retry_in_seconds integer
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS
$$
    UPDATE outbox
    SET last_error = left(p_error, 500),
        -- Exponential backoff (2^attempts, capped at 15 min) is the same shape
        -- BullMQ uses, so a poisoned row cannot hot-loop the relay.
        next_attempt_at = now() + make_interval(secs => p_retry_in_seconds),
        lease_until = NULL,
        status = CASE
            WHEN attempts >= max_attempts THEN 'discarded'::outbox_status
            ELSE 'pending'::outbox_status
        END
    WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION app.outbox_mark_published(bigint[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.outbox_mark_failed(bigint, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_mark_published(bigint[]) TO app_user;
GRANT EXECUTE ON FUNCTION app.outbox_mark_failed(bigint, text, integer) TO app_user;

-- Relay observability without a cross-tenant SELECT: called by the worker's
-- metrics collector and by the queue-depth alert rule.
CREATE OR REPLACE VIEW app.outbox_depth AS
SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
       count(*) FILTER (WHERE status = 'failed')  AS failed,
       count(*) FILTER (WHERE status = 'discarded') AS discarded,
       coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'pending')), 0)
           AS oldest_pending_seconds
FROM outbox;
GRANT SELECT ON app.outbox_depth TO app_user;

-- ------------------------------------------------------- idempotency --------
-- Durable half of the Idempotency-Key story (the Redis entry is the fast half).
-- Storing the response lets us replay the *same* answer on a retry instead of a
-- second 201, which is what payment-shaped clients actually need.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    key             text        NOT NULL,
    -- Request fingerprint: method + path + body hash. A different body under the
    -- same key is a client bug we must surface, not silently replay.
    request_hash    text        NOT NULL,
    response_status integer,
    response_body   jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    completed_at    timestamptz,
    PRIMARY KEY (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_keys (expires_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS idempotency_tenant_isolation ON idempotency_keys;
CREATE POLICY idempotency_tenant_isolation ON idempotency_keys
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- ---------------------------------------------------------------- audit -----
-- Append-only, RLS-isolated, no UPDATE/DELETE granted. Retention is the
-- tenant's `retention_days` (see db/seed.ts + the prune job).
CREATE TABLE IF NOT EXISTS audit_log (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    actor_user_id   uuid,
    action          text        NOT NULL,
    target_type     text,
    target_id       text,
    detail          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    request_id      text,
    ip              inet,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_tenant_time_idx ON audit_log (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_tenant_action_idx ON audit_log (tenant_id, action, created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_tenant_isolation ON audit_log;
CREATE POLICY audit_tenant_isolation ON audit_log
    FOR SELECT
    USING (tenant_id = app.current_tenant_id() AND app.is_at_least('admin'));

-- Inserts bypass RLS WITH CHECK via a definer helper so a suspended/odd request
-- context can never write *another* tenant's audit line.
CREATE OR REPLACE FUNCTION app.audit(
    p_action text,
    p_target_type text DEFAULT NULL,
    p_target_id text DEFAULT NULL,
    p_detail jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
DECLARE
    tid uuid := app.current_tenant_id();
BEGIN
    IF tid IS NULL THEN
        RETURN; -- unauthenticated platform events go to logs, not to a tenant table
    END IF;
    INSERT INTO audit_log (tenant_id, actor_user_id, action, target_type, target_id, detail, request_id)
    VALUES (tid, app.current_user_id(), p_action, p_target_type, p_target_id, p_detail, app.current_request_id());
EXCEPTION
    WHEN OTHERS THEN
        -- Auditing must never be the reason a request fails.
        RAISE NOTICE 'audit() failed: %', sqlerrm;
END
$$;

REVOKE ALL ON FUNCTION app.audit(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audit(text, text, text, jsonb) TO app_user;

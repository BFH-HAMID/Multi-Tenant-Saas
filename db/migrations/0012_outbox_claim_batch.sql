-- 0012: a claim function that returns what a consumer actually needs.
--
-- 0005's `app.outbox_claim` returns the leased rows only. A worker also wants
-- `max_attempts` (to decide "retry later" vs "dead-letter now"), but `outbox` is
-- RLS-protected with FORCE, and the consumer has no membership in any tenant — so
-- `JOIN outbox` from the relay returns zero rows and the relay silently does
-- nothing. That is the worst kind of failure: a queue that never drains and no
-- error anywhere.
--
-- This is a *new* function rather than a `CREATE OR REPLACE` of the old one
-- because Postgres cannot change a function's return list in place, and editing
-- 0005 would rewrite already-applied migration history. The old signature stays
-- (it is still correct for callers that do not need the extra column); the
-- comment below is what keeps them from diverging.
CREATE OR REPLACE FUNCTION app.outbox_claim_batch(
    p_batch_size integer,
    p_lease_seconds integer
)
RETURNS TABLE (
    o_id bigint,
    o_tenant_id uuid,
    o_topic text,
    o_payload jsonb,
    o_headers jsonb,
    o_idempotency_key text,
    o_attempts integer,
    o_max_attempts integer
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
        -- NOWAIT-free on purpose: SKIP LOCKED already means "take what is not
        -- being held", so a slow consumer slows nobody else down.
        FOR UPDATE OF o SKIP LOCKED
        LIMIT p_batch_size
    )
    UPDATE outbox o
    SET attempts = o.attempts + 1,
        lease_until = now() + make_interval(secs => p_lease_seconds)
    FROM picked
    WHERE o.id = picked.id
    RETURNING o.id, o.tenant_id, o.topic, o.payload, o.headers, o.idempotency_key, o.attempts, o.max_attempts;
END
$$;

COMMENT ON FUNCTION app.outbox_claim_batch(integer, integer) IS
    'Lease a batch of pending outbox rows for consumption. SECURITY DEFINER because the consumer role has no tenant membership, and RLS would otherwise hide every row.';

REVOKE ALL ON FUNCTION app.outbox_claim_batch(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_claim_batch(integer, integer) TO app_user;

-- Invariant sweep: definer-owned-by-app_admin, pinned search_path, explicit
-- EXECUTE (see 0011 for why this exists and why it is a function).
SELECT app.enforce_definer_invariants();

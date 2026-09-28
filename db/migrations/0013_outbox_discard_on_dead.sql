-- 0013: a terminal failure must leave `pending` immediately.
--
-- `dispatch()` already distinguishes "retry this" from "this will never work"
-- (`dead`: poison payload, idempotency-key collision, retries exhausted). Until
-- now the relay settled BOTH with `app.outbox_mark_failed`, whose contract is
-- "come back later" — 2^attempts backoff, up to `max_attempts` (8). So a payload
-- that can never parse was retried eight times, and while it sat there it kept
-- `status='pending'`, which means:
--
--   * `app.outbox_depth.pending` counted a row that is not waiting for anything;
--   * `outbox_oldest_lag_seconds` grew without bound, so the alert rule
--     `queue_oldest_pending_job_seconds > 60` pages for one bad message and keeps
--     paging for an hour, while a genuinely stuck queue is lost in the noise;
--   * the row is invisible to `discarded`, which is where an operator looks.
--
-- Discarding is the database's answer to "the consumer gave up", and it is
-- idempotent: a relay that re-claims a row between the handler's death and the
-- settle call must not resurrect a discarded job, hence the status guard.
CREATE OR REPLACE FUNCTION app.outbox_mark_discarded(
    p_id bigint,
    p_error text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS
$$
    WITH marked AS (
        UPDATE outbox
           SET status        = 'discarded'::outbox_status,
               last_error    = left(p_error, 500),
               lease_until   = NULL,
               published_at  = now()
         WHERE id = p_id
           -- Only a live claim may be retired. `published_at` doubles as the
           -- "settled at" column for both outcomes, since a discarded row is
           -- terminal in exactly the same sense a published one is.
           AND status IN ('pending', 'failed')
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM marked);
$$;

COMMENT ON FUNCTION app.outbox_mark_discarded(bigint, text) IS
    'Retire an outbox row as permanently failed. Returns false if the row was '
    'already settled (published/discarded), which is the signal a caller uses to '
    'avoid double-counting a replayed claim.';

REVOKE ALL ON FUNCTION app.outbox_mark_discarded(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_mark_discarded(bigint, text) TO app_user;

-- Same invariant sweep as every other definer function in `app` (0011): ownership
-- and search_path are enforced by re-running the sweep, not by trusting the author
-- of the next migration to remember.
SELECT app.enforce_definer_invariants();

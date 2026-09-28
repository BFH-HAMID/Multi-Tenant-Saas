-- 0007: durable async job state for report generation.
--
-- Deliberate design choice: the *result* of an async job lives in Postgres, not
-- in Redis/BullMQ. Reasons:
--   * BullMQ prunes completed jobs (removeOnComplete) and its retention is an
--     ops knob, not a product guarantee — clients polling
--     GET /reports/{jobId} must not lose their result because a janitor ran;
--   * putting it in Postgres gives the row the same RLS treatment as everything
--     else, so the tenant-scoped status endpoint is a plain SELECT;
--   * the worker can then be restarted, rescaled or replaced with a different
--     transport (SQS, GCP Tasks) without changing the API contract: only the
--     delivery of "there is work" changes.
-- See docs/adr/0002-bullmq.md.

CREATE TABLE IF NOT EXISTS report_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    requested_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    project_scope   uuid,
    format          text        NOT NULL CHECK (format IN ('csv', 'json')),
    status          text        NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    progress        smallint    NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    options         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    result          jsonb,
    error           text,
    attempts        integer     NOT NULL DEFAULT 0,
    max_attempts    integer     NOT NULL DEFAULT 3,
    -- BullMQ job id, kept for correlation with queue metrics/logs.
    queue_job_id    text,
    idempotency_key text,
    started_at      timestamptz,
    finished_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS report_jobs_idem_ux
    ON report_jobs (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
-- Status polling + worker pickup.
CREATE INDEX IF NOT EXISTS report_jobs_tenant_created_idx
    ON report_jobs (tenant_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS report_jobs_stuck_idx
    ON report_jobs (status, started_at)
    WHERE status IN ('queued', 'running');

ALTER TABLE report_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS report_jobs_tenant_isolation ON report_jobs;
CREATE POLICY report_jobs_tenant_isolation ON report_jobs
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

CREATE TRIGGER report_jobs_touch
    BEFORE UPDATE ON report_jobs
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Worker-side state machine, single point of truth for legal transitions.
CREATE OR REPLACE FUNCTION app.report_job_finish(
    p_id uuid,
    p_status text,
    p_result jsonb DEFAULT NULL,
    p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
BEGIN
    IF p_status NOT IN ('completed', 'failed') THEN
        RAISE EXCEPTION 'finish status must be completed|failed, got %', p_status;
    END IF;

    UPDATE report_jobs
    SET status = p_status,
        result = p_result,
        error  = p_error,
        progress = CASE WHEN p_status = 'completed' THEN 100 ELSE progress END,
        finished_at = now()
    WHERE id = p_id
      -- Transition guard: never resurrect a terminal job (a retried BullMQ job
      -- that arrives after a timeout must be a no-op, not a double write).
      AND status IN ('queued', 'running');
END
$$;

CREATE OR REPLACE FUNCTION app.report_job_fail_or_retry(
    p_id uuid,
    p_error text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS
$$
DECLARE
    r report_jobs%ROWTYPE;
BEGIN
    SELECT * INTO r FROM report_jobs WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'missing';
    END IF;

    IF r.attempts + 1 >= r.max_attempts THEN
        UPDATE report_jobs
        SET status = 'failed', error = left(p_error, 900), attempts = r.attempts + 1, finished_at = now()
        WHERE id = p_id AND status IN ('queued', 'running');
        RETURN 'failed';
    END IF;

    UPDATE report_jobs
    SET attempts = r.attempts + 1,
        status = 'queued',
        error = left(p_error, 900),
        started_at = NULL
    WHERE id = p_id;
    RETURN 'retrying';
END
$$;

REVOKE ALL ON FUNCTION app.report_job_finish(uuid, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.report_job_fail_or_retry(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.report_job_finish(uuid, text, jsonb, text) TO app_user;
GRANT EXECUTE ON FUNCTION app.report_job_fail_or_retry(uuid, text) TO app_user;
GRANT SELECT, INSERT, UPDATE ON report_jobs TO app_user;
GRANT SELECT, UPDATE ON report_jobs TO app_admin;

COMMENT ON TABLE report_jobs IS 'Durable job state for async reports; the queue is only the transport.';

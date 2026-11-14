CREATE TABLE IF NOT EXISTS "scheme_meta" (
    "job_id" UUID PRIMARY KEY,
    "status" VARCHAR(20) NOT NULL,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "scheme_meta_status_idx" ON "scheme_meta"("status");
CREATE INDEX IF NOT EXISTS "scheme_meta_updated_at_idx" ON "scheme_meta"("updated_at" DESC);
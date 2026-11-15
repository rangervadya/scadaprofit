-- Shared rate-limit counters (P1-11).
--
-- express-rate-limit keeps counters in process memory by default, so a second
-- instance would reset the quota. This table lets every instance share one
-- counter per (bucket, key) with a fixed window.
CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
    "bucket" VARCHAR(64) NOT NULL,
    "ident" VARCHAR(255) NOT NULL,
    "window_start" TIMESTAMPTZ NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("bucket", "ident")
);

CREATE INDEX IF NOT EXISTS "rate_limit_buckets_window_start_idx" ON "rate_limit_buckets"("window_start");
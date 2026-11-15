-- Idle timeout support (P1-2): track the last request timestamp per session
-- so inactive sessions can be expired independently of the absolute TTL.
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: existing sessions have no activity record yet; treat creation as
-- the last activity so they are not expired prematurely.
UPDATE "sessions" SET "last_seen_at" = "created_at" WHERE "last_seen_at" IS NULL;

CREATE INDEX IF NOT EXISTS "sessions_last_seen_at_idx" ON "sessions"("last_seen_at");
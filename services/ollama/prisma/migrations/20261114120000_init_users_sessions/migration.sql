-- Expand phase for P1-1: mirror users/sessions into PostgreSQL.
-- JSON remains the source of truth until the cutover; this migration only
-- creates the target tables and indexes.

CREATE TABLE IF NOT EXISTS "users" (
    "id" UUID PRIMARY KEY,
    "username" VARCHAR(80) NOT NULL UNIQUE,
    "display_name" VARCHAR(120) NOT NULL,
    "first_name" VARCHAR(80),
    "last_name" VARCHAR(80),
    "role" VARCHAR(20) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "sessions" (
    "id" VARCHAR(128) PRIMARY KEY,
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "token_hash" VARCHAR(128) NOT NULL UNIQUE,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions"("user_id");
CREATE INDEX IF NOT EXISTS "sessions_expires_at_idx" ON "sessions"("expires_at");
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
    "id" UUID PRIMARY KEY,
    "key" VARCHAR(200) NOT NULL,
    "endpoint" VARCHAR(120) NOT NULL,
    "user_id" UUID,
    "status" VARCHAR(20) NOT NULL,
    "response" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "idempotency_keys_key_endpoint_key" UNIQUE ("key", "endpoint")
);

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");
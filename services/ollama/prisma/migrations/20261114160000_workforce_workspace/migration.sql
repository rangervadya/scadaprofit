CREATE TABLE IF NOT EXISTS "workforce_workspace" (
    "id" INTEGER PRIMARY KEY,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workforce_workspace_singleton" CHECK ("id" = 1)
);
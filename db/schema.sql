-- Skema Neon Postgres untuk Adu Penalti Pro
CREATE TABLE IF NOT EXISTS penalty_rooms (
    code        TEXT PRIMARY KEY,
    data        JSONB NOT NULL,
    version     BIGINT NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_penalty_rooms_updated_at ON penalty_rooms (updated_at);

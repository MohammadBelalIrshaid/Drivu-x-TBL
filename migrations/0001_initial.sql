PRAGMA foreign_keys = ON;

CREATE TABLE campaign_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO campaign_state (singleton, generation, updated_at)
VALUES (1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE spins (
    id TEXT PRIMARY KEY NOT NULL,
    created_at TEXT NOT NULL,
    participant TEXT CHECK (participant IS NULL OR length(participant) <= 120),
    winner_index INTEGER NOT NULL CHECK (winner_index >= 0 AND winner_index < choice_count),
    result_id TEXT NOT NULL CHECK (length(result_id) BETWEEN 1 AND 128),
    result_label TEXT NOT NULL CHECK (length(result_label) BETWEEN 1 AND 60),
    choice_count INTEGER NOT NULL CHECK (choice_count BETWEEN 2 AND 16),
    choices_json TEXT NOT NULL CHECK (json_valid(choices_json)),
    attempt_token_hash TEXT CHECK (
        attempt_token_hash IS NULL OR length(attempt_token_hash) = 64
    ),
    campaign_generation INTEGER NOT NULL CHECK (campaign_generation >= 1)
);

CREATE INDEX idx_spins_created_at ON spins(created_at DESC);
CREATE INDEX idx_spins_generation_created
    ON spins(campaign_generation, created_at DESC, id DESC);
CREATE UNIQUE INDEX uq_spins_attempt_generation
    ON spins(attempt_token_hash, campaign_generation)
    WHERE attempt_token_hash IS NOT NULL;

CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
);

CREATE INDEX idx_admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE rate_limits (
    scope TEXT NOT NULL,
    key_hash TEXT NOT NULL CHECK (length(key_hash) = 64),
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts >= 1),
    PRIMARY KEY (scope, key_hash)
);

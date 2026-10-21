-- Invite codes / online sessions
-- Source of truth for the schema; after changing it, run it against both --remote and --local:
-- npx wrangler d1 execute legal-assistant-users --remote --file=db/schema.sql
-- npx wrangler d1 execute legal-assistant-users --local  --file=db/schema.sql

CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',   -- active | revoked
  max_uses INTEGER,                        -- NULL = unlimited
  used_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  code TEXT PRIMARY KEY,      -- one session row per code = only one user online at a time
  device_id TEXT NOT NULL,
  session_token TEXT NOT NULL,
  last_seen INTEGER NOT NULL
);

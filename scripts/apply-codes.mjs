#!/usr/bin/env node
// Sync invite-codes.txt into the invite_codes table in D1.
// Usage:
//   node scripts/apply-codes.mjs           # sync to the remote database (--remote)
//   node scripts/apply-codes.mjs --local   # sync to the local database used by wrangler dev
//
// File format (one per line): code[,max_uses][,status]
//   CODE-XXXXXX-YYYYYY            -> unlimited, active
//   CODE-XXXXXX-YYYYYY,100        -> limited to 100 uses, active
//   CODE-XXXXXX-YYYYYY,,revoked   -> revoked
//
// Only max_uses / status are updated; used_count is left alone, so changing a limit
// or revoking a code never resets its usage.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const CODES_FILE = new URL('../invite-codes.txt', import.meta.url);
const DB_NAME = 'legal-assistant-users';
const mode = process.argv.includes('--local') ? '--local' : '--remote';

function sqlQuote(s) {
  return `'${s.replace(/'/g, "''")}'`;
}

function parseLine(line, lineNo) {
  const raw = line.trim();
  if (!raw || raw.startsWith('#')) return null;

  const parts = raw.split(',').map((p) => p.trim());
  const code = parts[0];
  if (!code) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(code)) {
    throw new Error(`Line ${lineNo}: invite code contains invalid characters: "${code}"`);
  }

  let maxUses = null;
  if (parts[1]) {
    maxUses = Number(parts[1]);
    if (!Number.isInteger(maxUses) || maxUses < 0) {
      throw new Error(`Line ${lineNo}: max_uses must be a non-negative integer: "${parts[1]}"`);
    }
  }

  let status = 'active';
  if (parts[2]) {
    status = parts[2];
    if (status !== 'active' && status !== 'revoked') {
      throw new Error(`Line ${lineNo}: status must be active or revoked: "${status}"`);
    }
  }

  return { code, maxUses, status };
}

const lines = readFileSync(CODES_FILE, 'utf8').split('\n');
const entries = [];
lines.forEach((line, i) => {
  const parsed = parseLine(line, i + 1);
  if (parsed) entries.push(parsed);
});

if (entries.length === 0) {
  console.log('No invite codes to sync in invite-codes.txt, exiting.');
  process.exit(0);
}

const statements = entries.map(({ code, maxUses, status }) => {
  const maxUsesSql = maxUses === null ? 'NULL' : String(maxUses);
  return `INSERT INTO invite_codes (code, max_uses, status, created_at, updated_at)
VALUES (${sqlQuote(code)}, ${maxUsesSql}, ${sqlQuote(status)}, unixepoch(), unixepoch())
ON CONFLICT(code) DO UPDATE SET
  max_uses = excluded.max_uses,
  status = excluded.status,
  updated_at = excluded.updated_at;`;
});

const tmpDir = mkdtempSync(join(tmpdir(), 'legal-assistant-codes-'));
const tmpFile = join(tmpDir, 'apply-codes.sql');
writeFileSync(tmpFile, statements.join('\n\n'), 'utf8');

console.log(`Syncing ${entries.length} invite codes to D1 (${DB_NAME}, ${mode})...`);
execFileSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, mode, '--file', tmpFile], {
  stdio: 'inherit',
});
console.log('Done.');

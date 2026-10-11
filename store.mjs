import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createStoreCore } from './store-core.mjs';

// Retain the existing Node import surface for server, AI and billing consumers.
export { problem, hashToken } from './store-core.mjs';

/** Node wrapper owns the file, connection settings and periodic cleanup. */
export function createStore(dataDir, options = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'mosaic.sqlite');
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      PRAGMA synchronous=NORMAL;
    `);
    return createStoreCore(db, {
      ...options,
      periodicCleanup: true,
      transaction(fn) {
        db.exec('BEGIN IMMEDIATE');
        try { const value = fn(); db.exec('COMMIT'); return value; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    });
  } catch (error) {
    db.close();
    throw error;
  }
}

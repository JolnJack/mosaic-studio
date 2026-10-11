import { createStoreCore } from './store-core.mjs';

export { problem, hashToken } from './store-core.mjs';

/** Construct inside a SQLite Durable Object; storage remains owned by the DO. */
export function createWorkerStore(storage, { env = {}, userIdFactory } = {}) {
  const sql = storage.sql;
  const all = (query, bindings) => sql.exec(query, ...bindings).toArray();
  const db = {
    exec(query) { all(query, []); },
    prepare(query) {
      return {
        get(...bindings) { return all(query, bindings)[0]; },
        all(...bindings) { return all(query, bindings); },
        run(...bindings) {
          // Drain even DML cursors before issuing changes(). rowsWritten includes
          // index/trigger work and cannot represent direct affected-row counts.
          all(query, bindings);
          const [result] = all('SELECT changes() AS changes', []);
          return { changes: result.changes };
        },
      };
    },
    close() {}, // No connection-close API: the Durable Object owns its storage.
  };
  return createStoreCore(db, {
    env,
    userIdFactory,
    transaction: fn => storage.transactionSync(fn),
    periodicCleanup: false,
  });
}

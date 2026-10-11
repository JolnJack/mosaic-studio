import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore, problem } from './store.mjs';
import { createApplication } from './application.mjs';
import { importUrl } from './import.mjs';
export { canonicalSource, hashPassword, verifyPassword } from './application.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
/** Node entry point; the same API logic also runs with durable SQLite in Workers. */
export function createApp({ dataDir = resolve(ROOT, 'data'), env = process.env, aiProvider, importer = importUrl } = {}) {
  const store = createStore(resolve(dataDir), { env });
  let server;
  const app = createApplication({ store, env, aiProvider, importer, getServerAddress: () => server?.address(),
    async assetLoader(name) {
      const filename = resolve(ROOT, name);
      try {
        if (await realpath(filename) !== filename || (await stat(filename)).size > 2 * 1024 * 1024) throw problem(404, 'NOT_FOUND', 'Not found');
        return await readFile(filename);
      } catch (error) {
        if (error.code === 'ENOENT') throw problem(404, 'NOT_FOUND', 'Not found');
        throw error;
      }
    },
  });
  server = http.createServer({ maxHeaderSize: 16 * 1024 }, app.handle);
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000; server.maxRequestsPerSocket = 100; server.maxConnections = 128;
  let closing;
  function close() {
    return closing ??= (async () => {
      const applicationClosed = app.close();
      if (server.listening) {
        const done = new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
        server.closeAllConnections(); await done;
      }
      await applicationClosed;
    })();
  }
  return { server, db: store.db, store, close };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const app = createApp({ dataDir: process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(ROOT, 'data') });
  const port = Number(process.env.PORT ?? 3000), host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) { await app.close(); throw new TypeError('PORT must be between 1 and 65535'); }
  app.server.listen(port, host, () => console.log(`Mosaic Studio listening on http://${host}:${port}`));
  app.server.on('error', async error => { console.error(`Server startup failed: ${error.code ?? 'SERVER_ERROR'}`); await app.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
}

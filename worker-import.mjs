import { connect } from 'cloudflare:sockets';
import { socketPage } from './socket-import.mjs';
import { importPublicUrl, dohLookup } from './import-source.mjs';
export function importWorkerUrl(value, { signal, onTransportError } = {}) {
  return importPublicUrl(value, { resolver: dohLookup, transport: (url, address, options) => socketPage(url, address, { ...options, connect, onTransportError }), signal });
}

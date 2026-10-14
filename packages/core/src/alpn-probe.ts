import { isIP } from 'node:net';
import { connect } from 'node:tls';
import type { LookupFunction } from 'node:net';

/**
 * Open one TLS connection offering `h2` and `http/1.1` via ALPN and return
 * the protocol the server selected. undici's fetch does not expose the
 * negotiated protocol on a Response, so a direct handshake is the only
 * reliable HTTP/2 signal.
 *
 * Returns `'h2'` or `'http/1.1'`; a server that ignores ALPN negotiates
 * HTTP/1.1. Returns `null` when the handshake fails or times out.
 * Certificate errors are ignored: the cert audit is the TLS probe's job.
 */
export async function probeAlpn(
  host: string,
  port = 443,
  timeoutMs = 10_000,
  lookup?: LookupFunction,
): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const socket = connect({
      host,
      port,
      // SNI must be a hostname; Node rejects an IP literal here.
      ...(isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: false,
      ALPNProtocols: ['h2', 'http/1.1'],
      ...(lookup ? { lookup } : {}),
    });
    const finish = (result: string | null): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once('secureConnect', () => finish(socket.alpnProtocol === 'h2' ? 'h2' : 'http/1.1'));
    socket.once('error', () => finish(null));
  });
}

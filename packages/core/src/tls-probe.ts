import { connect, type PeerCertificate, type TLSSocket } from 'node:tls';

/**
 * Result of probing the TLS certificate served by `host:port`. All string
 * fields are populated on success; the date fields are RFC 1123 strings
 * (the format Node returns from `peerCert.valid_from` /
 * `peerCert.valid_to`). On failure, `error` is set and the rest are null.
 */
export interface TlsCertInfo {
  validFrom: string | null;
  validTo: string | null;
  daysUntilExpiry: number | null;
  issuer: string | null;
  subject: string | null;
  signatureAlgorithm: string | null;
  /** Negotiated TLS protocol version, e.g. `TLSv1.3`. */
  protocol: string | null;
  /**
   * Version negotiated by a second handshake capped at TLS 1.1 (`TLSv1`
   * or `TLSv1.1`). Null when the server refuses TLS 1.0 / 1.1.
   * `untested` when the handshake could not be tried: the main connection
   * failed before TLS, or the TLS library rejects the legacy options.
   */
  legacyProtocol: string | null;
  /**
   * Number of certificates the server presented in its chain (leaf
   * inclusive). 1 means leaf-only / self-signed; 2 means leaf + root
   * with no intermediate; ≥3 indicates one or more intermediate CAs.
   * Null on probe failure.
   */
  chainLength: number | null;
  /**
   * Distinguished names of the certs in the chain, leaf-first. Capped
   * at 5 entries to keep the column tiny — corporate PKIs occasionally
   * present long chains and we don't need the full path for the audit.
   * Null on probe failure.
   */
  chainSubjects: string[] | null;
  /** Empty on success. Free-form error string when the connect/handshake fails. */
  error: string | null;
}

/**
 * Open a single TLS connection to the host and read the peer cert. We
 * disable certificate verification (`rejectUnauthorized: false`) because
 * the goal is to *audit* the cert — including expired or self-signed ones
 * — not to communicate securely. The returned data lets the caller
 * surface "certificate expired" / "expires in 12 days" issues which are
 * exactly the cases a verifying connect would refuse to surface at all.
 *
 * Times out at `timeoutMs`; on timeout the error string includes the
 * elapsed budget so it's clear in logs.
 */
export async function probeTlsCert(
  host: string,
  port = 443,
  timeoutMs = 10_000,
): Promise<TlsCertInfo> {
  // Set when TCP connected and the handshake did not time out, i.e. the
  // server answered. Gates the legacy probe so dead hosts cost one try.
  let serverAnswered = false;
  const info = await new Promise<TlsCertInfo>((resolve) => {
    const empty: TlsCertInfo = {
      validFrom: null,
      validTo: null,
      daysUntilExpiry: null,
      issuer: null,
      subject: null,
      signatureAlgorithm: null,
      protocol: null,
      legacyProtocol: null,
      chainLength: null,
      chainSubjects: null,
      error: null,
    };

    let settled = false;
    const finish = (result: TlsCertInfo): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      serverAnswered = false;
      finish({ ...empty, error: `tls handshake timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    const socket = connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: false,
        // Don't keep the process alive waiting on a connect we already
        // gave up on — `unref` makes the socket non-blocking for shutdown.
        ALPNProtocols: ['h2', 'http/1.1'],
      },
      () => {
        clearTimeout(timer);
        try {
          // `getPeerCertificate(true)` returns the leaf cert with its
          // `issuerCertificate` chain attached so we can surface chain
          // length + intermediate CA subjects alongside the leaf
          // expiry/issuer/signature data.
          const peer = socket.getPeerCertificate(true) as PeerCertificate;
          if (!peer || Object.keys(peer).length === 0) {
            finish({ ...empty, error: 'peer certificate unavailable' });
            return;
          }
          // Walk the chain via `issuerCertificate` until we hit a
          // self-signed cert (issuerCertificate === self) or run out.
          // Capped at 5 hops to defend against weird PKIs that loop.
          const chainSubjects: string[] = [];
          let chainLength = 0;
          {
            let cursor: PeerCertificate | undefined = peer;
            const seen = new Set<PeerCertificate>();
            while (cursor && !seen.has(cursor) && chainLength < 5) {
              seen.add(cursor);
              chainLength++;
              const sub = formatDistinguishedName(
                (cursor as { subject?: Record<string, string> }).subject ?? null,
              );
              if (sub) chainSubjects.push(sub);
              const next: PeerCertificate | undefined = (
                cursor as { issuerCertificate?: PeerCertificate }
              ).issuerCertificate;
              if (!next || next === cursor) break;
              cursor = next;
            }
          }
          const validTo = (peer as { valid_to?: string }).valid_to ?? null;
          const validFrom = (peer as { valid_from?: string }).valid_from ?? null;
          let daysUntilExpiry: number | null = null;
          if (validTo) {
            const t = Date.parse(validTo);
            if (!Number.isNaN(t)) {
              daysUntilExpiry = Math.floor((t - Date.now()) / (24 * 60 * 60 * 1000));
            }
          }
          const protocol = socket.getProtocol() ?? null;
          finish({
            validFrom,
            validTo,
            daysUntilExpiry,
            issuer: formatDistinguishedName(
              (peer as { issuer?: Record<string, string> }).issuer ?? null,
            ),
            subject: formatDistinguishedName(
              (peer as { subject?: Record<string, string> }).subject ?? null,
            ),
            // `peer.sigalg` was added in Node 16 but typings lag behind;
            // fall back to `signatureAlgorithm` style if not present.
            signatureAlgorithm:
              (peer as { sigalg?: string; signatureAlgorithm?: string }).sigalg ??
              (peer as { signatureAlgorithm?: string }).signatureAlgorithm ??
              null,
            protocol,
            legacyProtocol: null,
            chainLength,
            chainSubjects: chainSubjects.length > 0 ? chainSubjects : null,
            error: null,
          });
        } catch (err) {
          finish({
            ...empty,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    socket.on('error', (err) => {
      clearTimeout(timer);
      finish({ ...empty, error: err instanceof Error ? err.message : String(err) });
    });
    socket.on('timeout', () => {
      clearTimeout(timer);
      serverAnswered = false;
      finish({ ...empty, error: 'socket timeout' });
    });
    socket.on('connect', () => {
      serverAnswered = true;
    });
    socket.setTimeout(timeoutMs);
  });
  // Also runs when the main handshake failed at the TLS level: a server
  // that only speaks TLS 1.0 / 1.1 fails it but is the worst case.
  info.legacyProtocol = serverAnswered
    ? await probeLegacyProtocol(host, port, timeoutMs)
    : 'untested';
  return info;
}

const LEGACY_CIPHERS = [
  'ECDHE-ECDSA-AES128-SHA',
  'ECDHE-ECDSA-AES256-SHA',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-SHA',
  'AES256-SHA',
  '@SECLEVEL=0',
].join(':');

/**
 * The main handshake negotiates the best version both sides support, so
 * it never shows whether the server still accepts TLS 1.0 / 1.1. This one
 * offers only those versions, with an explicit list of the CBC suites
 * TLS 1.0 / 1.1 servers use. `@SECLEVEL=0` lets OpenSSL 3+ use them.
 * Resolves to the negotiated version, null when the server refuses or the
 * handshake fails, or `untested`.
 */
async function probeLegacyProtocol(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    let socket: TLSSocket | undefined;
    const finish = (protocol: string | null): void => {
      socket?.destroy();
      resolve(protocol);
    };
    try {
      socket = connect(
        {
          host,
          port,
          servername: host,
          rejectUnauthorized: false,
          minVersion: 'TLSv1',
          maxVersion: 'TLSv1.1',
          ciphers: LEGACY_CIPHERS,
        },
        () => finish(socket?.getProtocol() ?? null),
      );
    } catch {
      // A TLS library that rejects these options cannot test legacy support.
      finish('untested');
      return;
    }
    socket.on('error', () => finish(null));
    socket.setTimeout(timeoutMs, () => finish(null));
  });
}

/**
 * Flatten Node's `tls.PeerCertificate` issuer/subject objects (which look
 * like `{ C: 'US', O: 'Google Trust Services', CN: 'WE1' }`) into a
 * compact string `CN=WE1, O=Google Trust Services, C=US`. The order
 * follows the most-specific-first convention used by `openssl x509`.
 */
function formatDistinguishedName(dn: Record<string, string> | null): string | null {
  if (!dn || typeof dn !== 'object') return null;
  const parts: string[] = [];
  for (const key of ['CN', 'O', 'OU', 'L', 'ST', 'C']) {
    const v = dn[key];
    if (typeof v === 'string' && v) parts.push(`${key}=${v}`);
  }
  if (parts.length === 0) return null;
  return parts.join(', ');
}

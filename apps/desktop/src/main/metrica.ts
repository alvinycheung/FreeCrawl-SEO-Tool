/**
 * Yandex Metrica API client.
 *
 *   - `listCounters()` — every counter the token can read (Management API).
 *   - `fetchPageMetrics()` — per-page metrics for a date range from the
 *     Reporting API, joined onto crawl URLs through the caller's
 *     `normalize` function (the crawl's own `normalizeUrl` options).
 *
 * Three reports are pulled, all with `accuracy=full` (unsampled):
 *
 *   1. hit-level   `ym:pv:URL`      → pageviews
 *   2. session     `ym:s:startURL`  → visits, users (by landing page)
 *   3. session     `ym:s:startURL`  → visits filtered to
 *                  `ym:s:trafficSource=='organic'` (search-engine visits)
 *
 * Attribution is left at the API default (cross-device last significant
 * source), which is also the Metrica UI default, so the numbers match
 * what a user sees in the Metrica web interface.
 *
 * Dates: the window ends yesterday, because today's numbers keep moving
 * while pages are fetched and would shift rows across page boundaries.
 * The first request sends a relative range so Metrica resolves it in the
 * counter's time zone; every later page and report reuses the resolved
 * absolute dates, so all three reports cover the same days.
 *
 * Paging: `offset` is 1-based and `limit` tops out at 100 000. For big
 * reports `total_rows` is capped near `offset + limit` (and flagged
 * `total_rows_rounded`), so it can't be used as a stop condition — the
 * loop keeps going until a page comes back short.
 *
 * Auth is a personal OAuth token (`metrika:read`) from the credential
 * store; the caller resolves it so this module stays free of Electron.
 */
import type { MetricaCounter, MetricaErrorCode, MetricaFetchMeta } from '@freecrawl/shared-types';
import { apiFetch } from './api-fetch.js';
import * as logger from './logger.js';

const API_BASE = 'https://api-metrika.yandex.net';
/** Reporting API maximum rows per request. */
const PAGE_LIMIT = 100_000;
/** Smallest page the "query is too complicated" fallback shrinks to. */
const MIN_PAGE_LIMIT = 6_250;
/** Per-report ceiling on raw rows, so a counter with endless query-string
 *  variants can't keep the pull running for ever. Rows are folded into
 *  per-URL totals page by page, so memory follows distinct normalised
 *  Metrica URLs (crawled or not), not raw rows. */
const MAX_ROWS = 1_000_000;
/** Attempts per request on throttling (420 / 429), "too complicated",
 *  5xx and network errors. */
const MAX_ATTEMPTS = 4;

type Totals = MetricaFetchMeta['totals'];

function apiError(json: unknown, status: number): string {
  const msg = (json as { message?: unknown } | null)?.message;
  if (typeof msg === 'string' && msg) return `Yandex Metrica: ${msg}`;
  if (status === 401) {
    return 'Yandex Metrica rejected the token — paste a fresh token with the metrika:read scope in Settings → Integrations.';
  }
  if (status === 403) {
    return 'Yandex Metrica denied access — the token’s account cannot read this counter.';
  }
  return `Yandex Metrica API error (HTTP ${status})`;
}

/** Metrica answers throttling with 429 or 420 (the docs use both) and
 *  sends no `Retry-After`, so both get exponential backoff. */
function isRetryable(status: number): boolean {
  return status === 420 || status === 429 || status >= 500;
}

/** A Metrica failure the UI words in the user's language by `code`; the
 *  English message stays for logs and MCP clients. */
export class MetricaError extends Error {
  constructor(
    message: string,
    readonly code: MetricaErrorCode,
  ) {
    super(message);
  }
}

function codeForStatus(status: number): MetricaErrorCode {
  if (status === 401) return 'token-rejected';
  if (status === 403) return 'access-denied';
  if (status === 0) return 'network';
  return 'api';
}

/** API failure with the HTTP status kept for the caller's fallbacks. */
class MetricaApiError extends MetricaError {
  constructor(
    message: string,
    readonly status: number,
    code: MetricaErrorCode = codeForStatus(status),
  ) {
    super(message, code);
  }
}

/** Metrica's 400 "query is too complicated" for heavy unsampled reports.
 *  It depends on server load, so the same request is retried with longer
 *  pauses first; a smaller page is only the last resort, because each
 *  request costs about the same whatever its page size. */
const TOO_COMPLICATED = /too complicated|слишком сложн/i;

function isTooComplicated(err: unknown): boolean {
  return err instanceof MetricaApiError && err.status === 400 && TOO_COMPLICATED.test(err.message);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Thrown when the caller aborts a pull. */
export class MetricaCancelledError extends Error {
  constructor() {
    super('Yandex Metrica fetch cancelled.');
    this.name = 'MetricaCancelledError';
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MetricaCancelledError();
}

/** Backoff pause that ends early, with a cancel error, on abort. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MetricaCancelledError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new MetricaCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** GET a Metrica endpoint as JSON, retrying throttling and server errors. */
async function getJson(
  token: string,
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = `${API_BASE}${path}?${new URLSearchParams(params).toString()}`;
  let lastError = '';
  let lastStatus = 0;
  let backoffMs = 2_000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    throwIfCancelled(signal);
    const timeout = AbortSignal.timeout(120_000);
    try {
      const res = await apiFetch(url, {
        headers: { Authorization: `OAuth ${token}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const json = (await res.json().catch(() => null)) as unknown;
      // A cancel while the body downloads makes json null; report it as a
      // cancel, not as an API error.
      throwIfCancelled(signal);
      if (res.ok && json) return json;
      lastError = apiError(json, res.status);
      lastStatus = res.status;
      const heavy = res.status === 400 && TOO_COMPLICATED.test(lastError);
      if (heavy) backoffMs = 10_000;
      else if (!isRetryable(res.status)) break;
    } catch (err) {
      throwIfCancelled(signal);
      // Never echo `err.message`: undici quotes the offending header value
      // (the token) in its validation errors.
      const name = err instanceof Error ? err.name : 'Error';
      lastError = `Yandex Metrica request failed (${name})`;
      lastStatus = 0;
    }
    if (attempt < MAX_ATTEMPTS) {
      logger.log('warn', 'metrica', `${lastError} — retry ${attempt}/${MAX_ATTEMPTS - 1}`);
      await sleep(backoffMs * 2 ** (attempt - 1), signal);
    }
  }
  throw new MetricaApiError(lastError, lastStatus);
}

/** Every counter the token can read. */
export async function listCounters(token: string): Promise<MetricaCounter[]> {
  const PER_PAGE = 1000;
  const out: MetricaCounter[] = [];
  for (let offset = 1; ; offset += PER_PAGE) {
    const json = (await getJson(token, '/management/v1/counters', {
      per_page: String(PER_PAGE),
      offset: String(offset),
    })) as {
      counters?: {
        id?: unknown;
        name?: unknown;
        site?: unknown;
        site2?: { site?: unknown } | null;
        owner_login?: unknown;
      }[];
    };
    const counters = Array.isArray(json.counters) ? json.counters : [];
    for (const c of counters) {
      if (typeof c.id !== 'number' && typeof c.id !== 'string') continue;
      const site =
        typeof c.site2?.site === 'string' ? c.site2.site : typeof c.site === 'string' ? c.site : '';
      out.push({
        counterId: String(c.id),
        name: typeof c.name === 'string' && c.name ? c.name : site || String(c.id),
        site,
        ownerLogin: typeof c.owner_login === 'string' ? c.owner_login : '',
      });
    }
    if (counters.length < PER_PAGE) break;
  }
  return out;
}

interface ReportSpec {
  dimension: string;
  metrics: string[];
  filters?: string;
}

interface ReportResult {
  /** Whole-range totals per metric, as the API reports them. */
  totals: number[];
  /** Raw rows received. */
  rowCount: number;
  truncated: boolean;
  /** True when any page came back sampled despite `accuracy=full`. */
  sampled: boolean;
  /** Resolved `YYYY-MM-DD` range the API reported on (counter time zone). */
  date1: string;
  date2: string;
}

/**
 * Pull one report in full, paging until a short page. Each row is handed
 * to `onRow` as it arrives, so raw rows never pile up in memory.
 */
async function runReport(
  token: string,
  counterId: string,
  date1: string,
  date2: string,
  spec: ReportSpec,
  onRow: (url: string, values: number[]) => void,
  signal: AbortSignal | undefined,
  onPage: (rowsSoFar: number) => void,
): Promise<ReportResult> {
  const result: ReportResult = {
    totals: spec.metrics.map(() => 0),
    rowCount: 0,
    truncated: false,
    sampled: false,
    date1,
    date2,
  };
  onPage(0);
  let limit = PAGE_LIMIT;
  for (let offset = 1; ; ) {
    const params: Record<string, string> = {
      ids: counterId,
      // Relative on the very first page, the resolved dates after that.
      date1: result.date1,
      date2: result.date2,
      dimensions: spec.dimension,
      metrics: spec.metrics.join(','),
      // Metric desc, then URL, so the order is total and pages can't
      // overlap or skip rows that tie on the metric.
      sort: `-${spec.metrics[0]},${spec.dimension}`,
      accuracy: 'full',
      limit: String(limit),
      offset: String(offset),
    };
    if (spec.filters) params['filters'] = spec.filters;
    let json: {
      data?: { dimensions?: { name?: unknown }[]; metrics?: unknown[] }[];
      totals?: unknown[];
      sampled?: unknown;
      query?: { date1?: unknown; date2?: unknown };
    };
    try {
      json = (await getJson(token, '/stat/v1/data', params, signal)) as typeof json;
    } catch (err) {
      if (!isTooComplicated(err) || limit <= MIN_PAGE_LIMIT) throw err;
      // Retries didn't help: same offset, half the page. Rows already
      // received stay valid because the sort order is total.
      limit = Math.max(MIN_PAGE_LIMIT, Math.floor(limit / 2));
      logger.log(
        'warn',
        'metrica',
        `report ${spec.dimension} too complicated at offset ${offset} — retrying with limit ${limit}`,
      );
      continue;
    }
    // A response without a row list or resolved dates is a changed or
    // broken API, not an empty report: fail so the stored data survives.
    const resolved1 = json.query?.date1;
    const resolved2 = json.query?.date2;
    if (
      !Array.isArray(json.data) ||
      typeof resolved1 !== 'string' ||
      !ISO_DATE.test(resolved1) ||
      typeof resolved2 !== 'string' ||
      !ISO_DATE.test(resolved2)
    ) {
      throw new MetricaApiError(
        'Yandex Metrica returned an unexpected response.',
        200,
        'unexpected-response',
      );
    }
    if (offset === 1 && !ISO_DATE.test(result.date1)) {
      result.date1 = resolved1;
      result.date2 = resolved2;
    } else if (resolved1 !== result.date1 || resolved2 !== result.date2) {
      throw new MetricaApiError(
        'Yandex Metrica changed the report date range mid-pull.',
        200,
        'range-changed',
      );
    }
    if (json.sampled === true) {
      // accuracy=full should never sample; record it so "no visits"
      // filters refuse to treat missing rows as zero.
      result.sampled = true;
      logger.log('warn', 'metrica', `report ${spec.dimension} came back sampled`);
    }
    if (offset === 1 && Array.isArray(json.totals)) {
      result.totals = spec.metrics.map((_, i) => Number(json.totals?.[i] ?? 0) || 0);
    }
    const data = json.data;
    for (const r of data) {
      const url = r.dimensions?.[0]?.name;
      if (typeof url !== 'string' || !url) continue;
      const m = Array.isArray(r.metrics) ? r.metrics : [];
      onRow(
        url,
        spec.metrics.map((_, i) => Number(m[i] ?? 0) || 0),
      );
    }
    result.rowCount += data.length;
    onPage(result.rowCount);
    // `total_rows` is capped near offset + limit on large reports, so a
    // short page is the only reliable end-of-data signal.
    if (data.length < limit) break;
    offset += limit;
    if (result.rowCount >= MAX_ROWS) {
      result.truncated = true;
      logger.log(
        'warn',
        'metrica',
        `report ${spec.dimension} stopped at ${result.rowCount} rows (cap)`,
      );
      break;
    }
  }
  return result;
}

/** One per-page Metrica row, keyed by the crawl-normalised URL. */
export interface MetricaPageRow {
  url: string;
  pageviews: number;
  visits: number;
  users: number;
  searchVisits: number;
}

/** Where a running pull is: which of the three reports, and how many raw
 *  rows that report has returned so far. */
export interface MetricaFetchProgress {
  report: 'pageviews' | 'visits' | 'searchVisits';
  reportIndex: number;
  reportCount: number;
  rows: number;
}

export interface MetricaFetchOptions {
  /** Aborts the pull, including any backoff pause in progress. */
  signal?: AbortSignal;
  onProgress?: (progress: MetricaFetchProgress) => void;
}

export interface MetricaPageMetrics {
  rows: MetricaPageRow[];
  totals: Totals;
  /** Inclusive `YYYY-MM-DD` range the API reported on, counter time zone. */
  startDate: string;
  endDate: string;
  /** Raw report rows dropped because their URL failed to normalise. */
  dropped: number;
  /** True when a report hit the row ceiling. */
  truncated: boolean;
  /** True when a report came back sampled. */
  sampled: boolean;
}

/**
 * Pull per-page metrics for the `days` full days ending yesterday and fold
 * them onto crawl URLs. The range is first sent as `NdaysAgo`…`yesterday`,
 * so Metrica resolves it in the counter's own time zone. Several raw Metrica
 * URLs can normalise to the same crawl URL (tracking parameters,
 * `#fragments`, host / slash rewrites); their counts are summed. For
 * `users` that sum can count a person once per URL variant — exact for
 * the common case of one variant per page, an upper bound otherwise.
 */
export async function fetchPageMetrics(
  token: string,
  counterId: string,
  days: number,
  normalize: (url: string) => string | null,
  opts: MetricaFetchOptions = {},
): Promise<MetricaPageMetrics> {
  const { signal, onProgress } = opts;
  const progress =
    (report: MetricaFetchProgress['report'], reportIndex: number) =>
    (rows: number): void =>
      onProgress?.({ report, reportIndex, reportCount: 3, rows });
  const started = Date.now();
  const relative1 = `${days}daysAgo`;
  const relative2 = 'yesterday';
  const byUrl = new Map<string, MetricaPageRow>();
  let dropped = 0;
  const rowFor = (raw: string): MetricaPageRow | null => {
    const url = normalize(raw);
    if (!url) {
      dropped++;
      return null;
    }
    let row = byUrl.get(url);
    if (!row) {
      row = { url, pageviews: 0, visits: 0, users: 0, searchVisits: 0 };
      byUrl.set(url, row);
    }
    return row;
  };

  const pv = await runReport(
    token,
    counterId,
    relative1,
    relative2,
    { dimension: 'ym:pv:URL', metrics: ['ym:pv:pageviews'] },
    (url, v) => {
      const row = rowFor(url);
      if (row) row.pageviews += v[0] ?? 0;
    },
    signal,
    progress('pageviews', 1),
  );
  // Later reports reuse the dates the first one resolved to.
  const { date1, date2 } = pv;
  const sessions = await runReport(
    token,
    counterId,
    date1,
    date2,
    { dimension: 'ym:s:startURL', metrics: ['ym:s:visits', 'ym:s:users'] },
    (url, v) => {
      const row = rowFor(url);
      if (!row) return;
      row.visits += v[0] ?? 0;
      row.users += v[1] ?? 0;
    },
    signal,
    progress('visits', 2),
  );
  const search = await runReport(
    token,
    counterId,
    date1,
    date2,
    {
      dimension: 'ym:s:startURL',
      metrics: ['ym:s:visits'],
      filters: "ym:s:trafficSource=='organic'",
    },
    (url, v) => {
      const row = rowFor(url);
      if (row) row.searchVisits += v[0] ?? 0;
    },
    signal,
    progress('searchVisits', 3),
  );

  const rows = [...byUrl.values()];
  logger.log(
    'info',
    'metrica',
    `Metrica report: ${rows.length} page(s) for counter ${counterId} (${pv.date1}…${pv.date2}) from ` +
      `${pv.rowCount}/${sessions.rowCount}/${search.rowCount} raw rows, ` +
      `${dropped} dropped, ${Math.round((Date.now() - started) / 1000)} s`,
  );
  return {
    rows,
    totals: {
      pageviews: pv.totals[0] ?? 0,
      visits: sessions.totals[0] ?? 0,
      users: sessions.totals[1] ?? 0,
      searchVisits: search.totals[0] ?? 0,
    },
    startDate: pv.date1,
    endDate: pv.date2,
    dropped,
    truncated: pv.truncated || sessions.truncated || search.truncated,
    sampled: pv.sampled || sessions.sampled || search.sampled,
  };
}

/**
 * Yandex Metrica integration — shared types.
 *
 * Metrica is connected with a personal OAuth token (scope `metrika:read`)
 * kept in the credential store under the `metrica` integration. One token
 * can read several counters, so pulled rows are keyed by `(url,
 * account_id)` where `account_id` is the counter ID — the analogue of the
 * linked Google account for GA4.
 *
 * Two attribution levels live side by side and must not be mixed up:
 *
 *  - `pageviews` is hit-level: every view of the page URL counts.
 *  - `visits`, `users` and `searchVisits` are session-level and are
 *    attributed to the session's landing page (`ym:s:startURL`). A page
 *    that is viewed a lot but never starts a session has pageviews and
 *    zero visits.
 */

/** One Metrica counter the connected token can read. */
export interface MetricaCounter {
  /** Numeric counter ID, as a string (it is also the stored `account_id`). */
  counterId: string;
  /** Counter name set in Metrica. */
  name: string;
  /** Site the counter is installed on (`site2.site`). */
  site: string;
  /** Yandex login that owns the counter. */
  ownerLogin: string;
}

/** Per-page Yandex Metrica metrics for a date range. */
export interface MetricaMetrics {
  /** Hit-level: views of this page URL (`ym:pv:pageviews`). */
  pageviews: number;
  /** Session-level: sessions that started on this page (`ym:s:visits`). */
  visits: number;
  /** Session-level: users whose sessions started on this page (`ym:s:users`).
   *  When several raw URL variants (tracking parameters, fragments) fold
   *  into one crawl URL their users are summed, so this is an upper bound. */
  users: number;
  /** Session-level: sessions from search engines that started on this page
   *  (`ym:s:visits` with `ym:s:trafficSource=='organic'`). */
  searchVisits: number;
  fetchedAt: string;
}

/** One Metrica tab row — a crawled page joined with its Metrica data. */
export interface MetricaRow {
  /** `urls.id` — what the Detail panel opens when the row is clicked. */
  id: number;
  url: string;
  statusCode: number | null;
  indexability: string | null;
  /** Null when the page had no Metrica data in the range. */
  metrica: MetricaMetrics | null;
}

/** Per-project Yandex Metrica settings, persisted in the project file. */
export interface MetricaIntegrationSettings {
  /** Last-selected counter ID. */
  counterId: string;
  /** Friendly label for that counter, for the fetch meta line. */
  counterName: string;
  /** Trailing window in days. */
  days: 7 | 28 | 90;
}

/** Factory for the default Metrica settings (fresh object each call). */
export function defaultMetricaSettings(): MetricaIntegrationSettings {
  return { counterId: '', counterName: '', days: 28 };
}

/** Why a Metrica call failed, for the UI to word in the user's language.
 *  The result's `error` keeps the English text for logs and MCP clients;
 *  `api` means Metrica's own message (or an HTTP status) is all there is. */
export type MetricaErrorCode =
  | 'not-connected'
  | 'token-format'
  | 'token-rejected'
  | 'access-denied'
  | 'no-counter'
  | 'bad-range'
  | 'already-running'
  | 'project-switched'
  | 'unexpected-response'
  | 'range-changed'
  | 'network'
  | 'api';

/** Why an absence filter (`without-data`, `indexable-no-visits`) returned
 *  nothing: no pull yet, or the last pull hit the row cap or was sampled,
 *  so a missing row can't be read as zero traffic. The UI turns the code
 *  into text. */
export type MetricaNotice = 'no-pull' | 'truncated' | 'sampled';

/** Metadata describing the most recent Metrica pull for one counter. */
export interface MetricaFetchMeta {
  counterId: string;
  counterName: string;
  /** Inclusive date range, `YYYY-MM-DD`, in the counter's time zone. The
   *  window ends yesterday: today's data is still arriving. */
  startDate: string;
  endDate: string;
  fetchedAt: string;
  /** Number of distinct (normalised) page URLs stored. */
  rowCount: number;
  /** True when a report hit the client's row ceiling, so the long tail of
   *  low-traffic URLs is missing. */
  truncated: boolean;
  /** True when Metrica returned sampled data despite `accuracy=full`. */
  sampled: boolean;
  /** Whole-site totals reported by the API for the range, for a sanity
   *  check against the per-URL sums and the Metrica UI. */
  totals: {
    pageviews: number;
    visits: number;
    users: number;
    searchVisits: number;
  };
}

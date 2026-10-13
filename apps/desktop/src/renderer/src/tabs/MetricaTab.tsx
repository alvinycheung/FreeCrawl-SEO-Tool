import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { TabExportButton } from '../components/TabExportButton.js';
import { Loader2, Search, RefreshCw } from 'lucide-react';
import {
  defaultMetricaSettings,
  type MetricaCounter,
  type MetricaFetchMeta,
  type MetricaNotice,
  type MetricaErrorCode,
  type MetricaProgress,
  type MetricaQueryInput,
  type MetricaRow,
} from '@freecrawl/shared-types';
import { useAppStore } from '../store.js';

const TOOLBAR_HEIGHT = 36;
const HEADER_HEIGHT = 26;
const STATUS_BAR_HEIGHT = 22;
const ROW_HEIGHT = 30;
/** `queryMetrica` returns at most 1000 rows per call. */
const PAGE_SIZE = 1000;
const POLL_MS_RUNNING = 5000;

type FilterMode = NonNullable<MetricaQueryInput['filter']>;
type RangeDays = 7 | 28 | 90;
type Stage = 'loading' | 'unconfigured' | 'ready' | 'error';

// The latest progress event, kept outside the component so a pull that
// is still running when the user leaves the tab and comes back (or one an
// MCP agent started) shows up without waiting for the next page.
let lastProgress: MetricaProgress | null = null;
const progressListeners = new Set<(p: MetricaProgress | null) => void>();
let progressSubscribed = false;
function subscribeProgress(cb: (p: MetricaProgress | null) => void): () => void {
  if (!progressSubscribed) {
    progressSubscribed = true;
    window.freecrawl.onMetricaProgress((p) => {
      lastProgress = p.running ? p : null;
      for (const l of progressListeners) l(lastProgress);
    });
  }
  progressListeners.add(cb);
  return () => {
    progressListeners.delete(cb);
  };
}

type T = ReturnType<typeof useTranslation>['t'];

function relativeTime(iso: string, t: T): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const min = Math.floor((Date.now() - then) / 60_000);
  if (min < 1) return t('metricaTab.agoNow', { defaultValue: 'just now' });
  if (min < 60) return t('metricaTab.agoMinutes', { defaultValue: '{{count}}m ago', count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('metricaTab.agoHours', { defaultValue: '{{count}}h ago', count: hr });
  return t('metricaTab.agoDays', {
    defaultValue: '{{count}}d ago',
    count: Math.floor(hr / 24),
  });
}

function persistCounter(c: MetricaCounter): void {
  void window.freecrawl.integrationSettingsSet('metrica', {
    counterId: c.counterId,
    counterName: c.name || c.counterId,
  });
}

export function MetricaTab() {
  const { t } = useTranslation();
  const dataVersion = useAppStore((s) => s.dataVersion);
  // Clicking a row opens its page in the Detail panel below, as in the URL
  // tables — without this the panel kept whatever another tab had picked.
  const selectedUrlId = useAppStore((s) => s.selectedUrlId);
  const setSelectedUrlId = useAppStore((s) => s.setSelectedUrlId);
  const setSelectedUrlIds = useAppStore((s) => s.setSelectedUrlIds);
  const crawlProgress = useAppStore((s) => s.progress);

  const [stage, setStage] = useState<Stage>('loading');
  const [counters, setCounters] = useState<MetricaCounter[]>([]);
  const [countersLoading, setCountersLoading] = useState(false);
  const [counterId, setCounterId] = useState('');
  const [days, setDays] = useState<RangeDays>(28);
  const [rows, setRows] = useState<MetricaRow[]>([]);
  const [total, setTotal] = useState(0);
  const [meta, setMeta] = useState<MetricaFetchMeta | null>(null);
  const [notice, setNotice] = useState<MetricaNotice | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [progress, setProgress] = useState<MetricaProgress | null>(lastProgress);
  const [error, setError] = useState<string | null>(null);
  // Set for Metrica failures: the banner words the code in the UI language
  // and falls back to the main process's English text (Metrica's own
  // message, or a failure without a code).
  const [errorCode, setErrorCode] = useState<MetricaErrorCode | null>(null);
  const showError = useCallback((text: string | null, code: MetricaErrorCode | null = null) => {
    setError(text);
    setErrorCode(code);
  }, []);
  const [info, setInfo] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fetching = progress !== null;

  const loadCounters = useCallback(async () => {
    setCountersLoading(true);
    try {
      const res = await window.freecrawl.metricaListCounters();
      if (!res.ok) {
        showError(res.error, res.errorCode);
        setCounters([]);
        return;
      }
      showError(null);
      setCounters(res.counters);
      // Persisting from a state updater would run it twice in StrictMode;
      // the stored ID is read from settings instead.
      const stored = await window.freecrawl.integrationSettingsGet('metrica');
      const prev = typeof stored?.['counterId'] === 'string' ? stored['counterId'] : '';
      if (prev && res.counters.some((c) => c.counterId === prev)) {
        setCounterId(prev);
      } else {
        const fallback = res.counters[0];
        if (fallback) persistCounter(fallback);
        setCounterId(fallback?.counterId ?? '');
      }
    } finally {
      setCountersLoading(false);
    }
  }, [showError]);

  /** Switch the project to another counter: persist the choice so the
   *  export, the orphan report and per-URL analytics read the same counter
   *  the table shows, then reload the table (the effect below). */
  const changeCounter = useCallback(
    (next: string) => {
      setCounterId(next);
      const selected = counters.find((c) => c.counterId === next);
      if (selected) persistCounter(selected);
    },
    [counters],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [integrations, stored] = await Promise.all([
          window.freecrawl.integrationsGetAll(),
          window.freecrawl.integrationSettingsGet('metrica'),
        ]);
        if (cancelled) return;
        const s = { ...defaultMetricaSettings(), ...(stored ?? {}) };
        setDays(s.days);
        if (s.counterId) setCounterId(s.counterId);
        if (!(integrations['metrica']?.configured ?? false)) {
          setStage('unconfigured');
          return;
        }
        setStage('ready');
        void loadCounters();
      } catch (e) {
        if (cancelled) return;
        showError(e instanceof Error ? e.message : String(e));
        setStage('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadCounters, retryNonce, showError]);

  // Queries run on a reader pool and can finish out of order; only the
  // latest one may fill the table.
  const reloadSeq = useRef(0);
  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    const res = await window.freecrawl.metricaQuery({
      limit: PAGE_SIZE,
      offset: 0,
      search: search || undefined,
      filter,
      counterId: counterId || undefined,
    });
    if (seq !== reloadSeq.current) return;
    setRows(res.rows);
    setTotal(res.total);
    setMeta(res.meta);
    setNotice(res.notice);
  }, [search, filter, counterId]);

  useEffect(() => {
    if (stage !== 'ready') return;
    let cancelled = false;
    void reload();
    if (!crawlProgress?.running) return;
    const id = setInterval(() => {
      if (!cancelled) void reload();
    }, POLL_MS_RUNNING);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [stage, reload, dataVersion, crawlProgress?.running]);

  // A pull started elsewhere (an MCP client) stores its counter, and opening
  // another project brings that project's counter; both fire data-changed.
  // Follow the stored counter so the table shows what the export reads.
  const counterRef = useRef({ counterId, counters });
  counterRef.current = { counterId, counters };
  const seenDataVersion = useRef(dataVersion);
  useEffect(() => {
    if (stage !== 'ready' || seenDataVersion.current === dataVersion) return;
    seenDataVersion.current = dataVersion;
    let cancelled = false;
    const sentFor = counterRef.current.counterId;
    void window.freecrawl.integrationSettingsGet('metrica').then((stored) => {
      // A pick made while the read was in flight is newer than what it read.
      if (cancelled || counterRef.current.counterId !== sentFor) return;
      const storedId = typeof stored?.['counterId'] === 'string' ? stored['counterId'] : '';
      const { counterId: shown, counters: list } = counterRef.current;
      if (storedId) {
        if (storedId !== shown) setCounterId(storedId);
        return;
      }
      // A project with no stored counter: store the one on screen.
      const selected = list.find((c) => c.counterId === shown);
      if (selected) persistCounter(selected);
    });
    return () => {
      cancelled = true;
    };
  }, [stage, dataVersion]);

  useEffect(() => subscribeProgress(setProgress), []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
    getItemKey: (index) => rows[index]?.url ?? `idx-${index}`,
  });

  const runFetch = useCallback(async () => {
    if (!counterId || fetching) return;
    const selected = counters.find((c) => c.counterId === counterId);
    showError(null);
    setInfo(null);
    setProgress({ running: true, report: 'pageviews', reportIndex: 1, reportCount: 3, rows: 0 });
    try {
      const res = await window.freecrawl.metricaFetch({
        counterId,
        counterName: selected?.name || counterId,
        days,
      });
      if (res.cancelled) {
        setInfo(
          t('metricaTab.cancelled', {
            defaultValue: 'Fetch cancelled. The previously stored data is unchanged.',
          }),
        );
      } else if (!res.ok) {
        showError(res.error, res.errorCode);
      } else {
        setMeta(res.meta);
      }
    } finally {
      setProgress(lastProgress);
      await reload();
    }
  }, [counterId, counters, days, fetching, reload, showError, t]);

  const cancelFetch = useCallback(() => {
    void window.freecrawl.metricaCancel();
  }, []);

  const reportLabel = (report: MetricaProgress['report']): string =>
    report === 'visits'
      ? t('metricaTab.reportVisits', { defaultValue: 'visits' })
      : report === 'searchVisits'
        ? t('metricaTab.reportSearchVisits', { defaultValue: 'search visits' })
        : t('metricaTab.reportPageviews', { defaultValue: 'pageviews' });

  const errorText = (code: MetricaErrorCode | null): string | null => {
    switch (code) {
      case 'not-connected':
        return t('metricaTab.errNotConnected', {
          defaultValue:
            'Yandex Metrica is not connected — paste a token in Settings → Integrations → Yandex Metrica.',
        });
      case 'token-format':
        return t('metricaTab.errTokenFormat', {
          defaultValue:
            'The saved Yandex Metrica token has an unexpected format — paste it again in Settings → Integrations → Yandex Metrica.',
        });
      case 'token-rejected':
        return t('metricaTab.errTokenRejected', {
          defaultValue:
            'Yandex Metrica rejected the token (HTTP 401) — paste a fresh token with the metrika:read permission in Settings → Integrations → Yandex Metrica.',
        });
      case 'access-denied':
        return t('metricaTab.errAccessDenied', {
          defaultValue:
            'Yandex Metrica denied access (HTTP 403) — the account behind the token cannot read this counter.',
        });
      case 'no-counter':
        return t('metricaTab.errNoCounter', { defaultValue: 'No Yandex Metrica counter selected.' });
      case 'bad-range':
        return t('metricaTab.errBadRange', { defaultValue: 'Unsupported date range.' });
      case 'already-running':
        return t('metricaTab.errAlreadyRunning', {
          defaultValue: 'A Yandex Metrica fetch is already running in this window.',
        });
      case 'project-switched':
        return t('metricaTab.errProjectSwitched', {
          defaultValue:
            'Another project was opened during the fetch, so its result was discarded. Fetch again in this project.',
        });
      case 'unexpected-response':
        return t('metricaTab.errUnexpectedResponse', {
          defaultValue:
            'Yandex Metrica returned an unexpected response. The previously stored data is unchanged.',
        });
      case 'range-changed':
        return t('metricaTab.errRangeChanged', {
          defaultValue:
            'Yandex Metrica changed the report date range during the fetch. The previously stored data is unchanged — fetch again.',
        });
      case 'network':
        return t('metricaTab.errNetwork', {
          defaultValue: 'Could not reach Yandex Metrica. Check the connection and try again.',
        });
      default:
        return null;
    }
  };

  const noticeText = (code: MetricaNotice): string =>
    code === 'truncated'
      ? t('metricaTab.noticeTruncated', {
          defaultValue:
            'The last Yandex Metrica fetch hit the row limit, so pages missing from it may still have traffic. This filter is unavailable until a complete fetch.',
        })
      : code === 'sampled'
        ? t('metricaTab.noticeSampled', {
            defaultValue:
              'The last Yandex Metrica fetch came back sampled, so pages missing from it may still have traffic. This filter is unavailable until an unsampled fetch.',
          })
        : t('metricaTab.noticeNoPull', {
            defaultValue:
              'No Yandex Metrica data has been fetched for this counter yet. Fetch first: without a complete fetch, a page with no row can’t be read as zero traffic.',
          });

  // ── Gate states ──────────────────────────────────────────────────────
  if (stage === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-surface-950 text-[12px] text-surface-500">
        <Loader2 size={14} className="mr-2 animate-spin" />
        {t('metricaTab.loading', { defaultValue: 'Loading…' })}
      </div>
    );
  }

  if (stage === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface-950 px-6 text-center">
        <div className="text-[13px] font-semibold text-rose-300">
          {t('common.loadFailedTitle', { defaultValue: "Couldn't load this view" })}
        </div>
        {error && <div className="max-w-md break-words text-[11px] text-surface-500">{error}</div>}
        <button
          type="button"
          className="mt-1 rounded border border-surface-700 px-3 py-1 text-[12px] text-surface-200 hover:bg-surface-800"
          onClick={() => {
            showError(null);
            setStage('loading');
            setRetryNonce((n) => n + 1);
          }}
        >
          {t('common.retry', { defaultValue: 'Retry' })}
        </button>
      </div>
    );
  }

  if (stage === 'unconfigured') {
    return (
      <GateMessage
        title={t('metricaTab.unconfiguredTitle', {
          defaultValue: 'Yandex Metrica is not set up',
        })}
        body={t('metricaTab.unconfiguredBody', {
          defaultValue:
            'Open Settings → Integrations → Yandex Metrica and paste a token with the metrika:read permission. The setup guide there walks through getting one. Then come back here to pick a counter.',
        })}
      />
    );
  }

  const selectCls =
    'h-6 rounded border border-surface-700 bg-surface-950 px-1.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none';
  const sessionHint = t('metricaTab.sessionHint', {
    defaultValue:
      'Session-level: counted for the page a session started on (landing page), not for every page viewed.',
  });

  return (
    <div className="flex h-full w-full flex-col bg-surface-950">
      <div
        className="flex items-center gap-2 border-b border-surface-800 bg-surface-900/40 px-3"
        style={{ height: TOOLBAR_HEIGHT }}
      >
        <div className="text-[12px] font-semibold tracking-wide text-surface-100">
          {t('metricaTab.title', { defaultValue: 'Yandex Metrica' })}
        </div>
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-surface-500"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('metricaTab.filterPlaceholder', {
              defaultValue: 'Filter by URL…',
            })}
            className="h-6 w-48 rounded border border-surface-700 bg-surface-950 pl-6 pr-2 text-[11px] text-surface-100 placeholder-surface-500 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <select
          className={selectCls}
          value={filter}
          onChange={(e) => setFilter(e.target.value as FilterMode)}
        >
          <option value="all">
            {t('metricaTab.filterAll', { defaultValue: 'All 2xx pages' })}
          </option>
          <option value="with-data">
            {t('metricaTab.filterWith', { defaultValue: 'With Metrica data' })}
          </option>
          <option value="without-data">
            {t('metricaTab.filterWithout', { defaultValue: 'No Metrica data' })}
          </option>
          <option value="indexable-no-visits">
            {t('metricaTab.filterIndexableNoVisits', {
              defaultValue: 'Indexable, no visits',
            })}
          </option>
          <option value="non200-with-traffic">
            {t('metricaTab.filterNon200', {
              defaultValue: 'Non-2xx with traffic',
            })}
          </option>
        </select>

        <div className="ml-auto flex items-center gap-2">
          <TabExportButton tab="metrica" disabled={total === 0} />
          <select
            className={`${selectCls} max-w-[260px]`}
            value={counterId}
            onChange={(e) => changeCounter(e.target.value)}
            disabled={fetching || counters.length === 0}
            title={counterId}
          >
            {counters.length === 0 && (
              <option value="">
                {countersLoading
                  ? t('metricaTab.countersLoading', { defaultValue: 'Loading counters…' })
                  : t('metricaTab.noCounters', { defaultValue: 'No counters' })}
              </option>
            )}
            {counters.map((c) => (
              <option key={c.counterId} value={c.counterId}>
                {c.name || c.site || c.counterId}
                {c.site && c.site !== c.name ? ` — ${c.site}` : ''} ({c.counterId})
              </option>
            ))}
          </select>
          <select
            className={selectCls}
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as RangeDays)}
            disabled={fetching}
            title={t('metricaTab.daysTitle', {
              defaultValue: 'Full days ending yesterday, in the counter’s time zone.',
            })}
          >
            <option value={7}>{t('metricaTab.days7', { defaultValue: 'Last 7 days' })}</option>
            <option value={28}>{t('metricaTab.days28', { defaultValue: 'Last 28 days' })}</option>
            <option value={90}>{t('metricaTab.days90', { defaultValue: 'Last 90 days' })}</option>
          </select>
          {fetching ? (
            <button
              type="button"
              onClick={cancelFetch}
              className="h-6 rounded border border-red-700 bg-red-900/40 px-2.5 text-[11px] font-medium text-red-200 hover:bg-red-900/70"
            >
              {t('metricaTab.cancel', { defaultValue: 'Cancel' })}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void runFetch()}
              disabled={!counterId}
              className="inline-flex h-6 items-center gap-1.5 rounded bg-blue-600 px-2.5 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-surface-700 disabled:text-surface-500"
            >
              <RefreshCw size={12} />
              {t('metricaTab.fetch', { defaultValue: 'Fetch' })}
            </button>
          )}
        </div>
      </div>

      {/* Context line — last pull and the API's whole-site totals */}
      {meta && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-surface-800 bg-surface-900/20 px-3 py-1 text-[10px] text-surface-500">
          <span>
            {t('metricaTab.metaLine', {
              defaultValue_one:
                '{{counter}} · {{start}} → {{end}} · {{formatted}} page · fetched {{ago}}',
              defaultValue_other:
                '{{counter}} · {{start}} → {{end}} · {{formatted}} pages · fetched {{ago}}',
              defaultValue:
                '{{counter}} · {{start}} → {{end}} · {{formatted}} pages · fetched {{ago}}',
              count: meta.rowCount,
              counter: meta.counterName,
              start: meta.startDate,
              end: meta.endDate,
              formatted: meta.rowCount.toLocaleString(),
              ago: relativeTime(meta.fetchedAt, t),
            })}
          </span>
          <span
            title={t('metricaTab.totalsTitle', {
              defaultValue:
                'Whole-site totals reported by Metrica for the range, for comparison with the Metrica interface.',
            })}
          >
            {t('metricaTab.totalsLine', {
              defaultValue:
                'Site totals: {{pageviews}} pageviews · {{visits}} visits · {{searchVisits}} search visits',
              pageviews: meta.totals.pageviews.toLocaleString(),
              visits: meta.totals.visits.toLocaleString(),
              searchVisits: meta.totals.searchVisits.toLocaleString(),
            })}
          </span>
          {meta.truncated && (
            <span className="text-amber-400">
              {t('metricaTab.truncatedFlag', {
                defaultValue: 'Row limit reached: low-traffic pages are missing',
              })}
            </span>
          )}
          {meta.sampled && (
            <span className="text-amber-400">
              {t('metricaTab.sampledFlag', { defaultValue: 'Sampled data' })}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="border-b border-red-700/40 bg-red-900/20 px-3 py-1 text-[10px] text-red-300">
          {errorText(errorCode) ?? error}
        </div>
      )}
      {info && (
        <div className="border-b border-surface-800 bg-surface-900/20 px-3 py-1 text-[10px] text-surface-400">
          {info}
        </div>
      )}

      {/* Column header */}
      <div
        className="flex shrink-0 select-none items-center border-b border-surface-800 bg-surface-900/60 text-[10px] font-medium text-surface-400"
        style={{ height: HEADER_HEIGHT }}
      >
        <div className="flex-1 px-2">{t('metricaTab.colUrl', { defaultValue: 'URL' })}</div>
        <div className="w-[54px] shrink-0 text-center">
          {t('metricaTab.colStatus', { defaultValue: 'Status' })}
        </div>
        <div
          className="w-[96px] shrink-0 text-right"
          title={t('metricaTab.colPageviewsHint', {
            defaultValue: 'Hit-level: every view of this page URL.',
          })}
        >
          {t('metricaTab.colPageviews', { defaultValue: 'Pageviews (hits)' })}
        </div>
        <div className="w-[96px] shrink-0 text-right" title={sessionHint}>
          {t('metricaTab.colVisits', { defaultValue: 'Visits (landing)' })}
        </div>
        <div
          className="w-[96px] shrink-0 text-right"
          title={t('metricaTab.colUsersHint', {
            defaultValue:
              'Session-level, by landing page. An upper bound: one person landing on several pages counts once per page.',
          })}
        >
          {t('metricaTab.colUsers', { defaultValue: 'Users (landing)' })}
        </div>
        <div
          className="w-[120px] shrink-0 text-right"
          title={t('metricaTab.colSearchVisitsHint', {
            defaultValue: 'Session-level: sessions from search engines that started on this page.',
          })}
        >
          {t('metricaTab.colSearchVisits', { defaultValue: 'Search visits (landing)' })}
        </div>
        <div className="w-[88px] shrink-0 px-2 text-right">
          {t('metricaTab.colFetched', { defaultValue: 'Fetched' })}
        </div>
      </div>

      {/* Body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-surface-500">
            {notice
              ? noticeText(notice)
              : total === 0 && filter === 'all' && !search
                ? t('metricaTab.emptyNoData', {
                    defaultValue:
                      'No internal HTML pages crawled yet — run a crawl, then fetch Metrica data.',
                  })
                : t('metricaTab.emptyNoMatch', {
                    defaultValue: 'No pages match the current filter.',
                  })}
          </div>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((vRow) => {
              const row = rows[vRow.index];
              if (!row) return null;
              return (
                <div
                  key={vRow.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: ROW_HEIGHT,
                    transform: `translateY(${vRow.start}px)`,
                  }}
                >
                  <MetricaDataRow
                    row={row}
                    t={t}
                    active={selectedUrlId === row.id}
                    onSelect={() => {
                      setSelectedUrlId(row.id);
                      setSelectedUrlIds([row.id]);
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div
        className="flex items-center gap-3 border-t border-surface-800 bg-surface-900/40 px-3 text-[11px] text-surface-400"
        style={{ height: STATUS_BAR_HEIGHT }}
      >
        <span>
          {t('metricaTab.summary', {
            defaultValue_one: '{{shown}} of {{formatted}} page',
            defaultValue_other: '{{shown}} of {{formatted}} pages',
            defaultValue: '{{shown}} of {{formatted}} pages',
            count: total,
            shown: rows.length.toLocaleString(),
            formatted: total.toLocaleString(),
          })}
        </span>
        {progress && (
          <span className="flex items-center gap-1.5 text-surface-500">
            <Loader2 size={11} className="animate-spin text-blue-400" />
            {t('metricaTab.progress', {
              defaultValue_one:
                'Fetching {{report}} report ({{index}}/{{total}}) · {{formatted}} row',
              defaultValue_other:
                'Fetching {{report}} report ({{index}}/{{total}}) · {{formatted}} rows',
              defaultValue: 'Fetching {{report}} report ({{index}}/{{total}}) · {{formatted}} rows',
              count: progress.rows,
              report: reportLabel(progress.report),
              index: progress.reportIndex,
              total: progress.reportCount,
              formatted: progress.rows.toLocaleString(),
            })}
          </span>
        )}
      </div>
    </div>
  );
}

function MetricaDataRow({
  row,
  t,
  active,
  onSelect,
}: {
  row: MetricaRow;
  t: T;
  /** The page the Detail panel is showing. */
  active: boolean;
  onSelect: () => void;
}) {
  const m = row.metrica;
  const status = row.statusCode;
  const statusCls =
    status === null
      ? 'text-surface-600'
      : status >= 200 && status < 300
        ? 'text-emerald-400'
        : status >= 300 && status < 400
          ? 'text-blue-400'
          : 'text-red-400';

  return (
    <div
      onClick={onSelect}
      className={`flex h-full cursor-pointer items-center text-[11px] ${
        active ? 'bg-accent-500/20' : 'odd:bg-surface-900/20 hover:bg-surface-800/40'
      }`}
    >
      <div className="flex-1 truncate px-2 text-surface-200" title={row.url}>
        {row.url}
      </div>
      <div className={`w-[54px] shrink-0 text-center tabular-nums ${statusCls}`}>
        {status ?? '—'}
      </div>
      <div className="w-[96px] shrink-0 text-right tabular-nums text-surface-200">
        {m ? m.pageviews.toLocaleString() : '—'}
      </div>
      <div className="w-[96px] shrink-0 text-right tabular-nums text-surface-200">
        {m ? m.visits.toLocaleString() : '—'}
      </div>
      <div className="w-[96px] shrink-0 text-right tabular-nums text-surface-300">
        {m ? m.users.toLocaleString() : '—'}
      </div>
      <div className="w-[120px] shrink-0 text-right tabular-nums text-surface-300">
        {m ? m.searchVisits.toLocaleString() : '—'}
      </div>
      <div className="w-[88px] shrink-0 truncate px-2 text-right text-surface-500">
        {m ? relativeTime(m.fetchedAt, t) : '—'}
      </div>
    </div>
  );
}

function GateMessage({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center bg-surface-950 px-6">
      <div className="max-w-md text-center">
        <div className="mb-1.5 text-[13px] font-semibold text-surface-200">{title}</div>
        <div className="text-[11px] leading-relaxed text-surface-500">{body}</div>
        {children}
      </div>
    </div>
  );
}

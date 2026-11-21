import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Check,
  Copy,
  Download,
  Film,
  KeyRound,
  Link2,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import type {
  AspectRatioPreset,
  BatchJob,
  IntegrationSettings,
  LibraryVideo,
  MomentCategory,
} from '../types/clipper';
import { apiUrl } from '../utils/api';
import { CATEGORY_LABELS, formatBytes, formatTimecode } from '../utils/format';

interface LibraryStageProps {
  activeJob: BatchJob | null;
  libraryVideos: LibraryVideo[];
  libraryTotalBytes: number;
  onPlayVideo: (video: LibraryVideo) => void;
  onDeleteVideo: (videoId: string) => Promise<void>;
  onRefreshLibrary: () => Promise<void>;
}

const PAGE_SIZE = 24;

function resolveAbsoluteUrl(relativeOrAbsolutePath: string): string {
  const path = apiUrl(relativeOrAbsolutePath);
  if (/^https?:\/\//i.test(path)) return path;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path.startsWith('/') ? '' : '/'}${path}`;
  }
  return path;
}

export const LibraryStage: React.FC<LibraryStageProps> = ({
  activeJob,
  libraryVideos,
  libraryTotalBytes,
  onPlayVideo,
  onDeleteVideo,
  onRefreshLibrary,
}) => {
  const [movieFilter, setMovieFilter] = useState<string>('all');
  const [ratioFilter, setRatioFilter] = useState<'all' | AspectRatioPreset>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | MomentCategory>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'chronological' | 'score'>('newest');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [brokenThumbs, setBrokenThumbs] = useState<Record<string, boolean>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // External Tool Integration State
  const [settings, setSettings] = useState<IntegrationSettings>({
    feedEnabled: true,
    authEnabled: false,
    apiKey: '',
    webhookUrl: '',
  });
  const [suggestedFeedUrl, setSuggestedFeedUrl] = useState<string>('');
  const [showAdvancedAuth, setShowAdvancedAuth] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);
  const [testingFeed, setTestingFeed] = useState(false);
  const [feedTestResult, setFeedTestResult] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const loadIntegration = async () => {
      try {
        const res = await fetch(apiUrl('/api/integration'));
        if (!res.ok) return;
        const data = (await res.json()) as {
          settings: IntegrationSettings;
          feedUrl?: string;
          suggestedPublicFeedUrl?: string;
        };
        if (!active) return;
        setSettings(data.settings);
        if (data.suggestedPublicFeedUrl || data.feedUrl) {
          setSuggestedFeedUrl(data.suggestedPublicFeedUrl || data.feedUrl || '');
        }
      } catch {
        // Ignore transient error
      }
    };
    void loadIntegration();
    return () => {
      active = false;
    };
  }, []);

  const browserFeedUrl = resolveAbsoluteUrl('/api/videos');
  const displayFeedUrl =
    typeof window !== 'undefined' &&
    window.location.hostname.includes('ais-dev-') &&
    suggestedFeedUrl &&
    !suggestedFeedUrl.includes('ais-dev-') &&
    !suggestedFeedUrl.includes('localhost')
      ? suggestedFeedUrl
      : browserFeedUrl;

  const isDevPreviewHost =
    typeof window !== 'undefined' && window.location.hostname.includes('ais-dev-');

  const movieOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of libraryVideos) {
      if (!map.has(v.movieId)) {
        map.set(v.movieId, v.movieTitle);
      }
    }
    return Array.from(map.entries()).map(([id, title]) => ({ id, title }));
  }, [libraryVideos]);

  const filteredVideos = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = libraryVideos.filter((v) => {
      if (movieFilter !== 'all' && v.movieId !== movieFilter) return false;
      if (ratioFilter !== 'all' && v.aspectRatio !== ratioFilter) return false;
      if (categoryFilter !== 'all' && v.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        v.title.toLowerCase().includes(q) ||
        v.summary.toLowerCase().includes(q) ||
        v.movieTitle.toLowerCase().includes(q) ||
        (v.transcriptSnippet?.toLowerCase().includes(q) ?? false)
      );
    });

    if (sortBy === 'score') {
      return [...list].sort((a, b) => b.score - a.score);
    }
    if (sortBy === 'chronological') {
      return [...list].sort((a, b) => a.startSeconds - b.startSeconds);
    }
    const extractJobTs = (jobId: string, fallbackIso: string): number => {
      const match = /^job_(\d+)/.exec(jobId);
      if (match) {
        const ts = Number(match[1]);
        if (Number.isFinite(ts)) return ts;
      }
      return new Date(fallbackIso).getTime();
    };

    return [...list].sort((a, b) => {
      if (a.jobId === b.jobId) {
        return a.startSeconds - b.startSeconds;
      }
      const jobTimeDiff = extractJobTs(b.jobId, b.createdAt) - extractJobTs(a.jobId, a.createdAt);
      if (jobTimeDiff !== 0) return jobTimeDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [libraryVideos, movieFilter, ratioFilter, categoryFilter, sortBy, search]);

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTarget(key);
      setTimeout(() => {
        setCopiedTarget((curr) => (curr === key ? null : curr));
      }, 2000);
    } catch {
      // Clipboard blocked
    }
  };

  const handleSaveIntegration = async (override?: Partial<IntegrationSettings> & { regenerateKey?: boolean }) => {
    setSavingSettings(true);
    setSettingsNotice(null);
    try {
      const payload = { ...settings, ...override };
      const res = await fetch(apiUrl('/api/integration'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Failed to save integration settings.');
      const data = (await res.json()) as { settings: IntegrationSettings };
      setSettings(data.settings);
      setSettingsNotice('Integration settings saved.');
      setTimeout(() => setSettingsNotice(null), 2500);
    } catch (err) {
      setSettingsNotice(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleTestFeed = async () => {
    setTestingFeed(true);
    setFeedTestResult(null);
    try {
      const headers: Record<string, string> = {};
      if (settings.authEnabled && settings.apiKey) {
        headers.Authorization = `Bearer ${settings.apiKey}`;
      }
      const res = await fetch(apiUrl('/api/videos?limit=3'), { headers });
      const data = await res.json();
      setFeedTestResult(JSON.stringify(data, null, 2));
    } catch (err) {
      setFeedTestResult(
        JSON.stringify({ error: err instanceof Error ? err.message : 'Feed test failed' }, null, 2)
      );
    } finally {
      setTestingFeed(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(filteredVideos.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visibleVideos = filteredVideos.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Saved Video Library
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-1 tabular-nums">
            <span className="text-slate-200 font-medium">
              {libraryVideos.length.toLocaleString()} saved clips
            </span>
            <span aria-hidden="true">·</span>
            <span>{formatBytes(libraryTotalBytes)} total</span>
            <span aria-hidden="true">·</span>
            <span>Auto-saved after every render & live in feed</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => void onRefreshLibrary()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium text-slate-200 border border-slate-700 bg-[#111622] rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Refresh</span>
          </button>

          {activeJob && activeJob.stats.completed > 0 && (
            <a
              href={apiUrl(`/api/jobs/${activeJob.id}/download-zip`)}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
            >
              <Archive className="h-4 w-4" />
              <span>Download Current Batch (.zip)</span>
            </a>
          )}
        </div>
      </div>

      {/* External Video Tool Integration (TikTok AutoPilot Feed URL) */}
      <section className="rounded-xl border border-slate-800 bg-[#111622] p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-amber-400 shrink-0" />
              <h2 className="text-base font-semibold text-slate-100">
                External Tool Video Feed URL (TikTok / AutoPilot Integration)
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Paste this GET JSON URL into your TikTok publisher tool under{' '}
              <span className="text-slate-200 font-medium">Other Tool Video Feed URL (GET JSON)</span>{' '}
              so it automatically fetches every saved clip and caption from this library.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleTestFeed()}
              disabled={testingFeed}
              className="px-3.5 py-2 text-xs font-medium text-slate-200 border border-slate-700 bg-[#0B0E14] rounded-lg hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap"
            >
              {testingFeed ? 'Testing...' : 'Test Feed JSON'}
            </button>
            <button
              type="button"
              onClick={() => setShowAdvancedAuth((prev) => !prev)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 border border-slate-700 bg-[#0B0E14] rounded-lg hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap"
            >
              <KeyRound className="h-3.5 w-3.5 text-amber-400" />
              <span>{showAdvancedAuth ? 'Hide Auth & Webhook' : 'Auth & Webhook'}</span>
            </button>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
          <input
            type="text"
            readOnly
            value={displayFeedUrl}
            onClick={(e) => (e.target as HTMLInputElement).select()}
            aria-label="External Video Feed URL"
            className="flex-1 rounded-lg border border-slate-700 bg-[#0B0E14] px-3.5 py-2.5 text-xs font-mono text-amber-300 focus:outline-none focus:border-amber-500"
          />
          <button
            type="button"
            onClick={() => void copyText('feedUrl', displayFeedUrl)}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedTarget === 'feedUrl' ? (
              <>
                <Check className="h-3.5 w-3.5" />
                <span>Copied Feed URL</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>Copy Feed URL</span>
              </>
            )}
          </button>
        </div>

        <div className="text-xs text-slate-400 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            Status:{' '}
            <strong className="text-slate-200">
              {settings.feedEnabled ? 'Active' : 'Paused'}
            </strong>
          </span>
          <span>
            Auth:{' '}
            <strong className="text-slate-200">
              {settings.authEnabled && settings.apiKey
                ? 'Required (Bearer Token)'
                : 'Open (No Token Needed — leave Auth Token blank)'}
            </strong>
          </span>
          {isDevPreviewHost && (
            <span className="text-amber-300/90">
              Tip: If your other app cannot access an authenticated dev preview URL, use your{' '}
              Shared/Published app URL or Hostinger domain + <code className="font-mono">/api/videos</code>.
            </span>
          )}
        </div>

        {showAdvancedAuth && (
          <div className="pt-4 border-t border-slate-800/80 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.feedEnabled}
                    onChange={(e) => setSettings((s) => ({ ...s, feedEnabled: e.target.checked }))}
                    className="h-4 w-4 rounded border-slate-700 bg-[#0B0E14] accent-amber-500"
                  />
                  <span>Enable External GET /api/videos Feed</span>
                </label>

                <label className="flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.authEnabled}
                    onChange={(e) => setSettings((s) => ({ ...s, authEnabled: e.target.checked }))}
                    className="h-4 w-4 rounded border-slate-700 bg-[#0B0E14] accent-amber-500"
                  />
                  <span>Require Bearer Token / API Key (Optional)</span>
                </label>

                {settings.authEnabled && (
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="text"
                      value={settings.apiKey}
                      onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
                      placeholder="Secret API key or click Generate"
                      className="flex-1 rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-amber-500"
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveIntegration({ authEnabled: true, regenerateKey: true })}
                      className="px-3 py-1.5 text-xs font-medium text-slate-200 border border-slate-700 bg-[#0B0E14] rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                    >
                      Generate Key
                    </button>
                    {settings.apiKey && (
                      <button
                        type="button"
                        onClick={() => void copyText('bearer', `Bearer ${settings.apiKey}`)}
                        className="px-3 py-1.5 text-xs font-medium text-amber-300 border border-slate-700 bg-[#0B0E14] rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                      >
                        {copiedTarget === 'bearer' ? 'Copied' : 'Copy Bearer'}
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <label htmlFor="push-webhook-url" className="block text-xs font-medium text-slate-300">
                  Optional Auto-Push Webhook URL (for Push Webhook tab)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="push-webhook-url"
                    type="url"
                    value={settings.webhookUrl}
                    onChange={(e) => setSettings((s) => ({ ...s, webhookUrl: e.target.value }))}
                    placeholder="https://your-tiktok-app.run.app/api/webhook"
                    className="flex-1 rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-1.5 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-500"
                  />
                  <button
                    type="button"
                    disabled={savingSettings}
                    onClick={() => void handleSaveIntegration()}
                    className="px-4 py-1.5 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  >
                    {savingSettings ? 'Saving...' : 'Save'}
                  </button>
                </div>
                {settingsNotice && (
                  <p className="text-xs text-amber-300">{settingsNotice}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {feedTestResult && (
          <div className="pt-3 border-t border-slate-800/80 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Live GET /api/videos Preview (up to 3 items)</span>
              <button
                type="button"
                onClick={() => setFeedTestResult(null)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                Close
              </button>
            </div>
            <pre className="max-h-56 overflow-auto rounded-lg border border-slate-800 bg-[#0B0E14] p-3 text-[11px] font-mono text-slate-300">
              {feedTestResult}
            </pre>
          </div>
        )}
      </section>

      {/* Filters & Search Toolbar */}
      {libraryVideos.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-[#111622] p-12 text-center space-y-3">
          <Film className="h-8 w-8 text-slate-600 mx-auto" />
          <h2 className="text-lg font-semibold text-slate-100">No saved clips in library yet</h2>
          <p className="text-sm text-slate-400 max-w-md mx-auto">
            Every clip you generate will be saved here automatically and become instantly available at{' '}
            <code className="font-mono text-amber-300">/api/videos</code> for your TikTok tool.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 rounded-xl border border-slate-800 bg-[#111622] p-3">
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setCategoryFilter('all');
                  setPage(1);
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  categoryFilter === 'all'
                    ? 'bg-[#171E2E] text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                All Categories
              </button>
              {(Object.keys(CATEGORY_LABELS) as MomentCategory[]).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => {
                    setCategoryFilter(cat);
                    setPage(1);
                  }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    categoryFilter === cat
                      ? 'bg-[#171E2E] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <select
                value={movieFilter}
                onChange={(e) => {
                  setMovieFilter(e.target.value);
                  setPage(1);
                }}
                className="rounded-lg border border-slate-800 bg-[#0B0E14] px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500 max-w-[180px]"
                aria-label="Filter by source movie"
              >
                <option value="all">All Movies ({movieOptions.length})</option>
                {movieOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>

              <select
                value={ratioFilter}
                onChange={(e) => {
                  setRatioFilter(e.target.value as 'all' | AspectRatioPreset);
                  setPage(1);
                }}
                className="rounded-lg border border-slate-800 bg-[#0B0E14] px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
                aria-label="Filter by aspect ratio"
              >
                <option value="all">All Ratios</option>
                <option value="9:16">9:16 TikTok/Reels</option>
                <option value="16:9">16:9 YouTube</option>
                <option value="4:5">4:5 Facebook/IG</option>
                <option value="1:1">1:1 Square</option>
                <option value="source">Original</option>
              </select>

              <div className="relative flex-1 sm:w-48">
                <Search className="h-3.5 w-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search saved clips..."
                  className="w-full rounded-lg border border-slate-800 bg-[#0B0E14] pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500"
                />
              </div>

              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'newest' | 'chronological' | 'score')}
                className="rounded-lg border border-slate-800 bg-[#0B0E14] px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
                aria-label="Sort clips"
              >
                <option value="newest">Newest Saved</option>
                <option value="score">Highest AI Score</option>
                <option value="chronological">Chronological</option>
              </select>
            </div>
          </div>

          {/* Clips Grid */}
          {visibleVideos.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-[#111622] py-12 text-center text-sm text-slate-400">
              No saved clips match the active filters.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
              {visibleVideos.map((video) => {
                const thumbFailed = Boolean(brokenThumbs[video.id]);
                const directUrl = resolveAbsoluteUrl(
                  `/api/videos/${encodeURIComponent(video.id)}/stream${
                    settings.authEnabled && settings.apiKey
                      ? `?token=${encodeURIComponent(settings.apiKey)}`
                      : ''
                  }`
                );

                return (
                  <article
                    key={video.id}
                    className="rounded-xl border border-slate-800 bg-[#111622] overflow-hidden flex flex-col justify-between"
                  >
                    <div>
                      <button
                        type="button"
                        onClick={() => onPlayVideo(video)}
                        className="group relative block w-full aspect-video bg-[#0B0E14] overflow-hidden cursor-pointer text-left"
                      >
                        {!thumbFailed ? (
                          <img
                            src={apiUrl(`/api/videos/${encodeURIComponent(video.id)}/thumbnail`)}
                            alt={video.title}
                            referrerPolicy="no-referrer"
                            onError={() =>
                              setBrokenThumbs((prev) => ({ ...prev, [video.id]: true }))
                            }
                            className={`w-full h-full transition-transform duration-300 group-hover:scale-[1.02] ${
                              video.actualHeight &&
                              video.actualWidth &&
                              video.actualHeight > video.actualWidth
                                ? 'object-contain bg-black'
                                : 'object-cover'
                            }`}
                          />
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-slate-900 to-slate-950 text-slate-500">
                            <Film className="h-7 w-7 mb-1.5" />
                            <span className="text-xs font-mono">{video.filename}</span>
                          </div>
                        )}

                        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent" />

                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-500 text-slate-950 shadow-lg">
                            <Play className="h-5 w-5 fill-current ml-0.5" />
                          </div>
                        </div>

                        <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between text-[11px] font-mono text-slate-200 tabular-nums">
                          <span>
                            {formatTimecode(video.startSeconds)} – {formatTimecode(video.endSeconds)}
                          </span>
                          <span>{Math.round(video.durationSeconds)}s</span>
                        </div>
                      </button>

                      <div className="p-4 space-y-2">
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400 tabular-nums">
                          <span className="text-amber-400 font-medium truncate max-w-[140px]">
                            {video.movieTitle}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{CATEGORY_LABELS[video.category]}</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {video.actualWidth && video.actualHeight
                              ? `${video.actualWidth}×${video.actualHeight}`
                              : video.aspectRatio}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{formatBytes(video.fileSizeBytes)}</span>
                        </div>

                        <h3 className="text-sm font-semibold text-slate-100 line-clamp-1">
                          {video.title}
                        </h3>

                        <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
                          {video.summary}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-slate-800/80 bg-[#0E121B]">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onPlayVideo(video)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-200 border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
                        >
                          <Play className="h-3.5 w-3.5" />
                          <span>Play</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void copyText(video.id, directUrl)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-200 border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
                          title="Copy direct MP4 URL"
                        >
                          {copiedTarget === video.id ? (
                            <Check className="h-3.5 w-3.5 text-amber-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                          <span>{copiedTarget === video.id ? 'Copied' : 'URL'}</span>
                        </button>

                        <button
                          type="button"
                          disabled={deletingId === video.id}
                          onClick={async () => {
                            setDeletingId(video.id);
                            try {
                              await onDeleteVideo(video.id);
                            } finally {
                              setDeletingId(null);
                            }
                          }}
                          className="p-1.5 text-slate-400 hover:text-red-400 border border-slate-800 rounded-lg hover:border-red-900/60 transition-colors cursor-pointer disabled:opacity-40"
                          aria-label={`Delete ${video.title}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      <a
                        href={apiUrl(`/api/videos/${encodeURIComponent(video.id)}/download`)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors"
                      >
                        <Download className="h-3.5 w-3.5" />
                        <span>MP4</span>
                      </a>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-[#111622] px-5 py-3 text-xs text-slate-400">
              <span className="tabular-nums">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, filteredVideos.length)} of{' '}
                {filteredVideos.length.toLocaleString()} clips
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
                >
                  Previous
                </button>
                <span className="font-mono tabular-nums">
                  {safePage} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

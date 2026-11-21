import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
  Link2,
  Lock,
  Play,
  PlugZap,
  Power,
  RefreshCw,
  RotateCcw,
  Send,
  Timer,
  Trash2,
  Unlock,
} from 'lucide-react';
import { YoutubeCookiesSection } from './YoutubeCookiesSection';
import type {
  AspectRatioPreset,
  ExternalFeedVideo,
  FramingMode,
  MovieMetadata,
  QualityTier,
  WatchFetchResult,
  WatchPingResult,
  WatchSourceConfig,
  WatchStatusResponse,
} from '../types/clipper';
import { apiUrl } from '../utils/api';
import { ASPECT_RATIO_INFO, formatDurationLabel } from '../utils/format';

interface AutoSyncStageProps {
  movies: MovieMetadata[];
  onOpenQueueForJob: (jobId: string) => void;
  onOpenLibrary: () => void;
  onRefreshWorkspace: () => Promise<void>;
}

const DEFAULT_CONFIG: WatchSourceConfig = {
  enabled: true,
  locked: true,
  switchLocked: false,
  eventsUrl:
    'https://ais-dev-56ixy72nruomf4qatiuyoi-391293911007.asia-southeast1.run.app/api/watch/events',
  authHeaderName: 'Authorization',
  authToken: '',
  autoClip: true,
  aspectRatio: '9:16',
  framingMode: 'fit_blur',
  clipDurationSeconds: 60,
  quantityMode: 'max',
  requestedClipCount: 22,
  qualityTier: '720p',
  analysisMode: 'fast',
  workerConcurrency: 3,
};

function stateLabel(state: WatchStatusResponse['state']): string {
  switch (state) {
    case 'connected_sse':
      return 'Live SSE Stream Connected';
    case 'polling_json':
      return 'JSON Feed Polling Active';
    case 'connecting':
      return 'Connecting...';
    case 'auth_blocked':
      return 'Session Login / Auth Required';
    case 'error':
      return 'Connection Error';
    case 'disabled':
    default:
      return 'Paused';
  }
}

export const AutoSyncStage: React.FC<AutoSyncStageProps> = ({
  movies,
  onOpenQueueForJob,
  onOpenLibrary,
  onRefreshWorkspace,
}) => {
  const [status, setStatus] = useState<WatchStatusResponse | null>(null);
  const [draft, setDraft] = useState<WatchSourceConfig>(DEFAULT_CONFIG);
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [fetchingVideos, setFetchingVideos] = useState(false);
  const [fetchedVideos, setFetchedVideos] = useState<ExternalFeedVideo[]>([]);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [pingResult, setPingResult] = useState<WatchPingResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmUnlock, setConfirmUnlock] = useState(false);
  const [togglingLock, setTogglingLock] = useState(false);
  const [togglingSwitch, setTogglingSwitch] = useState(false);
  const [clearingItems, setClearingItems] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const isLocked = Boolean(draft.locked);
  const isSwitchOn = Boolean(status?.config.enabled ?? draft.enabled);
  const isSwitchLocked = Boolean(status?.config.switchLocked ?? draft.switchLocked);

  const [manualUrl, setManualUrl] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [selectedMovieId, setSelectedMovieId] = useState<string>(movies[0]?.id ?? '');
  const [submittingIngest, setSubmittingIngest] = useState(false);

  const fetchStatus = useCallback(async (syncDraft = false) => {
    try {
      const res = await fetch(apiUrl('/api/watch/status'));
      if (!res.ok) return;
      const data = (await res.json()) as WatchStatusResponse;
      setStatus(data);
      if (data.lastPing) {
        setPingResult((prev) => prev ?? data.lastPing ?? null);
      }
      if (syncDraft) {
        setDraft(data.config);
      } else {
        setDraft((prev) => ({
          ...prev,
          enabled: data.config.enabled,
          switchLocked: data.config.switchLocked,
          locked: data.config.locked,
        }));
      }
    } catch {
      // Ignore transient error
    }
  }, []);

  useEffect(() => {
    void fetchStatus(true);
    const timer = setInterval(() => {
      void fetchStatus(false);
    }, 2500);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  useEffect(() => {
    if (!status?.breakEndsAt) return;
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [status?.breakEndsAt]);

  useEffect(() => {
    if (!selectedMovieId && movies.length > 0) {
      setSelectedMovieId(movies[0].id);
    }
  }, [movies, selectedMovieId]);

  const handleSaveConfig = async (override?: Partial<WatchSourceConfig>) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const nextPayload = { ...draft, ...override };
      const res = await fetch(apiUrl('/api/watch/config'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextPayload),
      });
      const data = (await res.json()) as WatchStatusResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save Auto-Watch settings.');
      }
      setStatus(data);
      setDraft(data.config);
      setNotice('Auto-Watch connection and TikTok 1-Min clipping rules saved.');
      setTimeout(() => setNotice(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Auto-Watch config');
    } finally {
      setSaving(false);
    }
  };

  const handleSetLocked = async (nextLocked: boolean) => {
    setTogglingLock(true);
    setError(null);
    setNotice(null);
    try {
      const payload = nextLocked ? { ...draft, locked: true } : { locked: false };
      const res = await fetch(apiUrl('/api/watch/config'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as WatchStatusResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update lock state.');
      }
      setStatus(data);
      setDraft(data.config);
      setConfirmUnlock(false);
      setNotice(
        nextLocked
          ? 'Connection & clipping settings are now locked.'
          : 'Settings unlocked for editing. Lock again when done.'
      );
      setTimeout(() => setNotice(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change lock status.');
    } finally {
      setTogglingLock(false);
    }
  };

  const handleSwitchAction = async (patch: { enabled?: boolean; switchLocked?: boolean }) => {
    setTogglingSwitch(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(apiUrl('/api/watch/switch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = (await res.json()) as WatchStatusResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update Master Switch.');
      }
      setStatus(data);
      setDraft(data.config);
      if (typeof patch.enabled === 'boolean') {
        setNotice(
          patch.enabled
            ? 'Auto-Runner Switch ON — crawling every 5s and processing videos 1-by-1.'
            : 'Auto-Runner Switch OFF — all crawling, imports, and clipping stopped.'
        );
      } else if (typeof patch.switchLocked === 'boolean') {
        setNotice(
          patch.switchLocked
            ? 'Switch Locked — tool will keep running continuously.'
            : 'Switch Unlocked — you can turn the tool ON or OFF anytime.'
        );
      }
      setTimeout(() => setNotice(null), 3500);
      void onRefreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update switch state.');
    } finally {
      setTogglingSwitch(false);
    }
  };

  const handleClearVideos = async () => {
    setClearingItems(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(apiUrl('/api/watch/clear'), { method: 'POST' });
      const data = (await res.json()) as WatchStatusResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to clear detected videos.');
      }
      setStatus(data);
      setNotice('All detected videos and completed batch artifacts cleared.');
      setTimeout(() => setNotice(null), 3000);
      void onRefreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear detected videos.');
    } finally {
      setClearingItems(false);
    }
  };

  const handlePing = async () => {
    setPinging(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(apiUrl('/api/watch/ping'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventsUrl: draft.eventsUrl,
          authHeaderName: draft.authHeaderName,
          authToken: draft.authToken,
        }),
      });
      const data = (await res.json()) as { ping?: WatchPingResult; error?: string };
      if (!res.ok || !data.ping) {
        throw new Error(data.error || 'Ping check failed.');
      }
      setPingResult(data.ping);
      if (data.ping.resolvedUrl && data.ping.resolvedUrl !== draft.eventsUrl) {
        setDraft((d) => ({ ...d, eventsUrl: data.ping!.resolvedUrl! }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to ping external endpoint.');
    } finally {
      setPinging(false);
    }
  };

  const handleFetchVideos = async () => {
    setFetchingVideos(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(apiUrl('/api/watch/fetch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventsUrl: draft.eventsUrl,
          authHeaderName: draft.authHeaderName,
          authToken: draft.authToken,
        }),
      });
      const data = (await res.json()) as Partial<WatchFetchResult> & { error?: string };
      if (!res.ok || !data.ping) {
        throw new Error(data.error || 'Failed to fetch available videos from external tool.');
      }
      setPingResult(data.ping);
      if (data.ping.resolvedUrl && data.ping.resolvedUrl !== draft.eventsUrl) {
        setDraft((d) => ({ ...d, eventsUrl: data.ping!.resolvedUrl! }));
      }
      const list = Array.isArray(data.videos) ? data.videos : [];
      setFetchedVideos(list);
      if (data.ping.ok && list.length === 0) {
        setNotice(
          data.ping.state === 'connected_sse'
            ? 'Live SSE stream connected. Click Connect to listen for videos emitted in real time.'
            : 'Connected to external feed, but 0 videos are listed right now.'
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch videos from external tool.');
    } finally {
      setFetchingVideos(false);
    }
  };

  const handleDownloadFetchedVideo = async (vid: ExternalFeedVideo) => {
    setDownloadingKey(vid.sourceKey);
    setError(null);
    setNotice(null);
    try {
      if (!isLocked) {
        await fetch(apiUrl('/api/watch/config'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        });
      }
      const res = await fetch(apiUrl('/api/watch/ingest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: vid.videoUrl,
          fallbackUrls: vid.fallbackUrls,
          title: vid.title,
          force: true,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to queue video download.');
      }
      setFetchedVideos((prev) =>
        prev.map((item) =>
          item.sourceKey === vid.sourceKey ? { ...item, alreadyProcessed: true } : item
        )
      );
      setNotice(`Queued "${vid.title}" in 1-by-1 download & TikTok 1-Min clipping pipeline.`);
      await fetchStatus(false);
      void onRefreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download video from external tool');
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleDownloadAllFetched = async () => {
    const targets = fetchedVideos.filter((v) => !v.alreadyProcessed);
    const listToQueue = targets.length > 0 ? targets : fetchedVideos;
    if (listToQueue.length === 0) return;

    setDownloadingKey('__ALL__');
    setError(null);
    setNotice(null);
    try {
      if (!isLocked) {
        await fetch(apiUrl('/api/watch/config'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        });
      }
      const res = await fetch(apiUrl('/api/watch/ingest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          force: true,
          videos: listToQueue.map((v) => ({
            url: v.videoUrl,
            fallbackUrls: v.fallbackUrls,
            title: v.title,
          })),
        }),
      });
      const data = (await res.json()) as { queuedCount?: number; error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to queue batch download.');
      }
      setFetchedVideos((prev) => prev.map((v) => ({ ...v, alreadyProcessed: true })));
      setNotice(
        `Queued ${data.queuedCount ?? listToQueue.length} video(s) for download & TikTok 1-Min clipping.`
      );
      await fetchStatus(false);
      void onRefreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue videos for download');
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleRetryItem = async (itemId: string) => {
    setRetryingId(itemId);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(apiUrl(`/api/watch/retry/${encodeURIComponent(itemId)}`), {
        method: 'POST',
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to retry download.');
      }
      setNotice('Re-queued video in 1-by-1 pipeline using fresh stream sources.');
      await fetchStatus(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry item.');
    } finally {
      setRetryingId(null);
    }
  };

  const handleRetryAllFailed = async () => {
    setRetryingId('__ALL__');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(apiUrl('/api/watch/retry-failed'), { method: 'POST' });
      const data = (await res.json()) as { queuedCount?: number; error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to retry failed items.');
      }
      setNotice(`Re-queued ${data.queuedCount ?? 0} failed video(s) for 1-by-1 processing.`);
      await fetchStatus(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry failed items.');
    } finally {
      setRetryingId(null);
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(apiUrl('/api/watch/connect'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, enabled: true }),
      });
      const data = (await res.json()) as (WatchStatusResponse & {
        ping?: WatchPingResult;
        error?: string;
      });
      if (!res.ok) {
        throw new Error(data.error || 'Failed to connect.');
      }
      setStatus(data);
      setDraft(data.config);
      if (data.ping) {
        setPingResult(data.ping);
      }
      if (data.ping?.ok) {
        setNotice('Connected! API key verified and live listener active.');
        setTimeout(() => setNotice(null), 4000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect external video source');
    } finally {
      setConnecting(false);
    }
  };

  const handleCheckNow = async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/watch/check-now'), { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as WatchStatusResponse;
        setStatus(data);
      }
    } catch {
      setError('Could not reach backend watcher.');
    } finally {
      setChecking(false);
    }
  };

  const handleIngestUrl = async () => {
    if (!manualUrl.trim()) return;
    setSubmittingIngest(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(apiUrl('/api/watch/ingest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: manualUrl.trim(),
          title: manualTitle.trim() || undefined,
          force: true,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; queuedCount?: number; error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to trigger auto-clip ingest.');
      }
      setManualUrl('');
      setManualTitle('');
      setNotice('Video queued for download and automatic TikTok 1-Min Part clipping.');
      await fetchStatus(false);
      void onRefreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue video URL');
    } finally {
      setSubmittingIngest(false);
    }
  };

  const handleAutoClipMovie = async () => {
    if (!selectedMovieId) return;
    setSubmittingIngest(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(apiUrl('/api/watch/ingest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ movieId: selectedMovieId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start TikTok auto-clip.');
      }
      setNotice('Started automatic 1-Min TikTok Max-Parts clipping on selected movie.');
      await fetchStatus(false);
      void onRefreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clip movie');
    } finally {
      setSubmittingIngest(false);
    }
  };

  const copyValue = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 2000);
    } catch {
      // Clipboard blocked
    }
  };

  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:3000';
  const ingestEndpointUrl =
    status?.ingestUrl && /^https?:\/\//i.test(status.ingestUrl)
      ? status.ingestUrl
      : `${origin}/api/watch/ingest`;
  const feedEndpointUrl =
    status?.feedUrl && /^https?:\/\//i.test(status.feedUrl)
      ? status.feedUrl
      : `${origin}/api/videos`;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            External Detector Auto-Sync & TikTok Auto-Clip
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Automatically detects videos from your external Watch Events tool, saves them, cuts{' '}
            <strong className="text-slate-200 font-medium">1-minute TikTok (9:16)</strong> maximum parts with{' '}
            <strong className="text-slate-200 font-medium">Part 1, Part 2, Part 3...</strong> titles, and publishes them to the Clip Library feed.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void handleCheckNow()}
          disabled={checking}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 bg-[#111622] rounded-lg hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
          <span>Reconnect Now</span>
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-900/70 bg-red-950/30 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {notice && (
        <div className="rounded-lg border border-amber-800/70 bg-amber-950/25 px-4 py-3 text-sm text-amber-200">
          {notice}
        </div>
      )}

      {/* Master Power Switch & Switch Lock */}
      <section
        className={`rounded-xl border p-5 transition-colors ${
          isSwitchOn
            ? 'border-emerald-800/60 bg-[#111622]'
            : 'border-red-900/60 bg-[#111622]'
        }`}
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <Power
                className={`h-4 w-4 shrink-0 ${
                  isSwitchOn ? 'text-emerald-400' : 'text-red-400'
                }`}
              />
              <h2 className="text-base font-semibold text-slate-100">
                Auto-Runner Master Switch
              </h2>
              <span
                className={`px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide rounded ${
                  isSwitchOn
                    ? 'bg-emerald-950/70 text-emerald-300 border border-emerald-800/60'
                    : 'bg-red-950/60 text-red-300 border border-red-900/60'
                }`}
              >
                {isSwitchOn ? 'ON · Crawling Every 5s' : 'OFF · Stopped'}
              </span>
              {isSwitchLocked && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded bg-amber-950/50 text-amber-300 border border-amber-800/60">
                  <Lock className="h-3 w-3" />
                  Switch Locked
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              {isSwitchOn
                ? 'Tool is running: crawling target URL every 5s, importing & clipping 1 video at a time, holding ready clips for a 5-min break, then auto-removing clips + video and moving to the next video.'
                : 'Tool is completely stopped. Turn the Switch ON to start 5-second crawling and 1-by-1 auto-clipping.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              disabled={togglingSwitch || isSwitchLocked}
              onClick={() => void handleSwitchAction({ enabled: !isSwitchOn })}
              title={
                isSwitchLocked
                  ? 'Unlock Switch first before turning ON/OFF'
                  : isSwitchOn
                    ? 'Turn Switch OFF to stop tool'
                    : 'Turn Switch ON to start tool'
              }
              className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ${
                isSwitchOn
                  ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
                  : 'bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700'
              }`}
            >
              <Power className="h-3.5 w-3.5" />
              <span>
                {togglingSwitch
                  ? 'Updating...'
                  : isSwitchOn
                    ? 'Switch: ON'
                    : 'Switch: OFF'}
              </span>
            </button>

            <button
              type="button"
              disabled={togglingSwitch}
              onClick={() => void handleSwitchAction({ switchLocked: !isSwitchLocked })}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap ${
                isSwitchLocked
                  ? 'border-amber-700/70 bg-amber-950/30 text-amber-300 hover:bg-amber-950/50'
                  : 'border-slate-700 bg-[#0B0E14] text-slate-200 hover:bg-slate-800'
              }`}
            >
              {isSwitchLocked ? (
                <>
                  <Unlock className="h-3.5 w-3.5" />
                  <span>Unlock Switch</span>
                </>
              ) : (
                <>
                  <Lock className="h-3.5 w-3.5 text-amber-400" />
                  <span>Lock Switch</span>
                </>
              )}
            </button>
          </div>
        </div>

        {status?.breakActive && status.breakEndsAt && (() => {
          const remainingSec = Math.max(0, Math.ceil((Date.parse(status.breakEndsAt) - nowMs) / 1000));
          const mins = Math.floor(remainingSec / 60);
          const secs = remainingSec % 60;
          const clock = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
          return (
            <div className="mt-4 rounded-lg border border-amber-800/70 bg-amber-950/25 px-4 py-3 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Timer className="h-4 w-4 text-amber-400 shrink-0" />
                <span>
                  <strong>5-Min Download Break Active:</strong> Clips for{' '}
                  <strong className="text-slate-100">{status.breakItemTitle || 'current video'}</strong>{' '}
                  are live in Library & <code className="font-mono">/api/videos</code>. Auto-removing clips & source video and starting next video in:
                </span>
              </div>
              <span className="font-mono text-sm font-bold text-amber-300 tabular-nums">
                {clock}
              </span>
            </div>
          );
        })()}
      </section>

      {/* 1. External Watch Events Source */}
      <section className="rounded-xl border border-slate-800 bg-[#111622] p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-amber-400 shrink-0" />
              <h2 className="text-base font-semibold text-slate-100">
                Watch Events Source (Pull SSE / JSON)
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-1 tabular-nums">
              <span>
                Status:{' '}
                <strong className="text-slate-200">
                  {status ? stateLabel(status.state) : 'Loading...'}
                </strong>
              </span>
              {status?.lastCheckedAt && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Last check {new Date(status.lastCheckedAt).toLocaleTimeString()}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <label
              className={`flex items-center gap-2 text-xs ${
                isLocked ? 'text-slate-400 cursor-not-allowed' : 'text-slate-200 cursor-pointer'
              }`}
            >
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={isLocked}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setDraft((d) => ({ ...d, enabled }));
                  void handleSaveConfig({ enabled });
                }}
                className="h-4 w-4 rounded border-slate-700 bg-[#0B0E14] accent-amber-500 disabled:opacity-60"
              />
              <span>Auto-Watch Listener Enabled</span>
            </label>

            {isLocked ? (
              confirmUnlock ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={togglingLock}
                    onClick={() => void handleSetLocked(false)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-slate-950 bg-amber-500 rounded-md hover:bg-amber-400 cursor-pointer"
                  >
                    <Unlock className="h-3 w-3" />
                    <span>Confirm Unlock</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmUnlock(false)}
                    className="px-2.5 py-1.5 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmUnlock(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-300 border border-emerald-800/70 bg-emerald-950/30 rounded-lg hover:bg-emerald-950/50 transition-colors cursor-pointer"
                  title="Settings are locked to prevent accidental edits"
                >
                  <Lock className="h-3.5 w-3.5" />
                  <span>Locked</span>
                </button>
              )
            ) : (
              <button
                type="button"
                disabled={togglingLock}
                onClick={() => void handleSetLocked(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-300 border border-amber-700/70 bg-amber-950/25 rounded-lg hover:bg-amber-950/45 transition-colors cursor-pointer"
              >
                <Lock className="h-3.5 w-3.5" />
                <span>{togglingLock ? 'Locking...' : 'Lock Section'}</span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-5 space-y-1">
            <label htmlFor="watch-events-url" className="block text-xs font-medium text-slate-300">
              External Video Source URL (SSE / JSON Feed)
            </label>
            <input
              id="watch-events-url"
              type="url"
              value={draft.eventsUrl}
              readOnly={isLocked}
              disabled={isLocked}
              onChange={(e) => setDraft((d) => ({ ...d, eventsUrl: e.target.value }))}
              placeholder="https://.../api/watch/events"
              className="w-full rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs font-mono text-amber-300 focus:outline-none focus:border-amber-500 disabled:opacity-75 disabled:cursor-not-allowed"
            />
          </div>

          <div className="lg:col-span-4 space-y-1">
            <label htmlFor="watch-auth-token" className="block text-xs font-medium text-slate-300">
              External Tool API Key
            </label>
            <div className="relative flex items-center">
              <input
                id="watch-auth-token"
                type={showApiKey && !isLocked ? 'text' : 'password'}
                value={draft.authToken}
                readOnly={isLocked}
                disabled={isLocked}
                onChange={(e) => setDraft((d) => ({ ...d, authToken: e.target.value }))}
                placeholder="Paste external tool API key"
                autoComplete="off"
                className="w-full rounded-lg border border-slate-700 bg-[#0B0E14] pl-3 pr-9 py-2 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-500 disabled:opacity-75 disabled:cursor-not-allowed"
              />
              {!isLocked && (
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                  className="absolute right-2 p-1 text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              )}
            </div>
          </div>

          <div className="lg:col-span-3 space-y-1">
            <label htmlFor="watch-auth-header" className="block text-xs font-medium text-slate-300">
              Auth Header
            </label>
            <input
              id="watch-auth-header"
              type="text"
              value={draft.authHeaderName}
              readOnly={isLocked}
              disabled={isLocked}
              onChange={(e) => setDraft((d) => ({ ...d, authHeaderName: e.target.value }))}
              placeholder="Authorization"
              className="w-full rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-amber-500 disabled:opacity-75 disabled:cursor-not-allowed"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] text-slate-400">
            {isLocked ? (
              <span>
                Settings locked (read-only). Videos download strictly 1-by-1: download → clip all parts → next video.
              </span>
            ) : (
              <span>
                Sent automatically on both watch checks and video downloads (
                <code className="font-mono text-slate-300">Bearer</code> +{' '}
                <code className="font-mono text-slate-300">x-api-key</code> when header is{' '}
                <code className="font-mono text-slate-300">Authorization</code>).
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={pinging || !draft.eventsUrl.trim()}
              onClick={() => void handlePing()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-100 border border-slate-700 bg-[#0B0E14] rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Activity className={`h-3.5 w-3.5 text-amber-400 ${pinging ? 'animate-pulse' : ''}`} />
              <span>{pinging ? 'Pinging...' : 'Ping API Key'}</span>
            </button>

            <button
              type="button"
              disabled={fetchingVideos || !draft.eventsUrl.trim()}
              onClick={() => void handleFetchVideos()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-100 border border-slate-700 bg-[#0B0E14] rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Download className={`h-3.5 w-3.5 text-amber-400 ${fetchingVideos ? 'animate-bounce' : ''}`} />
              <span>{fetchingVideos ? 'Fetching...' : 'Fetch Videos'}</span>
            </button>

            <button
              type="button"
              disabled={isLocked || connecting || !draft.eventsUrl.trim()}
              onClick={() => void handleConnect()}
              className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
            >
              {isLocked ? <Lock className="h-3.5 w-3.5" /> : <PlugZap className="h-3.5 w-3.5" />}
              <span>{isLocked ? 'Locked' : connecting ? 'Connecting...' : 'Connect'}</span>
            </button>
          </div>
        </div>

        {fetchedVideos.length > 0 && (
          <div className="rounded-lg border border-slate-800 bg-[#0B0E14] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold text-slate-100">
                Available Videos Found ({fetchedVideos.length})
              </div>
              <button
                type="button"
                disabled={downloadingKey !== null}
                onClick={() => void handleDownloadAllFetched()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 disabled:opacity-50 cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" />
                <span>
                  {downloadingKey === '__ALL__' ? 'Queuing All...' : 'Download & Clip All'}
                </span>
              </button>
            </div>
            <div className="divide-y divide-slate-800/80 max-h-60 overflow-y-auto">
              {fetchedVideos.map((vid) => (
                <div
                  key={vid.sourceKey}
                  className="py-2.5 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-slate-100 truncate">{vid.title}</div>
                    <div className="text-[11px] font-mono text-slate-500 truncate">
                      {vid.videoUrl}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={downloadingKey !== null}
                    onClick={() => void handleDownloadFetchedVideo(vid)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-100 border border-slate-700 bg-[#111622] rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer shrink-0"
                  >
                    <Download className="h-3.5 w-3.5 text-amber-400" />
                    <span>
                      {downloadingKey === vid.sourceKey
                        ? 'Downloading...'
                        : vid.alreadyProcessed
                          ? 'Re-Download'
                          : 'Download & Clip'}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {(pingResult || status?.lastPing) && (() => {
          const activePing = pingResult ?? status?.lastPing;
          if (!activePing) return null;
          return (
            <div
              className={`rounded-lg border px-4 py-3 text-xs flex items-start gap-2.5 leading-relaxed ${
                activePing.ok
                  ? 'border-emerald-800/70 bg-emerald-950/25 text-emerald-200'
                  : 'border-red-900/70 bg-red-950/25 text-red-200'
              }`}
            >
              {activePing.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  <span>{activePing.ok ? 'API Key & Endpoint Verified' : 'Ping Check Failed'}</span>
                  {typeof activePing.httpStatus === 'number' && (
                    <span className="font-mono text-[11px] opacity-85">
                      · HTTP {activePing.httpStatus}
                    </span>
                  )}
                  <span className="font-mono text-[11px] opacity-85 tabular-nums">
                    · {activePing.latencyMs}ms
                  </span>
                  {typeof activePing.detectedVideosCount === 'number' && (
                    <span className="font-mono text-[11px] opacity-85 tabular-nums">
                      · {activePing.detectedVideosCount} video{activePing.detectedVideosCount === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                <div className="opacity-90">{activePing.message}</div>
              </div>
            </div>
          );
        })()}

        {status?.state === 'auth_blocked' && !pingResult && (
          <div className="rounded-lg border border-amber-800/60 bg-amber-950/25 px-4 py-3 text-xs text-amber-200 flex items-start gap-2.5 leading-relaxed">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-medium">{status.statusMessage}</div>
              <div className="text-amber-300/90">
                To connect automatically: enter your Published/Shared App URL (or Hostinger URL) and
                API key above, click <strong>Ping API Key</strong> to verify, then click{' '}
                <strong>Connect</strong> — or push directly to FrameSplit’s webhook URL below.
              </div>
            </div>
          </div>
        )}

        {status && status.state !== 'auth_blocked' && !pingResult && (
          <div className="text-xs text-slate-400">{status.statusMessage}</div>
        )}

        {/* 2. TikTok 1-Min Maximum Parts Auto-Clip Settings */}
        <div className="pt-4 border-t border-slate-800/80 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Automatic Clip Rules (Applied When Video Is Detected)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Pre-configured for TikTok 9:16 vertical · 1-minute clips · Maximum non-overlapping parts (e.g. 22 min = 22 clips titled Part 1..22).
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="space-y-1">
              <label htmlFor="auto-ratio" className="block text-xs text-slate-400">
                Aspect Ratio
              </label>
              <select
                id="auto-ratio"
                value={draft.aspectRatio}
                disabled={isLocked}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, aspectRatio: e.target.value as AspectRatioPreset }))
                }
                className="w-full rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500 disabled:opacity-75 disabled:cursor-not-allowed"
              >
                {ASPECT_RATIO_INFO.map((item) => (
                  <option key={item.ratio} value={item.ratio}>
                    {item.label} ({item.platforms})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="auto-framing" className="block text-xs text-slate-400">
                Video Framing
              </label>
              <select
                id="auto-framing"
                value={draft.framingMode}
                disabled={isLocked}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, framingMode: e.target.value as FramingMode }))
                }
                className="w-full rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500 disabled:opacity-75 disabled:cursor-not-allowed"
              >
                <option value="fit_blur">Blur Background (Full Video)</option>
                <option value="crop_fill">Center Crop Fill</option>
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="auto-duration" className="block text-xs text-slate-400">
                Clip Duration (Seconds)
              </label>
              <input
                id="auto-duration"
                type="number"
                min={5}
                max={600}
                value={draft.clipDurationSeconds}
                readOnly={isLocked}
                disabled={isLocked}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    clipDurationSeconds: Math.max(5, Number(e.target.value) || 60),
                  }))
                }
                className="w-full rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-amber-500 disabled:opacity-75 disabled:cursor-not-allowed"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="auto-qty-mode" className="block text-xs text-slate-400">
                Clip Count Mode
              </label>
              <select
                id="auto-qty-mode"
                value={draft.quantityMode}
                disabled={isLocked}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    quantityMode: e.target.value as 'max' | 'preset',
                  }))
                }
                className="w-full rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500 disabled:opacity-75 disabled:cursor-not-allowed"
              >
                <option value="max">Maximum Clips (1 per Min)</option>
                <option value="preset">Fixed Count ({draft.requestedClipCount})</option>
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="auto-quality" className="block text-xs text-slate-400">
                Export Quality
              </label>
              <select
                id="auto-quality"
                value={draft.qualityTier}
                disabled={isLocked}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, qualityTier: e.target.value as QualityTier }))
                }
                className="w-full rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500 disabled:opacity-75 disabled:cursor-not-allowed"
              >
                <option value="720p">720p HD (Fastest)</option>
                <option value="1080p">1080p Full HD</option>
                <option value="source">Original Resolution</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="text-xs text-slate-400 tabular-nums">
              Example: A 22-minute movie at{' '}
              <strong className="text-slate-200">
                {formatDurationLabel(draft.clipDurationSeconds)}
              </strong>{' '}
              per clip creates <strong className="text-amber-300">22 clips</strong> in{' '}
              <strong className="text-slate-200">{draft.aspectRatio}</strong> named{' '}
              <span className="text-slate-200">Part 1, Part 2 ... Part 22</span>.
            </div>

            <button
              type="button"
              disabled={isLocked || saving}
              onClick={() => void handleSaveConfig()}
              className="px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 bg-[#0B0E14] rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
            >
              {isLocked ? 'Rules Locked' : saving ? 'Saving...' : 'Save Clip Rules'}
            </button>
          </div>
        </div>
      </section>

      {/* 3. Two-Way Integration Endpoints & Manual Trigger */}
      <section className="rounded-xl border border-slate-800 bg-[#111622] p-6 space-y-5">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-1.5">
            <div className="text-xs font-semibold text-slate-200">
              Inbound Auto-Clip Webhook (Detector Tool → FrameSplit)
            </div>
            <p className="text-[11px] text-slate-400">
              POST <code className="font-mono">{'{ "url": "...", "title": "..." }'}</code> here from
              your detector app to trigger download + TikTok 1-min max-parts clipping immediately.
            </p>
            <div className="flex items-center gap-2 pt-1">
              <input
                type="text"
                readOnly
                value={ingestEndpointUrl}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="flex-1 rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs font-mono text-slate-200"
              />
              <button
                type="button"
                onClick={() => void copyValue('ingest', ingestEndpointUrl)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 border border-slate-700 bg-[#0B0E14] rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
              >
                {copiedKey === 'ingest' ? (
                  <Check className="h-3.5 w-3.5 text-amber-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                <span>{copiedKey === 'ingest' ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-semibold text-slate-200">
              Outbound Ready Clips Feed (FrameSplit → TikTok Publisher Tool)
            </div>
            <p className="text-[11px] text-slate-400">
              As each Part 1, Part 2, ... finishes rendering, it is saved in Clip Library and served
              in sequential order at this GET JSON URL.
            </p>
            <div className="flex items-center gap-2 pt-1">
              <input
                type="text"
                readOnly
                value={feedEndpointUrl}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="flex-1 rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs font-mono text-amber-300"
              />
              <button
                type="button"
                onClick={() => void copyValue('feed', feedEndpointUrl)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 border border-slate-700 bg-[#0B0E14] rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
              >
                {copiedKey === 'feed' ? (
                  <Check className="h-3.5 w-3.5 text-amber-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                <span>{copiedKey === 'feed' ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Manual Test / Existing Movie Quick Trigger */}
        <div className="pt-4 border-t border-slate-800/80 grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-2">
            <div className="text-xs font-semibold text-slate-200">
              Send Video Link Directly to Auto-Clip Pipeline
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="url"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="https://.../video.mp4 or YouTube link"
                className="flex-1 rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-500"
              />
              <input
                type="text"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder="Video title (optional)"
                className="sm:w-40 rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-500"
              />
              <button
                type="button"
                disabled={!manualUrl.trim() || submittingIngest}
                onClick={() => void handleIngestUrl()}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Send className="h-3.5 w-3.5" />
                <span>Auto-Clip</span>
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-semibold text-slate-200">
              Run 1-Min TikTok Max-Parts Preset on Saved Source Movie
            </div>
            <div className="flex items-center gap-2">
              <select
                value={selectedMovieId}
                onChange={(e) => setSelectedMovieId(e.target.value)}
                disabled={movies.length === 0}
                className="flex-1 rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
              >
                {movies.length === 0 ? (
                  <option value="">No saved source movies yet</option>
                ) : (
                  movies.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title} ({Math.round(m.durationSeconds / 60)}m {Math.round(m.durationSeconds % 60)}s)
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                disabled={!selectedMovieId || submittingIngest}
                onClick={() => void handleAutoClipMovie()}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 bg-[#0B0E14] rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Play className="h-3.5 w-3.5 text-amber-400" />
                <span>Clip Now</span>
              </button>
            </div>
          </div>
        </div>

        <YoutubeCookiesSection />
      </section>

      {/* 4. Detected & Auto-Clipped History */}
      <section className="rounded-xl border border-slate-800 bg-[#111622] p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-100">
            Detected Videos & Auto-Clip Activity
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            {status && status.items.length > 0 && (
              <button
                type="button"
                disabled={clearingItems}
                onClick={() => void handleClearVideos()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-300 border border-red-900/70 bg-red-950/25 rounded-lg hover:bg-red-950/45 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>{clearingItems ? 'Removing...' : 'Remove All Videos'}</span>
              </button>
            )}
            {status?.items.some((i) => i.status === 'failed') && (
              <button
                type="button"
                disabled={retryingId !== null}
                onClick={() => void handleRetryAllFailed()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-300 border border-amber-700/70 bg-amber-950/20 rounded-lg hover:bg-amber-950/40 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className={`h-3.5 w-3.5 ${retryingId === '__ALL__' ? 'animate-spin' : ''}`} />
                <span>{retryingId === '__ALL__' ? 'Re-queuing...' : 'Retry All Failed'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onOpenLibrary}
              className="text-xs font-medium text-amber-400 hover:text-amber-300 cursor-pointer whitespace-nowrap"
            >
              Open Saved Clip Library
            </button>
          </div>
        </div>

        {!status || status.items.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400">
            No detected videos yet. When the Master Switch is ON, FrameSplit crawls your target
            source every 5 seconds, processes videos strictly 1-by-1, holds finalized clips for a
            5-minute break, then auto-cleans them and picks up the next video.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/80">
            {status.items.map((item) => (
              <div
                key={item.id}
                className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold text-slate-100 truncate max-w-md">
                      {item.title}
                    </span>
                    <span aria-hidden="true" className="text-slate-600">
                      ·
                    </span>
                    <span
                      className={`font-medium capitalize ${
                        item.status === 'completed'
                          ? 'text-emerald-400'
                          : item.status === 'cleaned'
                            ? 'text-slate-400'
                            : item.status === 'failed'
                              ? 'text-red-400'
                              : 'text-amber-400'
                      }`}
                    >
                      {item.status === 'cleaned' ? 'Removed after 5m break' : item.status}
                    </span>
                    {typeof item.clipsTotal === 'number' && (
                      <>
                        <span aria-hidden="true" className="text-slate-600">
                          ·
                        </span>
                        <span className="font-mono text-slate-300 tabular-nums">
                          {item.clipsCompleted ?? 0}/{item.clipsTotal} parts
                        </span>
                      </>
                    )}
                  </div>
                  <div className="text-xs text-slate-400 break-words">{item.statusMessage}</div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {item.status === 'failed' && (
                    <button
                      type="button"
                      disabled={retryingId !== null}
                      onClick={() => void handleRetryItem(item.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-300 border border-amber-700/70 bg-[#0B0E14] rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                    >
                      <RotateCcw className={`h-3.5 w-3.5 ${retryingId === item.id ? 'animate-spin' : ''}`} />
                      <span>{retryingId === item.id ? 'Retrying...' : 'Retry'}</span>
                    </button>
                  )}
                  {item.jobId && (
                    <button
                      type="button"
                      onClick={() => onOpenQueueForJob(item.jobId!)}
                      className="px-3 py-1.5 text-xs font-medium text-slate-200 border border-slate-700 bg-[#0B0E14] rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                    >
                      View Batch
                    </button>
                  )}
                  {item.status === 'completed' && (
                    <button
                      type="button"
                      onClick={onOpenLibrary}
                      className="px-3 py-1.5 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                    >
                      View Parts
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  computeMaxNonOverlappingClips,
  type BatchConfig,
  type ExternalFeedVideo,
  type MomentCategory,
  type MovieMetadata,
  type WatchConnectionState,
  type WatchDetectedItem,
  type WatchFetchResult,
  type WatchPingResult,
  type WatchSourceConfig,
  type WatchStatusResponse,
} from '../src/types/clipper.ts';
import { cancelImportJob, getImportJob, startUrlImport, subscribeToImport } from './downloader.ts';
import { deleteLibraryVideosForJob } from './library.ts';
import {
  STORAGE_ROOT,
  cancelJob,
  createBatchJob,
  deleteJob,
  getJob,
  getMovie,
  removeMovie,
  subscribeToJob,
} from './queue.ts';

const WATCHER_STATE_PATH = path.join(STORAGE_ROOT, 'watcher.json');
const CRAWL_INTERVAL_MS = 5000;
const POST_CLIP_BREAK_MS = 5 * 60 * 1000;

const ALL_CATEGORIES: MomentCategory[] = [
  'scene',
  'dialogue',
  'action',
  'emotional',
  'comedy',
  'memorable_quote',
  'story_milestone',
  'highlight',
];

const DEFAULT_WATCH_CONFIG: WatchSourceConfig = {
  enabled: true,
  locked: true,
  switchLocked: false,
  eventsUrl:
    process.env.WATCH_EVENTS_URL?.trim() ||
    'https://ais-dev-56ixy72nruomf4qatiuyoi-391293911007.asia-southeast1.run.app/api/watch/events',
  authHeaderName: 'Authorization',
  authToken: process.env.WATCH_AUTH_TOKEN?.trim() || '',
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

export class WatchLockedError extends Error {
  statusCode = 423;
  constructor(message = 'Watch settings are locked. Unlock first before editing.') {
    super(message);
    this.name = 'WatchLockedError';
  }
}

interface PersistedWatcherData {
  config: WatchSourceConfig;
  processedKeys: string[];
  items: WatchDetectedItem[];
}

interface QueuedWatchTask {
  item: WatchDetectedItem;
  existingMovieId?: string;
}

let watchConfig: WatchSourceConfig = { ...DEFAULT_WATCH_CONFIG };
const processedKeys = new Set<string>();
let detectedItems: WatchDetectedItem[] = [];
let connectionState: WatchConnectionState = 'disabled';
let connectionMessage = 'Auto-Watch connector not started yet.';
let lastCheckedAt: string | undefined;
let lastError: string | undefined;
let lastPing: WatchPingResult | undefined;

let loopAbortController: AbortController | null = null;
let loopGeneration = 0;
let persistQueue: Promise<void> = Promise.resolve();
const taskQueue: QueuedWatchTask[] = [];
const discoveredCandidates: ExtractedWatchCandidate[] = [];
let activeTask: QueuedWatchTask | null = null;
let isQueueWorkerRunning = false;
let pollWakeResolver: (() => void) | null = null;
let activeImportJobId: string | null = null;
let activeBatchJobId: string | null = null;
let activeRunAborted = false;
let breakTimer: NodeJS.Timeout | null = null;
let breakEndsAt: string | null = null;
let breakItemId: string | null = null;
let breakItemTitle: string | null = null;

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

async function persistWatcherState(): Promise<void> {
  const snapshot: PersistedWatcherData = {
    config: watchConfig,
    processedKeys: Array.from(processedKeys).slice(-500),
    items: detectedItems.slice(0, 60),
  };
  const next = persistQueue
    .catch(() => undefined)
    .then(async () => {
      await atomicWriteJson(WATCHER_STATE_PATH, snapshot);
    });
  persistQueue = next;
  await next;
}

function upsertDetectedItem(item: WatchDetectedItem): void {
  const idx = detectedItems.findIndex((i) => i.id === item.id);
  if (idx >= 0) {
    detectedItems[idx] = item;
  } else {
    detectedItems.unshift(item);
    if (detectedItems.length > 60) {
      detectedItems = detectedItems.slice(0, 60);
    }
  }
  void persistWatcherState();
}

function isPipelineBusy(): boolean {
  return Boolean(
    !watchConfig.enabled ||
      activeTask ||
      taskQueue.length > 0 ||
      isQueueWorkerRunning ||
      breakTimer ||
      breakEndsAt
  );
}

function clearBreakTimerOnly(): void {
  if (breakTimer) {
    clearTimeout(breakTimer);
    breakTimer = null;
  }
  breakEndsAt = null;
  breakItemId = null;
  breakItemTitle = null;
}

function wakeWatcherPoll(): void {
  if (pollWakeResolver) {
    const wake = pollWakeResolver;
    pollWakeResolver = null;
    wake();
  }
}

async function cleanupWatchItemMedia(item: WatchDetectedItem): Promise<void> {
  const jobId = item.jobId;
  const movieId = item.movieId;

  if (jobId || movieId) {
    await deleteLibraryVideosForJob(jobId, movieId).catch(() => 0);
  }
  if (jobId) {
    await deleteJob(jobId).catch(() => false);
  }
  if (movieId) {
    await removeMovie(movieId).catch(() => false);
  }

  item.status = 'cleaned';
  item.cleanupAt = undefined;
  item.cleanedAt = new Date().toISOString();
  item.jobId = undefined;
  item.movieId = undefined;
  item.statusMessage =
    '5-min break finished: clips & source video removed. Ready for next video.';
  item.updatedAt = new Date().toISOString();
  upsertDetectedItem(item);
}

function schedulePostClipBreak(item: WatchDetectedItem): void {
  clearBreakTimerOnly();
  if (!watchConfig.enabled) return;

  const targetIso =
    item.cleanupAt && Number.isFinite(Date.parse(item.cleanupAt))
      ? item.cleanupAt
      : new Date(Date.now() + POST_CLIP_BREAK_MS).toISOString();
  item.cleanupAt = targetIso;
  const remainingMs = Math.max(0, Date.parse(targetIso) - Date.now());
  const readyTimeLabel = new Date(targetIso).toLocaleTimeString();

  item.statusMessage = `Clips ready in Library & /api/videos (${item.clipsCompleted ?? 0} parts). 5-min break active — auto-removing clips & source video at ${readyTimeLabel}, then starting next video.`;
  item.updatedAt = new Date().toISOString();
  upsertDetectedItem(item);

  breakEndsAt = targetIso;
  breakItemId = item.id;
  breakItemTitle = item.title;

  breakTimer = setTimeout(() => {
    breakTimer = null;
    breakEndsAt = null;
    breakItemId = null;
    breakItemTitle = null;

    if (!watchConfig.enabled) return;
    void cleanupWatchItemMedia(item).then(() => {
      if (watchConfig.enabled) {
        tryStartNextDiscoveredCandidate();
        wakeWatcherPoll();
      }
    });
  }, remainingMs);
}

async function stopActiveRuns(reasonMessage: string): Promise<void> {
  activeRunAborted = true;
  clearBreakTimerOnly();
  taskQueue.length = 0;
  discoveredCandidates.length = 0;

  if (activeImportJobId) {
    cancelImportJob(activeImportJobId);
    activeImportJobId = null;
  }
  if (activeBatchJobId) {
    await cancelJob(activeBatchJobId).catch(() => undefined);
    activeBatchJobId = null;
  }

  const now = new Date().toISOString();
  let changed = false;
  for (const item of detectedItems) {
    if (item.status === 'queued' || item.status === 'downloading' || item.status === 'clipping') {
      item.status = 'failed';
      item.error = reasonMessage;
      item.statusMessage = reasonMessage;
      item.updatedAt = now;
      changed = true;
    }
  }
  if (changed) {
    await persistWatcherState();
  }
}

export async function initializeWatcher(): Promise<void> {
  let pendingBreakItem: WatchDetectedItem | undefined;
  try {
    const raw = await fs.readFile(WATCHER_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedWatcherData>;
    if (parsed.config && typeof parsed.config === 'object') {
      const cfgRecord = parsed.config as unknown as Record<string, unknown>;
      if (typeof cfgRecord.eventsUrl === 'string') {
        watchConfig = {
          ...DEFAULT_WATCH_CONFIG,
          ...parsed.config,
          locked: typeof cfgRecord.locked === 'boolean' ? cfgRecord.locked : true,
          switchLocked: typeof cfgRecord.switchLocked === 'boolean' ? cfgRecord.switchLocked : false,
        };
      } else {
        // Migrate legacy draft schema cleanly
        watchConfig = {
          ...DEFAULT_WATCH_CONFIG,
          locked: true,
          switchLocked: false,
          eventsUrl:
            typeof cfgRecord.watchUrl === 'string' && cfgRecord.watchUrl.trim()
              ? cfgRecord.watchUrl.trim()
              : DEFAULT_WATCH_CONFIG.eventsUrl,
        };
        await persistWatcherState();
      }
    }
    if (Array.isArray(parsed.processedKeys)) {
      for (const k of parsed.processedKeys) {
        if (typeof k === 'string' && k) processedKeys.add(k);
      }
    }
    if (Array.isArray(parsed.items)) {
      detectedItems = parsed.items.slice(0, 60).map((it) => {
        if (it.status === 'downloading' || it.status === 'queued') {
          return {
            ...it,
            status: 'failed',
            statusMessage: 'Interrupted by server restart.',
          };
        }
        if (it.status === 'clipping') {
          const job = it.jobId ? getJob(it.jobId) : undefined;
          if (job?.phase === 'completed') {
            return {
              ...it,
              status: 'completed',
              clipsTotal: job.clips.length,
              clipsCompleted: job.stats.completed,
              cleanupAt: it.cleanupAt || new Date(Date.now() + POST_CLIP_BREAK_MS).toISOString(),
              statusMessage: `Ready (${job.stats.completed} clips saved to Video Library).`,
            };
          }
          if (!job) {
            return {
              ...it,
              status: 'failed',
              jobId: undefined,
              statusMessage: 'Interrupted by server restart.',
            };
          }
        }
        return it;
      });
    }

    pendingBreakItem = detectedItems.find(
      (it) => it.status === 'completed' && Boolean(it.cleanupAt)
    );
  } catch {
    // No watcher.json yet; save defaults cleanly
    await persistWatcherState();
  }

  if (watchConfig.enabled && pendingBreakItem) {
    const remaining = Date.parse(pendingBreakItem.cleanupAt!) - Date.now();
    if (remaining <= 0) {
      await cleanupWatchItemMedia(pendingBreakItem);
    } else {
      schedulePostClipBreak(pendingBreakItem);
    }
  }

  restartWatchLoop();
}

export function getWatchStatus(baseUrl?: string): WatchStatusResponse {
  const cleanBase = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
  return {
    config: { ...watchConfig },
    state: connectionState,
    statusMessage: connectionMessage,
    lastCheckedAt,
    lastError,
    lastPing,
    breakActive: Boolean(breakEndsAt),
    breakEndsAt: breakEndsAt ?? undefined,
    breakItemTitle: breakItemTitle ?? undefined,
    crawlIntervalSeconds: Math.round(CRAWL_INTERVAL_MS / 1000),
    items: detectedItems.slice(0, 40),
    ingestUrl: cleanBase ? `${cleanBase}/api/watch/ingest` : '/api/watch/ingest',
    feedUrl: cleanBase ? `${cleanBase}/api/videos` : '/api/videos',
  };
}

export async function setWatchSwitch(
  params: { enabled?: boolean; switchLocked?: boolean },
  baseUrl?: string
): Promise<WatchStatusResponse> {
  if (
    typeof params.enabled === 'boolean' &&
    params.enabled !== watchConfig.enabled &&
    watchConfig.switchLocked
  ) {
    throw new WatchLockedError(
      'Auto-Run Switch is locked. Unlock the Switch first before turning it ON or OFF.'
    );
  }

  const prevEnabled = watchConfig.enabled;
  if (typeof params.switchLocked === 'boolean') {
    watchConfig.switchLocked = params.switchLocked;
  }
  if (typeof params.enabled === 'boolean') {
    watchConfig.enabled = params.enabled;
  }

  await persistWatcherState();

  if (watchConfig.enabled !== prevEnabled) {
    if (!watchConfig.enabled) {
      loopGeneration += 1;
      if (loopAbortController) {
        loopAbortController.abort();
        loopAbortController = null;
      }
      await stopActiveRuns('Stopped: Master Switch turned OFF.');
      connectionState = 'disabled';
      connectionMessage = 'Master Switch is OFF — crawling, importing, and clipping stopped.';
    } else {
      activeRunAborted = false;
      const pendingBreakItem = detectedItems.find(
        (it) => it.status === 'completed' && Boolean(it.cleanupAt)
      );
      if (pendingBreakItem) {
        const remaining = Date.parse(pendingBreakItem.cleanupAt!) - Date.now();
        if (remaining <= 0) {
          await cleanupWatchItemMedia(pendingBreakItem);
        } else {
          schedulePostClipBreak(pendingBreakItem);
        }
      }
      restartWatchLoop();
    }
  }

  return getWatchStatus(baseUrl);
}

export async function clearWatchItems(baseUrl?: string): Promise<WatchStatusResponse> {
  const existingItems = [...detectedItems];
  await stopActiveRuns('Cleared by user.');

  for (const item of existingItems) {
    if (item.jobId || item.movieId) {
      await deleteLibraryVideosForJob(item.jobId, item.movieId).catch(() => 0);
    }
    if (item.jobId) {
      await deleteJob(item.jobId).catch(() => false);
    }
    if (item.movieId) {
      await removeMovie(item.movieId).catch(() => false);
    }
  }

  detectedItems = [];
  processedKeys.clear();
  discoveredCandidates.length = 0;
  await persistWatcherState();

  if (watchConfig.enabled) {
    activeRunAborted = false;
    restartWatchLoop();
  }

  return getWatchStatus(baseUrl);
}

export async function updateWatchConfig(
  patch: Partial<WatchSourceConfig>
): Promise<WatchStatusResponse> {
  if (watchConfig.locked && patch.locked !== false) {
    throw new WatchLockedError(
      'External source settings are locked. Unlock first before making changes.'
    );
  }

  const prevUrl = watchConfig.eventsUrl;
  const prevToken = watchConfig.authToken;
  const prevHeader = watchConfig.authHeaderName;
  const prevEnabled = watchConfig.enabled;

  if (
    typeof patch.enabled === 'boolean' &&
    patch.enabled !== prevEnabled &&
    watchConfig.switchLocked
  ) {
    throw new WatchLockedError(
      'Auto-Run Switch is locked. Unlock the Switch first before changing ON/OFF.'
    );
  }

  watchConfig = {
    ...watchConfig,
    ...patch,
    locked: typeof patch.locked === 'boolean' ? patch.locked : watchConfig.locked,
    switchLocked:
      typeof patch.switchLocked === 'boolean' ? patch.switchLocked : watchConfig.switchLocked,
    eventsUrl:
      typeof patch.eventsUrl === 'string'
        ? patch.eventsUrl.trim()
        : watchConfig.eventsUrl,
    authHeaderName:
      typeof patch.authHeaderName === 'string' && patch.authHeaderName.trim()
        ? patch.authHeaderName.trim()
        : watchConfig.authHeaderName || 'Authorization',
    authToken:
      typeof patch.authToken === 'string' ? patch.authToken.trim() : watchConfig.authToken,
    clipDurationSeconds: Math.max(
      5,
      Math.min(600, Math.round(Number(patch.clipDurationSeconds ?? watchConfig.clipDurationSeconds) || 60))
    ),
    requestedClipCount: Math.max(
      1,
      Math.min(1000, Math.round(Number(patch.requestedClipCount ?? watchConfig.requestedClipCount) || 22))
    ),
    workerConcurrency: Math.max(
      1,
      Math.min(6, Math.round(Number(patch.workerConcurrency ?? watchConfig.workerConcurrency) || 3))
    ),
  };

  await persistWatcherState();

  if (watchConfig.enabled !== prevEnabled) {
    if (!watchConfig.enabled) {
      loopGeneration += 1;
      if (loopAbortController) {
        loopAbortController.abort();
        loopAbortController = null;
      }
      await stopActiveRuns('Stopped: Master Switch turned OFF.');
      connectionState = 'disabled';
      connectionMessage = 'Master Switch is OFF — crawling, importing, and clipping stopped.';
      return getWatchStatus();
    }
    activeRunAborted = false;
  }

  const connectionChanged =
    watchConfig.eventsUrl !== prevUrl ||
    watchConfig.authToken !== prevToken ||
    watchConfig.authHeaderName !== prevHeader ||
    watchConfig.enabled !== prevEnabled;

  if (connectionChanged) {
    restartWatchLoop();
  }
  return getWatchStatus();
}

export function triggerWatchCheckNow(): void {
  restartWatchLoop();
}

interface ExtractedWatchCandidate {
  sourceKey: string;
  videoUrl: string;
  fallbackUrls: string[];
  title: string;
}

function resolveMaybeRelativeUrl(rawUrl: string, baseOrigin?: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const u = baseOrigin ? new URL(trimmed, baseOrigin) : new URL(trimmed);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function isYoutubeOrWebWatchUrl(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtu.be' ||
      host === 'vimeo.com' ||
      host.endsWith('.vimeo.com') ||
      host === 'dailymotion.com' ||
      host.endsWith('.dailymotion.com') ||
      host === 'tiktok.com' ||
      host.endsWith('.tiktok.com')
    );
  } catch {
    return false;
  }
}

function extractYoutubeId(urlStr?: string): string | null {
  if (!urlStr) return null;
  try {
    const u = new URL(urlStr);
    const v = u.searchParams.get('v');
    if (v) return v;
    if (u.hostname.toLowerCase().includes('youtu.be')) {
      const seg = u.pathname.replace(/^\/+/, '').split('/')[0];
      return seg || null;
    }
  } catch {
    // Ignore non-URL strings
  }
  return null;
}

function collectVariantUrls(variantsRaw: unknown, baseOrigin?: string): string[] {
  if (!Array.isArray(variantsRaw)) return [];

  interface VariantBucket {
    rank: number;
    urls: string[];
  }

  const buckets: VariantBucket[] = [];

  for (const entry of variantsRaw) {
    if (!entry || typeof entry !== 'object') continue;
    const v = entry as Record<string, unknown>;
    const id = typeof v.id === 'string' ? v.id.toLowerCase() : '';
    const format = typeof v.format === 'string' ? v.format.toLowerCase() : '';
    const quality = typeof v.quality === 'string' ? v.quality.toLowerCase() : '';

    // Skip audio-only MP3 / M4A variants
    if (id.includes('mp3') || format === 'mp3' || format === 'm4a' || quality.includes('kbps')) {
      continue;
    }

    let rank = 50;
    if (quality.includes('720') || id.includes('720')) rank = 10;
    else if (quality.includes('480') || id.includes('480')) rank = 20;
    else if (quality.includes('360') || id.includes('360')) rank = 25;
    else if (quality.includes('1080') || id.includes('1080')) rank = 30;
    else if (quality.includes('240') || id.includes('240')) rank = 40;

    const urls: string[] = [];
    for (const k of ['downloadUrl', 'download_url', 'streamUrl', 'stream_url', 'previewUrl', 'preview_url', 'url']) {
      const val = v[k];
      if (typeof val === 'string' && val.trim()) {
        const resolved = resolveMaybeRelativeUrl(val, baseOrigin);
        if (resolved) urls.push(resolved);
      }
    }
    if (urls.length > 0) {
      buckets.push({ rank, urls });
    }
  }

  buckets.sort((a, b) => a.rank - b.rank);
  return buckets.flatMap((b) => b.urls);
}

function extractSingleCandidate(
  obj: unknown,
  baseOrigin?: string
): ExtractedWatchCandidate | null {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;

  // Unwrap common nested envelope objects
  if (rec.video && typeof rec.video === 'object') {
    const inner = extractSingleCandidate(rec.video, baseOrigin);
    if (inner) return inner;
  }
  if (rec.payload && typeof rec.payload === 'object') {
    const inner = extractSingleCandidate(rec.payload, baseOrigin);
    if (inner) return inner;
  }
  if (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) {
    const inner = extractSingleCandidate(rec.data, baseOrigin);
    if (inner) return inner;
  }

  const orderedCandidates: string[] = [];
  const pushUnique = (rawUrl: unknown) => {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return;
    const resolved = resolveMaybeRelativeUrl(rawUrl, baseOrigin);
    if (resolved && !orderedCandidates.includes(resolved)) {
      orderedCandidates.push(resolved);
    }
  };

  // 1. Prefer direct/proxy stream URLs from extracted variants (720p -> 480p -> 360p -> 1080p)
  const extractedObj =
    rec.extracted && typeof rec.extracted === 'object'
      ? (rec.extracted as Record<string, unknown>)
      : undefined;
  for (const vu of collectVariantUrls(rec.variants ?? extractedObj?.variants, baseOrigin)) {
    pushUnique(vu);
  }

  // 2. Top-level direct stream / download / proxy URLs (avoid falling back to youtube.com first)
  const directStreamKeys = [
    'streamUrl',
    'stream_url',
    'proxyUrl',
    'proxy_url',
    'downloadUrl',
    'download_url',
    'previewUrl',
    'preview_url',
    'fileUrl',
    'file_url',
    'mediaUrl',
    'media_url',
  ];
  for (const key of directStreamKeys) {
    pushUnique(rec[key]);
  }

  // 3. Generic video / page URLs — partition non-YouTube direct links before fallbackUrls and YouTube watch pages
  const genericUrlKeys = ['videoUrl', 'video_url', 'sourceUrl', 'source_url', 'url', 'src', 'link'];
  const nonYoutubeGeneric: string[] = [];
  const youtubeWatchLinks: string[] = [];
  for (const key of genericUrlKeys) {
    const val = rec[key];
    if (typeof val === 'string' && val.trim()) {
      const resolved = resolveMaybeRelativeUrl(val, baseOrigin);
      if (resolved) {
        if (isYoutubeOrWebWatchUrl(resolved)) {
          youtubeWatchLinks.push(resolved);
        } else {
          nonYoutubeGeneric.push(resolved);
        }
      }
    }
  }
  for (const u of nonYoutubeGeneric) pushUnique(u);

  // 4. Explicit fallbackUrls if caller passed them
  if (Array.isArray(rec.fallbackUrls)) {
    for (const fu of rec.fallbackUrls) {
      pushUnique(fu);
    }
  }

  for (const u of youtubeWatchLinks) pushUnique(u);

  if (orderedCandidates.length === 0) return null;

  // If external event explicitly says it is still extracting/pending and only has a YouTube page link, wait for video:ready
  const itemStatus = typeof rec.status === 'string' ? rec.status.toLowerCase().trim() : '';
  const hasDirectStream = orderedCandidates.some((u) => !isYoutubeOrWebWatchUrl(u));
  if (!hasDirectStream && ['extracting', 'pending', 'processing', 'queued'].includes(itemStatus)) {
    return null;
  }

  const resolvedUrl = orderedCandidates[0];
  const fallbackUrls = orderedCandidates.slice(1);

  const titleKeys = ['title', 'videoTitle', 'video_title', 'name', 'filename', 'caption', 'label'];
  let title = '';
  for (const key of titleKeys) {
    const val = rec[key];
    if (typeof val === 'string' && val.trim()) {
      title = val.trim();
      break;
    }
  }
  if (!title) {
    try {
      const u = new URL(resolvedUrl);
      title = path.basename(u.pathname).replace(/\.[^/.]+$/, '') || 'Detected Video';
    } catch {
      title = 'Detected Video';
    }
  }

  const idVal = rec.id ?? rec.eventId ?? rec.videoId ?? rec.guid;
  const sourceKey =
    typeof idVal === 'string' || typeof idVal === 'number'
      ? String(idVal)
      : resolvedUrl;

  return {
    sourceKey,
    videoUrl: resolvedUrl,
    fallbackUrls,
    title: title.slice(0, 120),
  };
}

export function extractWatchVideosFromPayload(
  payload: unknown,
  baseOrigin?: string
): ExtractedWatchCandidate[] {
  const results: ExtractedWatchCandidate[] = [];
  if (!payload) return results;

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const item = extractSingleCandidate(entry, baseOrigin);
      if (item) results.push(item);
    }
    return results;
  }

  if (typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    const listKeys = ['detections', 'events', 'videos', 'items', 'data', 'results'];
    for (const k of listKeys) {
      if (Array.isArray(rec[k])) {
        for (const entry of rec[k] as unknown[]) {
          const item = extractSingleCandidate(entry, baseOrigin);
          if (item) results.push(item);
        }
        return results;
      }
    }

    const single = extractSingleCandidate(rec, baseOrigin);
    if (single) results.push(single);
  }

  return results;
}

function buildConfiguredHeaders(
  authHeaderName: string,
  authToken: string
): Record<string, string> {
  const token = authToken.trim();
  if (!token) return {};
  const headerName = (authHeaderName || 'Authorization').trim() || 'Authorization';
  const rawKey = token.replace(/^(bearer|basic)\s+/i, '').trim();

  if (headerName.toLowerCase() === 'authorization') {
    const authValue = /^(bearer|basic)\s+/i.test(token) ? token : `Bearer ${token}`;
    return {
      Authorization: authValue,
      'x-api-key': rawKey,
    };
  }

  return {
    [headerName]: token,
  };
}

function buildWatchAuthHeaders(targetUrl: string): Record<string, string> | undefined {
  if (!watchConfig.authToken.trim()) return undefined;
  try {
    const eventsOrigin = watchConfig.eventsUrl ? new URL(watchConfig.eventsUrl).origin : '';
    const targetOrigin = new URL(targetUrl).origin;
    if (eventsOrigin && targetOrigin !== eventsOrigin) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const built = buildConfiguredHeaders(watchConfig.authHeaderName, watchConfig.authToken);
  return Object.keys(built).length > 0 ? built : undefined;
}

async function runAutoClipForMovie(
  item: WatchDetectedItem,
  movie: MovieMetadata
): Promise<void> {
  if (!watchConfig.autoClip) {
    item.status = 'completed';
    item.movieId = movie.id;
    item.statusMessage = 'Saved to Source Movies (auto-clip disabled).';
    item.updatedAt = new Date().toISOString();
    upsertDetectedItem(item);
    return;
  }

  const clipDur = Math.max(2, Math.min(movie.durationSeconds, watchConfig.clipDurationSeconds));
  const requestedCount =
    watchConfig.quantityMode === 'max'
      ? computeMaxNonOverlappingClips(movie.durationSeconds, clipDur)
      : watchConfig.requestedClipCount;

  const batchConfig: BatchConfig = {
    quantityMode: watchConfig.quantityMode,
    requestedClipCount: requestedCount,
    clipDurationSeconds: clipDur,
    qualityTier: watchConfig.qualityTier,
    analysisMode: watchConfig.analysisMode,
    aspectRatio: watchConfig.aspectRatio,
    framingMode: watchConfig.framingMode,
    playbackSpeed: 1,
    focusCategories: ALL_CATEGORIES,
    preventOverlap: true,
    allowOverlapWhenExceeding: false,
    workerConcurrency: watchConfig.workerConcurrency,
    maxRetries: 2,
  };

  const job = await createBatchJob(movie, batchConfig);
  activeBatchJobId = job.id;
  item.status = 'clipping';
  item.movieId = movie.id;
  item.jobId = job.id;
  item.clipsTotal = requestedCount;
  item.clipsCompleted = 0;
  item.statusMessage = `Auto-clipping ${requestedCount} × ${clipDur}s (${watchConfig.aspectRatio}) parts...`;
  item.updatedAt = new Date().toISOString();
  upsertDetectedItem(item);

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (finalJob: ReturnType<typeof getJob>) => {
      if (settled) return;
      settled = true;
      unsub();
      clearInterval(timer);
      if (activeBatchJobId === job.id) {
        activeBatchJobId = null;
      }
      if (!finalJob) {
        resolve();
        return;
      }
      item.clipsTotal = finalJob.clips.length || requestedCount;
      item.clipsCompleted = finalJob.stats.completed;
      item.updatedAt = new Date().toISOString();
      if (finalJob.phase === 'completed') {
        item.status = 'completed';
        if (finalJob.stats.completed > 0 && watchConfig.enabled) {
          item.cleanupAt = new Date(Date.now() + POST_CLIP_BREAK_MS).toISOString();
          item.statusMessage = `Ready: ${finalJob.stats.completed} TikTok parts in Clip Library & /api/videos. 5-min break started before auto-cleanup.`;
        } else {
          item.statusMessage = `Ready: ${finalJob.stats.completed} TikTok parts saved to Clip Library & /api/videos feed.`;
        }
      } else {
        item.status = 'failed';
        item.error = finalJob.error || finalJob.statusMessage;
        item.statusMessage = `Batch ${finalJob.phase}: ${item.error}`;
      }
      upsertDetectedItem(item);
      resolve();
    };

    const unsub = subscribeToJob(job.id, (updated) => {
      item.clipsTotal = updated.clips.length || requestedCount;
      item.clipsCompleted = updated.stats.completed;
      item.statusMessage = `Rendering ${updated.stats.completed}/${item.clipsTotal} parts (${watchConfig.aspectRatio})...`;
      item.updatedAt = new Date().toISOString();
      upsertDetectedItem(item);
      if (
        updated.phase === 'completed' ||
        updated.phase === 'failed' ||
        updated.phase === 'cancelled'
      ) {
        finish(updated);
      }
    });

    const timer = setInterval(() => {
      const current = getJob(job.id);
      if (
        current &&
        (current.phase === 'completed' ||
          current.phase === 'failed' ||
          current.phase === 'cancelled')
      ) {
        finish(current);
      }
    }, 2000);
  });

  if (item.status === 'completed' && (item.clipsCompleted ?? 0) > 0 && watchConfig.enabled) {
    schedulePostClipBreak(item);
  }
}

async function downloadMovieFromCandidateUrl(
  item: WatchDetectedItem,
  candidateUrl: string
): Promise<MovieMetadata> {
  if (activeRunAborted || !watchConfig.enabled) {
    throw new Error('Stopped: Master Switch turned OFF.');
  }
  const extraHeaders = buildWatchAuthHeaders(candidateUrl);
  const importJob = await startUrlImport({
    url: candidateUrl,
    preferredQuality: 'best_hd',
    customTitle: item.title,
    extraHeaders,
  });
  activeImportJobId = importJob.id;

  return new Promise<MovieMetadata>((resolve, reject) => {
    let settled = false;
    const handleUpdate = (updated: NonNullable<ReturnType<typeof getImportJob>>) => {
      if (settled) return;
      if (updated.status === 'completed' && updated.movie) {
        settled = true;
        unsub();
        clearInterval(timer);
        if (activeImportJobId === importJob.id) activeImportJobId = null;
        resolve(updated.movie);
      } else if (updated.status === 'failed' || updated.status === 'cancelled') {
        settled = true;
        unsub();
        clearInterval(timer);
        if (activeImportJobId === importJob.id) activeImportJobId = null;
        reject(new Error(updated.error || updated.statusMessage));
      } else {
        item.statusMessage = updated.statusMessage;
        item.updatedAt = new Date().toISOString();
        upsertDetectedItem(item);
      }
    };

    const unsub = subscribeToImport(importJob.id, handleUpdate);
    const timer = setInterval(() => {
      const current = getImportJob(importJob.id);
      if (current) handleUpdate(current);
    }, 1500);
  });
}

async function processSingleWatchItem(item: WatchDetectedItem, existingMovieId?: string): Promise<void> {
  try {
    if (activeRunAborted || !watchConfig.enabled) {
      throw new Error('Stopped: Master Switch turned OFF.');
    }
    let movie: MovieMetadata | undefined;
    if (existingMovieId) {
      movie = getMovie(existingMovieId);
      if (!movie) {
        throw new Error('Specified movieId not found.');
      }
    } else {
      item.status = 'downloading';
      item.error = undefined;
      item.statusMessage = 'Downloading detected video from external source...';
      item.updatedAt = new Date().toISOString();
      upsertDetectedItem(item);

      const candidateUrls = [item.videoUrl, ...(item.fallbackUrls ?? [])].filter(
        (u, idx, arr) => Boolean(u) && arr.indexOf(u) === idx
      );

      let lastErr: Error | null = null;
      for (let idx = 0; idx < candidateUrls.length; idx += 1) {
        if (activeRunAborted || !watchConfig.enabled) {
          throw new Error('Stopped: Master Switch turned OFF.');
        }
        const candidateUrl = candidateUrls[idx];
        if (idx > 0) {
          item.statusMessage = `Trying alternate stream (${idx + 1}/${candidateUrls.length})...`;
          item.updatedAt = new Date().toISOString();
          upsertDetectedItem(item);
        }
        try {
          movie = await downloadMovieFromCandidateUrl(item, candidateUrl);
          item.videoUrl = candidateUrl;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error('Download failed');
          if (activeRunAborted || !watchConfig.enabled) break;
        }
      }

      if (!movie) {
        throw lastErr ?? new Error('Failed to download video from all candidate stream URLs.');
      }
    }

    if (activeRunAborted || !watchConfig.enabled) {
      throw new Error('Stopped: Master Switch turned OFF.');
    }
    await runAutoClipForMovie(item, movie);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Auto-Watch processing failed';
    item.status = 'failed';
    item.error = msg;
    item.statusMessage = msg.startsWith('Stopped:') ? msg : `Failed: ${msg}`;
    item.updatedAt = new Date().toISOString();
    upsertDetectedItem(item);
  }
}

function recordDiscoveredCandidates(candidates: ExtractedWatchCandidate[]): void {
  for (const c of candidates) {
    if (processedKeys.has(c.sourceKey)) continue;
    const exists = discoveredCandidates.some((d) => d.sourceKey === c.sourceKey);
    if (!exists) {
      discoveredCandidates.push(c);
    }
  }
}

function tryStartNextDiscoveredCandidate(): WatchDetectedItem | null {
  if (isPipelineBusy() || activeRunAborted || !watchConfig.enabled) {
    return null;
  }
  while (discoveredCandidates.length > 0) {
    const next = discoveredCandidates.shift()!;
    if (processedKeys.has(next.sourceKey)) continue;
    return enqueueCandidate(next, false);
  }
  return null;
}

async function startSequentialQueueWorker(): Promise<void> {
  if (isQueueWorkerRunning) return;
  isQueueWorkerRunning = true;
  try {
    while (taskQueue.length > 0) {
      if (activeRunAborted || !watchConfig.enabled || breakTimer || breakEndsAt) {
        break;
      }
      const next = taskQueue.shift()!;
      activeTask = next;
      await processSingleWatchItem(next.item, next.existingMovieId);
      activeTask = null;

      // If clips completed and entered the 5-min break, stop pulling next until break completes
      if (breakTimer || breakEndsAt || !watchConfig.enabled || activeRunAborted) {
        break;
      }
    }
  } finally {
    isQueueWorkerRunning = false;
    activeTask = null;
    if (watchConfig.enabled && !activeRunAborted && !breakTimer && !breakEndsAt) {
      if (taskQueue.length > 0) {
        void startSequentialQueueWorker();
      } else {
        tryStartNextDiscoveredCandidate();
      }
      wakeWatcherPoll();
    }
  }
}

function enqueueCandidate(candidate: ExtractedWatchCandidate, force = false): WatchDetectedItem | null {
  if (!force && processedKeys.has(candidate.sourceKey)) {
    return null;
  }
  processedKeys.add(candidate.sourceKey);

  const busy = Boolean(activeTask || taskQueue.length > 0 || isQueueWorkerRunning || breakTimer || breakEndsAt);
  const now = new Date().toISOString();
  const item: WatchDetectedItem = {
    id: `watch_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    sourceKey: candidate.sourceKey,
    videoUrl: candidate.videoUrl,
    fallbackUrls: candidate.fallbackUrls.length > 0 ? candidate.fallbackUrls : undefined,
    title: candidate.title,
    status: 'queued',
    statusMessage: busy
      ? 'Waiting in 1-by-1 queue (will download after current video & 5-min break finish)...'
      : 'Detected video. Starting download & TikTok 1-Min clipping...',
    detectedAt: now,
    updatedAt: now,
  };
  upsertDetectedItem(item);

  taskQueue.push({ item });
  if (!breakTimer && !breakEndsAt && watchConfig.enabled) {
    void startSequentialQueueWorker();
  }

  return item;
}

export async function retryWatchItem(itemId: string): Promise<WatchDetectedItem> {
  const existing = detectedItems.find((i) => i.id === itemId);
  if (!existing) {
    throw new Error('Watch activity item not found.');
  }
  if (existing.status === 'downloading' || existing.status === 'clipping' || existing.status === 'queued') {
    return existing;
  }

  // Refresh candidate stream URLs from the latest external feed if available
  if (watchConfig.eventsUrl) {
    try {
      const feed = await fetchExternalVideos();
      const targetYtId =
        extractYoutubeId(existing.videoUrl) ||
        existing.fallbackUrls?.map(extractYoutubeId).find(Boolean) ||
        existing.sourceKey.split('::')[0];
      const matched = feed.videos.find(
        (v) =>
          (targetYtId && (v.sourceKey === targetYtId || v.fallbackUrls?.some((u) => extractYoutubeId(u) === targetYtId))) ||
          v.title.trim().toLowerCase() === existing.title.trim().toLowerCase()
      );
      if (matched) {
        existing.videoUrl = matched.videoUrl;
        existing.fallbackUrls = matched.fallbackUrls;
      }
    } catch {
      // Proceed with existing stored URLs if feed refresh fails
    }
  }

  const busy = Boolean(activeTask || taskQueue.length > 0 || isQueueWorkerRunning);
  existing.status = 'queued';
  existing.error = undefined;
  existing.statusMessage = busy
    ? 'Re-queued in 1-by-1 pipeline (waiting for current video to finish)...'
    : 'Retrying download & TikTok 1-Min clipping...';
  existing.updatedAt = new Date().toISOString();
  upsertDetectedItem(existing);

  taskQueue.push({ item: existing, existingMovieId: existing.movieId && getMovie(existing.movieId) ? existing.movieId : undefined });
  void startSequentialQueueWorker();

  return existing;
}

export async function retryFailedWatchItems(): Promise<WatchDetectedItem[]> {
  const failedItems = detectedItems.filter((i) => i.status === 'failed');
  if (failedItems.length === 0) return [];

  let latestVideos: ExternalFeedVideo[] = [];
  if (watchConfig.eventsUrl) {
    try {
      const feed = await fetchExternalVideos();
      latestVideos = feed.videos;
    } catch {
      // Proceed with existing URLs
    }
  }

  const queued: WatchDetectedItem[] = [];
  for (const item of failedItems.reverse()) {
    const targetYtId =
      extractYoutubeId(item.videoUrl) ||
      item.fallbackUrls?.map(extractYoutubeId).find(Boolean) ||
      item.sourceKey.split('::')[0];
    const matched = latestVideos.find(
      (v) =>
        (targetYtId && (v.sourceKey === targetYtId || v.fallbackUrls?.some((u) => extractYoutubeId(u) === targetYtId))) ||
        v.title.trim().toLowerCase() === item.title.trim().toLowerCase()
    );
    if (matched) {
      item.videoUrl = matched.videoUrl;
      item.fallbackUrls = matched.fallbackUrls;
    }
    const busy = Boolean(activeTask || taskQueue.length > 0 || isQueueWorkerRunning);
    item.status = 'queued';
    item.error = undefined;
    item.statusMessage = busy
      ? 'Re-queued in 1-by-1 pipeline (waiting for current video to finish)...'
      : 'Retrying download & TikTok 1-Min clipping...';
    item.updatedAt = new Date().toISOString();
    upsertDetectedItem(item);
    taskQueue.push({ item, existingMovieId: item.movieId && getMovie(item.movieId) ? item.movieId : undefined });
    queued.push(item);
  }

  void startSequentialQueueWorker();
  return queued;
}

export async function ingestWatchPayload(params: {
  url?: string;
  videoUrl?: string;
  fallbackUrls?: string[];
  title?: string;
  movieId?: string;
  force?: boolean;
  rawPayload?: unknown;
}): Promise<WatchDetectedItem[]> {
  if (params.movieId) {
    const movie = getMovie(params.movieId);
    if (!movie) {
      throw new Error('Movie not found.');
    }
    const busy = Boolean(activeTask || taskQueue.length > 0 || isQueueWorkerRunning);
    const now = new Date().toISOString();
    const item: WatchDetectedItem = {
      id: `watch_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      sourceKey: `movie::${movie.id}::${Date.now()}`,
      videoUrl: movie.sourceUrl || `local://${movie.id}`,
      title: params.title?.trim() || movie.title,
      status: 'queued',
      statusMessage: busy
        ? 'Waiting in 1-by-1 queue (will clip after current video finishes)...'
        : 'Queued movie for TikTok 1-Min Auto-Clipping...',
      movieId: movie.id,
      detectedAt: now,
      updatedAt: now,
    };
    upsertDetectedItem(item);
    taskQueue.push({ item, existingMovieId: movie.id });
    void startSequentialQueueWorker();
    return [item];
  }

  const created: WatchDetectedItem[] = [];
  const directUrl = (params.videoUrl || params.url || '').trim();
  if (directUrl) {
    const candidate = extractSingleCandidate({
      url: directUrl,
      fallbackUrls: params.fallbackUrls,
      title: params.title,
      id: params.force ? `${directUrl}::${Date.now()}` : undefined,
    });
    if (!candidate) {
      throw new Error('Please provide a valid http:// or https:// video URL.');
    }
    const item = enqueueCandidate(candidate, Boolean(params.force));
    if (item) created.push(item);
    return created;
  }

  if (params.rawPayload) {
    const list = extractWatchVideosFromPayload(params.rawPayload);
    for (const c of list) {
      const item = enqueueCandidate(c, Boolean(params.force));
      if (item) created.push(item);
    }
  }

  return created;
}

async function fetchWithRedirectCheck(
  urlStr: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<{ response?: Response; authBlockedReason?: string }> {
  let currentUrl = urlStr;
  for (let hop = 0; hop < 4; hop += 1) {
    const resp = await fetch(currentUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal,
    });

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location') || '';
      if (
        loc.includes('__cookie_check') ||
        loc.includes('accounts.google.com') ||
        loc.includes('ServiceLogin')
      ) {
        return {
          authBlockedReason:
            'External AI Studio dev preview URL (ais-dev-*) requires browser session login cookies. Switch to that app’s Published/Shared URL, Hostinger URL, or configure it to push to FrameSplit’s /api/watch/ingest webhook.',
        };
      }
      if (!loc) break;
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }

    return { response: resp };
  }
  throw new Error('Too many HTTP redirects from watch events endpoint.');
}

function restartWatchLoop(): void {
  loopGeneration += 1;
  if (loopAbortController) {
    loopAbortController.abort();
    loopAbortController = null;
  }

  if (!watchConfig.enabled || !watchConfig.eventsUrl) {
    connectionState = 'disabled';
    connectionMessage = !watchConfig.enabled
      ? 'Master Switch is OFF — crawling, importing, and clipping stopped.'
      : 'Auto-Watch URL not configured.';
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(watchConfig.eventsUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Watch URL must start with http:// or https://');
    }
  } catch (err) {
    connectionState = 'error';
    lastError = err instanceof Error ? err.message : 'Invalid Watch Events URL';
    connectionMessage = lastError;
    return;
  }

  const myGeneration = loopGeneration;
  const controller = new AbortController();
  loopAbortController = controller;

  void runWatchLoop(myGeneration, parsed, controller.signal);
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitCrawlInterval(signal: AbortSignal, ms = CRAWL_INTERVAL_MS): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let done = false;
    const finishWait = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finishWait);
      if (pollWakeResolver === finishWait) {
        pollWakeResolver = null;
      }
      resolve();
    };
    const timer = setTimeout(finishWait, ms);
    signal.addEventListener('abort', finishWait, { once: true });
    pollWakeResolver = finishWait;
  });
}

async function runWatchLoop(
  generation: number,
  parsedUrl: URL,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted && generation === loopGeneration && watchConfig.enabled) {
    if (connectionState !== 'connected_sse' && connectionState !== 'polling_json') {
      connectionState = 'connecting';
      connectionMessage = `Connecting to ${parsedUrl.hostname}${parsedUrl.pathname}...`;
    }
    lastCheckedAt = new Date().toISOString();

    try {
      const headers: Record<string, string> = {
        Accept: 'text/event-stream, application/json',
        'Cache-Control': 'no-cache',
        ...buildConfiguredHeaders(watchConfig.authHeaderName, watchConfig.authToken),
      };

      const { response, authBlockedReason } = await fetchWithRedirectCheck(
        parsedUrl.toString(),
        headers,
        signal
      );

      if (authBlockedReason) {
        connectionState = 'auth_blocked';
        lastError = authBlockedReason;
        connectionMessage = authBlockedReason;
        await sleepWithSignal(10000, signal);
        continue;
      }

      if (!response) {
        throw new Error('No response from Watch Events endpoint.');
      }

      if (response.status === 401 || response.status === 403) {
        connectionState = 'auth_blocked';
        lastError = `HTTP ${response.status} from ${parsedUrl.hostname}. Check Auth Header / Bearer Token.`;
        connectionMessage = lastError;
        await sleepWithSignal(10000, signal);
        continue;
      }

      if (!response.ok || !response.body) {
        throw new Error(`Watch source returned HTTP ${response.status} ${response.statusText}`);
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();

      if (contentType.includes('text/html')) {
        const htmlSnippet = (await response.text().catch(() => '')).slice(0, 1000);
        if (htmlSnippet.includes('__cookie_check') || htmlSnippet.includes('aistudio')) {
          connectionState = 'auth_blocked';
          lastError =
            'External AI Studio dev preview URL returned a login cookie page. Use its Published/Shared URL or Hostinger domain, or push videos to /api/watch/ingest.';
          connectionMessage = lastError;
          await sleepWithSignal(15000, signal);
          continue;
        }
        throw new Error('Watch endpoint returned HTML instead of SSE stream or JSON.');
      }

      if (contentType.includes('text/event-stream')) {
        connectionState = 'connected_sse';
        lastError = undefined;
        connectionMessage = `Live SSE + 5s Crawl active on ${parsedUrl.hostname}. Watching for new videos...`;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const sseOpenedAt = Date.now();
        let timedOutForCrawl = false;

        while (!signal.aborted && generation === loopGeneration && watchConfig.enabled) {
          const remainingBudget = Math.max(200, CRAWL_INTERVAL_MS - (Date.now() - sseOpenedAt));
          const readResult = await Promise.race([
            reader.read().then((r) => ({ kind: 'data' as const, r })),
            sleepWithSignal(remainingBudget, signal).then(() => ({ kind: 'timeout' as const })),
          ]);

          if (readResult.kind === 'timeout') {
            lastCheckedAt = new Date().toISOString();
            tryStartNextDiscoveredCandidate();
            timedOutForCrawl = true;
            await reader.cancel().catch(() => undefined);
            break;
          }

          const { value, done } = readResult.r;
          if (done) break;
          lastCheckedAt = new Date().toISOString();
          buffer += decoder.decode(value, { stream: true });

          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() ?? '';

          for (const block of blocks) {
            const lines = block.split(/\r?\n/);
            const dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart());
              }
            }
            if (dataLines.length === 0) continue;
            const rawData = dataLines.join('\n').trim();
            if (!rawData || rawData === '[DONE]') continue;
            try {
              const parsedData = JSON.parse(rawData);
              const candidates = extractWatchVideosFromPayload(parsedData, parsedUrl.origin);
              recordDiscoveredCandidates(candidates);
              tryStartNextDiscoveredCandidate();
            } catch {
              // Ignore non-JSON SSE control messages
            }
          }

          if (Date.now() - sseOpenedAt >= CRAWL_INTERVAL_MS) {
            timedOutForCrawl = true;
            await reader.cancel().catch(() => undefined);
            break;
          }
        }

        if (!timedOutForCrawl) {
          await waitCrawlInterval(signal, CRAWL_INTERVAL_MS);
        }
        continue;
      }

      // JSON crawling every 5 seconds
      const rawText = await response.text();
      const json = JSON.parse(rawText);
      connectionState = 'polling_json';
      lastError = undefined;
      connectionMessage = `Crawling ${parsedUrl.hostname} every 5s (1-by-1 import & 5-min post-clip break).`;
      lastCheckedAt = new Date().toISOString();

      const candidates = extractWatchVideosFromPayload(json, parsedUrl.origin);
      recordDiscoveredCandidates(candidates);
      tryStartNextDiscoveredCandidate();

      await waitCrawlInterval(signal, CRAWL_INTERVAL_MS);
    } catch (err) {
      if (signal.aborted || generation !== loopGeneration || !watchConfig.enabled) break;
      const msg = err instanceof Error ? err.message : 'Watch connection error';
      connectionState = 'error';
      lastError = msg;
      connectionMessage = `Connection error: ${msg}`;
      await sleepWithSignal(CRAWL_INTERVAL_MS, signal);
    }
  }
}

async function probeSingleEndpoint(
  parsedUrl: URL,
  headerName: string,
  token: string,
  preferJson = false
): Promise<WatchFetchResult> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const headers: Record<string, string> = {
      Accept: preferJson ? 'application/json' : 'text/event-stream, application/json',
      'Cache-Control': 'no-cache',
      ...buildConfiguredHeaders(headerName, token),
    };

    const { response, authBlockedReason } = await fetchWithRedirectCheck(
      parsedUrl.toString(),
      headers,
      controller.signal
    );
    const latencyMs = Date.now() - startedAt;

    if (authBlockedReason) {
      return {
        ping: {
          ok: false,
          state: 'auth_blocked',
          httpStatus: 302,
          latencyMs,
          message: authBlockedReason,
          checkedAt,
        },
        videos: [],
      };
    }

    if (!response) {
      return {
        ping: {
          ok: false,
          state: 'error',
          latencyMs,
          message: 'No response received from external endpoint.',
          checkedAt,
        },
        videos: [],
      };
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ping: {
          ok: false,
          state: 'auth_blocked',
          httpStatus: response.status,
          latencyMs,
          contentType,
          message: token
            ? `API key rejected by ${parsedUrl.hostname} (HTTP ${response.status}). Double-check the API key and Auth Header.`
            : `HTTP ${response.status} from ${parsedUrl.hostname}. Enter your external tool API key and try Ping again.`,
          checkedAt,
        },
        videos: [],
      };
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ping: {
          ok: false,
          state: 'error',
          httpStatus: response.status,
          latencyMs,
          contentType,
          message: `Endpoint returned HTTP ${response.status} ${response.statusText || ''}`.trim(),
          checkedAt,
        },
        videos: [],
      };
    }

    if (contentType.includes('text/html')) {
      const htmlSnippet = (await response.text().catch(() => '')).slice(0, 1000);
      const isLoginGate =
        htmlSnippet.includes('__cookie_check') || htmlSnippet.includes('aistudio');
      return {
        ping: {
          ok: false,
          state: isLoginGate ? 'auth_blocked' : 'error',
          httpStatus: response.status,
          latencyMs,
          contentType,
          message: isLoginGate
            ? 'External AI Studio dev preview URL returned a session cookie login page instead of JSON/SSE. Switch to its Published/Shared URL or Hostinger domain.'
            : 'Endpoint returned an HTML webpage instead of JSON or SSE video events.',
          checkedAt,
        },
        videos: [],
      };
    }

    if (contentType.includes('text/event-stream')) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ping: {
          ok: true,
          state: 'connected_sse',
          httpStatus: response.status,
          latencyMs,
          contentType,
          resolvedUrl: parsedUrl.toString(),
          message: token
            ? `Ping OK (${latencyMs}ms) — API key accepted & live SSE event stream active.`
            : `Ping OK (${latencyMs}ms) — Live SSE event stream reachable.`,
          checkedAt,
        },
        videos: [],
      };
    }

    const rawText = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      return {
        ping: {
          ok: false,
          state: 'error',
          httpStatus: response.status,
          latencyMs,
          contentType,
          message: 'Reached endpoint (HTTP 200) but response is neither valid JSON nor an SSE stream.',
          checkedAt,
        },
        videos: [],
      };
    }

    const candidates = extractWatchVideosFromPayload(json, parsedUrl.origin);
    const videos: ExternalFeedVideo[] = candidates.map((c) => ({
      sourceKey: c.sourceKey,
      videoUrl: c.videoUrl,
      fallbackUrls: c.fallbackUrls.length > 0 ? c.fallbackUrls : undefined,
      title: c.title,
      alreadyProcessed: processedKeys.has(c.sourceKey),
    }));

    return {
      ping: {
        ok: true,
        state: 'polling_json',
        httpStatus: response.status,
        latencyMs,
        contentType,
        detectedVideosCount: videos.length,
        resolvedUrl: parsedUrl.toString(),
        message: token
          ? `Ping OK (${latencyMs}ms) — API key working! JSON feed reachable (${videos.length} video${videos.length === 1 ? '' : 's'} in feed).`
          : `Ping OK (${latencyMs}ms) — JSON feed reachable (${videos.length} video${videos.length === 1 ? '' : 's'} in feed).`,
        checkedAt,
      },
      videos,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? 'Ping timed out after 10 seconds.'
        : err instanceof Error
          ? err.message
          : 'Network error while pinging external tool.';
    return {
      ping: {
        ok: false,
        state: 'error',
        latencyMs,
        message: msg,
        checkedAt,
      },
      videos: [],
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchExternalVideos(override?: {
  eventsUrl?: string;
  authHeaderName?: string;
  authToken?: string;
  preferJson?: boolean;
}): Promise<WatchFetchResult> {
  const targetUrl = (override?.eventsUrl ?? watchConfig.eventsUrl).trim();
  const headerName =
    (override?.authHeaderName ?? watchConfig.authHeaderName).trim() || 'Authorization';
  const token = (override?.authToken ?? watchConfig.authToken).trim();
  const preferJson = override?.preferJson !== false;
  const checkedAt = new Date().toISOString();

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('URL must start with http:// or https://');
    }
  } catch (err) {
    const ping: WatchPingResult = {
      ok: false,
      state: 'error',
      latencyMs: 0,
      message: err instanceof Error ? err.message : 'Invalid External Watch URL.',
      checkedAt,
    };
    lastPing = ping;
    return { ping, videos: [] };
  }

  let result = await probeSingleEndpoint(parsedUrl, headerName, token, preferJson);

  // If user pasted a bare app root URL returning HTML (not login-gated), auto-check common API endpoints
  if (
    !result.ping.ok &&
    result.ping.state === 'error' &&
    (parsedUrl.pathname === '/' || parsedUrl.pathname === '')
  ) {
    for (const fallbackPath of ['/api/watch/events', '/api/videos']) {
      const candidateUrl = new URL(fallbackPath, parsedUrl.origin);
      const attempt = await probeSingleEndpoint(candidateUrl, headerName, token, preferJson);
      if (attempt.ping.ok || attempt.ping.state === 'auth_blocked') {
        result = attempt;
        break;
      }
    }
  }

  lastPing = result.ping;
  return result;
}

export async function pingWatchConnection(override?: {
  eventsUrl?: string;
  authHeaderName?: string;
  authToken?: string;
}): Promise<WatchPingResult> {
  const res = await fetchExternalVideos({ ...override, preferJson: false });
  return res.ping;
}

export async function connectWatchSource(
  patch: Partial<WatchSourceConfig>,
  baseUrl?: string
): Promise<WatchStatusResponse & { ping: WatchPingResult }> {
  await updateWatchConfig({ ...patch, enabled: true });
  const ping = await pingWatchConnection();
  if (ping.ok && ping.resolvedUrl && ping.resolvedUrl !== watchConfig.eventsUrl) {
    await updateWatchConfig({ eventsUrl: ping.resolvedUrl, enabled: true });
  }
  lastCheckedAt = ping.checkedAt;
  if (ping.ok) {
    connectionState = ping.state;
    connectionMessage = ping.message;
    lastError = undefined;
  } else {
    connectionState = ping.state;
    connectionMessage = ping.message;
    lastError = ping.message;
  }
  restartWatchLoop();
  return {
    ...getWatchStatus(baseUrl),
    ping,
  };
}


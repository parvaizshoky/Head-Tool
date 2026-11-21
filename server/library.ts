import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BatchJob,
  GeneratedClip,
  IntegrationSettings,
  LibraryVideo,
  VideoFeedItem,
} from '../src/types/clipper.ts';

const STORAGE_ROOT = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.resolve(process.cwd(), 'storage');

export const LIBRARY_DIR = path.join(STORAGE_ROOT, 'library');
export const LIBRARY_THUMBS_DIR = path.join(LIBRARY_DIR, 'thumbs');
const LIBRARY_INDEX_PATH = path.join(STORAGE_ROOT, 'library.json');
const INTEGRATION_PATH = path.join(STORAGE_ROOT, 'integration.json');

const libraryMap = new Map<string, LibraryVideo>();

let integrationSettings: IntegrationSettings = {
  feedEnabled: true,
  authEnabled: false,
  apiKey: '',
  webhookUrl: '',
};

let libraryPersistQueue: Promise<void> = Promise.resolve();

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

async function persistLibraryIndex(): Promise<void> {
  const next = libraryPersistQueue
    .catch(() => undefined)
    .then(async () => {
      await atomicWriteJson(LIBRARY_INDEX_PATH, Array.from(libraryMap.values()));
    });
  libraryPersistQueue = next;
  await next;
}

async function linkOrCopyFile(srcPath: string, destPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.unlink(destPath).catch(() => undefined);
  try {
    await fs.link(srcPath, destPath);
  } catch {
    await fs.copyFile(srcPath, destPath);
  }
}

function makeLibraryVideoId(jobId: string, clipId: string): string {
  const cleanJob = jobId.replace(/[^a-zA-Z0-9_-]/g, '');
  const cleanClip = clipId.replace(/[^a-zA-Z0-9_-]/g, '');
  return `vid_${cleanJob}_${cleanClip}`;
}

function buildClipCaption(job: BatchJob, clip: GeneratedClip): string {
  const baseTitle = clip.title?.trim() || `${job.movieTitle} Clip #${clip.index}`;
  const snippet = clip.transcriptSnippet?.trim();
  const summary = clip.summary?.trim();
  if (snippet && snippet.length > 0 && !baseTitle.toLowerCase().includes(snippet.toLowerCase())) {
    return `${baseTitle} — "${snippet}"`;
  }
  if (summary && summary.length > 0 && summary !== baseTitle) {
    return `${baseTitle} — ${summary}`;
  }
  return baseTitle;
}

export async function initializeLibrary(existingJobs: BatchJob[]): Promise<void> {
  await fs.mkdir(LIBRARY_DIR, { recursive: true });
  await fs.mkdir(LIBRARY_THUMBS_DIR, { recursive: true });

  // Load persisted integration settings
  try {
    const rawSettings = await fs.readFile(INTEGRATION_PATH, 'utf8');
    const parsed = JSON.parse(rawSettings) as Partial<IntegrationSettings>;
    integrationSettings = {
      feedEnabled: parsed.feedEnabled !== false,
      authEnabled: Boolean(parsed.authEnabled),
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      webhookUrl: typeof parsed.webhookUrl === 'string' ? parsed.webhookUrl : '',
    };
  } catch {
    const envKey = process.env.VIDEO_FEED_API_KEY?.trim() || '';
    integrationSettings = {
      feedEnabled: true,
      authEnabled: Boolean(envKey),
      apiKey: envKey,
      webhookUrl: process.env.TIKTOK_WEBHOOK_URL?.trim() || '',
    };
  }

  // Load existing library index
  let dirty = false;
  try {
    const rawLib = await fs.readFile(LIBRARY_INDEX_PATH, 'utf8');
    const parsed = JSON.parse(rawLib) as LibraryVideo[];
    for (const item of parsed) {
      if (item && item.id && item.filePath && fsSync.existsSync(item.filePath)) {
        libraryMap.set(item.id, item);
      } else {
        dirty = true;
      }
    }
  } catch {
    // No library.json yet
  }

  // Backfill any already-completed clips from existing batch jobs so nothing is missed
  for (const job of existingJobs) {
    for (const clip of job.clips) {
      if (clip.status !== 'completed' || !clip.outputPath || !fsSync.existsSync(clip.outputPath)) {
        continue;
      }
      const id = makeLibraryVideoId(job.id, clip.id);
      if (libraryMap.has(id)) continue;

      const destVideo = path.join(LIBRARY_DIR, `${id}.mp4`);
      try {
        await linkOrCopyFile(clip.outputPath, destVideo);
        let destThumb: string | undefined;
        if (clip.thumbnailPath && fsSync.existsSync(clip.thumbnailPath)) {
          destThumb = path.join(LIBRARY_THUMBS_DIR, `${id}.jpg`);
          await linkOrCopyFile(clip.thumbnailPath, destThumb).catch(() => {
            destThumb = undefined;
          });
        }
        const stat = await fs.stat(destVideo);
        const entry: LibraryVideo = {
          id,
          jobId: job.id,
          clipId: clip.id,
          movieId: job.movieId,
          movieTitle: job.movieTitle,
          title: clip.title,
          caption: buildClipCaption(job, clip),
          summary: clip.summary,
          transcriptSnippet: clip.transcriptSnippet,
          category: clip.category,
          score: clip.score,
          filename: clip.outputFilename,
          filePath: destVideo,
          thumbnailPath: destThumb,
          fileSizeBytes: clip.fileSizeBytes ?? stat.size,
          durationSeconds: clip.durationSeconds,
          startSeconds: clip.startSeconds,
          endSeconds: clip.endSeconds,
          actualWidth: clip.actualWidth,
          actualHeight: clip.actualHeight,
          aspectRatio: job.config.aspectRatio ?? 'source',
          playbackSpeed: job.config.playbackSpeed ?? 1,
          partNumber: clip.index,
          totalParts: job.clips.length,
          jobCreatedAt: job.createdAt,
          createdAt: clip.completedAt || job.updatedAt || new Date().toISOString(),
        };
        libraryMap.set(id, entry);
        dirty = true;
      } catch {
        // Skip broken clip file
      }
    }
  }

  if (dirty) {
    await persistLibraryIndex();
  }
}

export async function saveClipToLibrary(
  job: BatchJob,
  clip: GeneratedClip
): Promise<LibraryVideo | null> {
  if (!clip.outputPath || !fsSync.existsSync(clip.outputPath)) {
    return null;
  }

  const id = makeLibraryVideoId(job.id, clip.id);
  const destVideo = path.join(LIBRARY_DIR, `${id}.mp4`);
  await linkOrCopyFile(clip.outputPath, destVideo);

  let destThumb: string | undefined;
  if (clip.thumbnailPath && fsSync.existsSync(clip.thumbnailPath)) {
    destThumb = path.join(LIBRARY_THUMBS_DIR, `${id}.jpg`);
    await linkOrCopyFile(clip.thumbnailPath, destThumb).catch(() => {
      destThumb = undefined;
    });
  }

  const stat = await fs.stat(destVideo);
  const entry: LibraryVideo = {
    id,
    jobId: job.id,
    clipId: clip.id,
    movieId: job.movieId,
    movieTitle: job.movieTitle,
    title: clip.title,
    caption: buildClipCaption(job, clip),
    summary: clip.summary,
    transcriptSnippet: clip.transcriptSnippet,
    category: clip.category,
    score: clip.score,
    filename: clip.outputFilename,
    filePath: destVideo,
    thumbnailPath: destThumb,
    fileSizeBytes: clip.fileSizeBytes ?? stat.size,
    durationSeconds: clip.durationSeconds,
    startSeconds: clip.startSeconds,
    endSeconds: clip.endSeconds,
    actualWidth: clip.actualWidth,
    actualHeight: clip.actualHeight,
    aspectRatio: job.config.aspectRatio ?? 'source',
    playbackSpeed: job.config.playbackSpeed ?? 1,
    partNumber: clip.index,
    totalParts: job.clips.length,
    jobCreatedAt: job.createdAt,
    createdAt: clip.completedAt || new Date().toISOString(),
  };

  libraryMap.set(id, entry);
  await persistLibraryIndex();

  // Optional non-blocking Push Webhook if user configured one
  const webhookUrl = integrationSettings.webhookUrl?.trim();
  if (webhookUrl && /^https?:\/\//i.test(webhookUrl)) {
    const fallbackBase =
      process.env.PUBLIC_URL && /^https?:\/\//i.test(process.env.PUBLIC_URL)
        ? process.env.PUBLIC_URL.replace(/\/+$/, '')
        : process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL' && /^https?:\/\//i.test(process.env.APP_URL)
          ? process.env.APP_URL.replace(/\/+$/, '')
          : '';
    if (fallbackBase) {
      const tokenQuery =
        integrationSettings.authEnabled && integrationSettings.apiKey
          ? integrationSettings.apiKey
          : undefined;
      const payload = toVideoFeedItem(entry, fallbackBase, tokenQuery);
      void fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(integrationSettings.authEnabled && integrationSettings.apiKey
            ? { Authorization: `Bearer ${integrationSettings.apiKey}` }
            : {}),
        },
        body: JSON.stringify({ event: 'video.ready', video: payload }),
      }).catch(() => undefined);
    }
  }

  return entry;
}

export function listLibraryVideos(filters?: {
  aspectRatio?: string;
  movieId?: string;
  jobId?: string;
  since?: string;
  limit?: number;
}): LibraryVideo[] {
  let items = Array.from(libraryMap.values());

  if (filters?.aspectRatio && filters.aspectRatio !== 'all') {
    items = items.filter((v) => v.aspectRatio === filters.aspectRatio);
  }
  if (filters?.movieId && filters.movieId !== 'all') {
    items = items.filter((v) => v.movieId === filters.movieId);
  }
  if (filters?.jobId && filters.jobId !== 'all') {
    items = items.filter((v) => v.jobId === filters.jobId);
  }
  if (filters?.since) {
    const sinceMs = Date.parse(filters.since);
    if (Number.isFinite(sinceMs)) {
      items = items.filter((v) => Date.parse(v.createdAt) >= sinceMs);
    }
  }

  items.sort((a, b) => {
    if (a.jobId === b.jobId) {
      const partA = a.partNumber ?? a.startSeconds;
      const partB = b.partNumber ?? b.startSeconds;
      return partA - partB;
    }
    const batchA = new Date(a.jobCreatedAt || a.createdAt).getTime();
    const batchB = new Date(b.jobCreatedAt || b.createdAt).getTime();
    return batchB - batchA;
  });

  if (filters?.limit && Number.isFinite(filters.limit) && filters.limit > 0) {
    items = items.slice(0, Math.floor(filters.limit));
  }

  return items;
}

export function getLibraryVideo(id: string): LibraryVideo | undefined {
  return libraryMap.get(id);
}

export async function deleteLibraryVideo(id: string): Promise<boolean> {
  const existing = libraryMap.get(id);
  if (!existing) return false;
  libraryMap.delete(id);
  await persistLibraryIndex();
  await fs.unlink(existing.filePath).catch(() => undefined);
  if (existing.thumbnailPath) {
    await fs.unlink(existing.thumbnailPath).catch(() => undefined);
  }
  return true;
}

export async function deleteLibraryVideosForJob(
  jobId?: string,
  movieId?: string
): Promise<number> {
  if (!jobId && !movieId) return 0;
  const targets: LibraryVideo[] = [];
  for (const vid of libraryMap.values()) {
    if ((jobId && vid.jobId === jobId) || (!jobId && movieId && vid.movieId === movieId)) {
      targets.push(vid);
    }
  }
  if (targets.length === 0) return 0;

  for (const vid of targets) {
    libraryMap.delete(vid.id);
  }
  await persistLibraryIndex();

  await Promise.all(
    targets.map(async (vid) => {
      await fs.unlink(vid.filePath).catch(() => undefined);
      if (vid.thumbnailPath) {
        await fs.unlink(vid.thumbnailPath).catch(() => undefined);
      }
    })
  );
  return targets.length;
}

export function toVideoFeedItem(
  video: LibraryVideo,
  baseUrl: string,
  tokenForQuery?: string
): VideoFeedItem {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const tokenSuffix = tokenForQuery ? `?token=${encodeURIComponent(tokenForQuery)}` : '';
  const streamUrl = `${cleanBase}/api/videos/${encodeURIComponent(video.id)}/stream${tokenSuffix}`;
  const downloadUrl = `${cleanBase}/api/videos/${encodeURIComponent(video.id)}/download${tokenSuffix}`;
  const thumbUrl =
    video.thumbnailPath && fsSync.existsSync(video.thumbnailPath)
      ? `${cleanBase}/api/videos/${encodeURIComponent(video.id)}/thumbnail${tokenSuffix}`
      : undefined;

  return {
    id: video.id,
    title: video.title,
    caption: video.caption,
    description: video.summary,
    category: video.category,
    partNumber: video.partNumber,
    totalParts: video.totalParts,
    url: streamUrl,
    videoUrl: streamUrl,
    video_url: streamUrl,
    downloadUrl,
    download_url: downloadUrl,
    thumbnailUrl: thumbUrl,
    thumbnail_url: thumbUrl,
    filename: video.filename,
    mimeType: 'video/mp4',
    duration: Math.round(video.durationSeconds * 100) / 100,
    durationSeconds: Math.round(video.durationSeconds * 100) / 100,
    width: video.actualWidth,
    height: video.actualHeight,
    aspectRatio: video.aspectRatio,
    fileSizeBytes: video.fileSizeBytes,
    jobId: video.jobId,
    movieId: video.movieId,
    movieTitle: video.movieTitle,
    createdAt: video.createdAt,
  };
}

export function getIntegrationSettings(): IntegrationSettings {
  return { ...integrationSettings };
}

export async function updateIntegrationSettings(
  patch: Partial<IntegrationSettings> & { regenerateKey?: boolean }
): Promise<IntegrationSettings> {
  let nextKey =
    typeof patch.apiKey === 'string' ? patch.apiKey.trim() : integrationSettings.apiKey;
  if (patch.regenerateKey || (patch.authEnabled && !nextKey)) {
    nextKey = `fs_${crypto.randomBytes(18).toString('hex')}`;
  }

  integrationSettings = {
    feedEnabled:
      typeof patch.feedEnabled === 'boolean'
        ? patch.feedEnabled
        : integrationSettings.feedEnabled,
    authEnabled:
      typeof patch.authEnabled === 'boolean'
        ? patch.authEnabled
        : integrationSettings.authEnabled,
    apiKey: nextKey,
    webhookUrl:
      typeof patch.webhookUrl === 'string'
        ? patch.webhookUrl.trim()
        : integrationSettings.webhookUrl,
  };

  await atomicWriteJson(INTEGRATION_PATH, integrationSettings);
  return getIntegrationSettings();
}

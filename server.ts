import 'dotenv/config';
import { ZipArchive } from 'archiver';
import crypto from 'node:crypto';
import express from 'express';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_CLIPS_PER_MOVIE } from './src/types/clipper.ts';
import type { BatchConfig, ImportQualityTier, MovieMetadata } from './src/types/clipper.ts';
import {
  cancelImportJob,
  deleteYoutubeCookies,
  getImportJob,
  getYoutubeCookiesStatus,
  saveYoutubeCookies,
  startUrlImport,
  subscribeToImport,
} from './server/downloader.ts';
import {
  generateSampleMultiSceneMovie,
  probeVideo,
} from './server/ffmpeg.ts';
import {
  MOVIES_DIR,
  OVERLAYS_DIR,
  UPLOADS_TMP_DIR,
  cancelJob,
  createBatchJob,
  deleteJob,
  getJob,
  getMovie,
  initializeStorage,
  listJobs,
  listMovies,
  pauseJob,
  prepareAndRegisterMovie,
  registerMovie,
  removeMovie,
  resumeJob,
  retryFailedClips,
  subscribeToJob,
  updateJobConcurrency,
} from './server/queue.ts';
import {
  deleteLibraryVideo,
  getIntegrationSettings,
  getLibraryVideo,
  listLibraryVideos,
  toVideoFeedItem,
  updateIntegrationSettings,
} from './server/library.ts';
import {
  WatchLockedError,
  clearWatchItems,
  connectWatchSource,
  fetchExternalVideos,
  getWatchStatus,
  ingestWatchPayload,
  initializeWatcher,
  pingWatchConnection,
  retryFailedWatchItems,
  retryWatchItem,
  setWatchSwitch,
  triggerWatchCheckNow,
  updateWatchConfig,
} from './server/watcher.ts';

const PORT = Number(process.env.PORT) || 3000;

interface PendingUpload {
  uploadId: string;
  filename: string;
  totalSize: number;
  receivedBytes: number;
  tempPath: string;
  createdAt: number;
}

const pendingUploads = new Map<string, PendingUpload>();
const completedUploads = new Map<string, { movie: MovieMetadata; completedAt: number }>();

function pruneCompletedUploads(): void {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [id, entry] of completedUploads.entries()) {
    if (entry.completedAt < cutoff) {
      completedUploads.delete(id);
    }
  }
}

function getUploadMetaPath(uploadId: string): string {
  const safeId = path.basename(uploadId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(UPLOADS_TMP_DIR, `${safeId}.meta.json`);
}

async function getOrLoadPendingUpload(uploadId: string): Promise<PendingUpload | undefined> {
  const existing = pendingUploads.get(uploadId);
  if (existing) return existing;

  const metaPath = getUploadMetaPath(uploadId);
  try {
    const raw = await fs.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw) as PendingUpload;
    if (parsed && parsed.uploadId && parsed.tempPath && fsSync.existsSync(parsed.tempPath)) {
      pendingUploads.set(parsed.uploadId, parsed);
      return parsed;
    }
  } catch {
    // No persisted upload session found
  }
  return undefined;
}

function getVideoMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.mkv':
      return 'video/x-matroska';
    case '.avi':
      return 'video/x-msvideo';
    case '.mp4':
    case '.m4v':
    default:
      return 'video/mp4';
  }
}

const MAX_RANGE_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MB cap prevents Cloud Run 32MB limit & enables instant seeking

function streamVideoWithRanges(req: express.Request, res: express.Response, filePath: string, contentType?: string): void {
  if (!fsSync.existsSync(filePath)) {
    res.status(404).json({ error: 'Video file not found.' });
    return;
  }

  const resolvedType = contentType || getVideoMimeType(filePath);
  const stat = fsSync.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    let start: number;
    let requestedEnd: number;

    if (!parts[0] && parts[1]) {
      const suffixLen = parseInt(parts[1], 10);
      start = Math.max(0, fileSize - suffixLen);
      requestedEnd = fileSize - 1;
    } else {
      start = parseInt(parts[0], 10);
      requestedEnd = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    }

    if (
      Number.isNaN(start) ||
      Number.isNaN(requestedEnd) ||
      start < 0 ||
      start >= fileSize ||
      requestedEnd >= fileSize ||
      start > requestedEnd
    ) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const end = Math.min(requestedEnd, start + MAX_RANGE_CHUNK_BYTES - 1);
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': resolvedType,
      'Cache-Control': 'public, max-age=3600',
    });
    const stream = fsSync.createReadStream(filePath, { start, end });
    stream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': resolvedType,
      'Cache-Control': 'public, max-age=3600',
    });
    const stream = fsSync.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}

async function startServer(): Promise<void> {
  await initializeStorage();
  await initializeWatcher();

  const app = express();
  app.set('trust proxy', 1);
  app.use((req, _res, next) => {
    const apiIdx = req.url.indexOf('/api/');
    if (apiIdx > 0) {
      req.url = req.url.slice(apiIdx);
    }
    next();
  });
  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Authorization, X-API-Key, x-api-key');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: '16mb', type: ['application/json', 'text/plain', 'application/*+json'] }));

  // Health endpoint
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, hasGeminiKey: Boolean(process.env.GEMINI_API_KEY) });
  });

  // Chunked Binary + JSON-Base64 Fallback Upload API (handles multi-GB 1-3+ hour movies across strict proxies/WAFs)
  app.post('/api/uploads/init', async (req, res) => {
    try {
      const body = (
        typeof req.body === 'string'
          ? (JSON.parse(req.body || '{}') as Record<string, unknown>)
          : req.body && typeof req.body === 'object'
            ? req.body
            : {}
      ) as { filename?: string; totalSize?: number };

      const rawFilename =
        typeof body.filename === 'string' && body.filename.trim()
          ? body.filename.trim()
          : typeof req.query.filename === 'string' && req.query.filename.trim()
            ? req.query.filename.trim()
            : 'uploaded_video.mp4';

      const filename = path.basename(rawFilename) || 'uploaded_video.mp4';
      const totalSize = Number(body.totalSize ?? req.query.totalSize ?? 0) || 0;

      const uploadId = `up_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const rawExt = path.extname(filename).toLowerCase();
      const ext = /^\.[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : '.mp4';
      const tempPath = path.join(UPLOADS_TMP_DIR, `${uploadId}${ext}`);
      await fs.mkdir(UPLOADS_TMP_DIR, { recursive: true });
      await fs.writeFile(tempPath, Buffer.alloc(0));

      const session: PendingUpload = {
        uploadId,
        filename,
        totalSize,
        receivedBytes: 0,
        tempPath,
        createdAt: Date.now(),
      };
      pendingUploads.set(uploadId, session);
      await fs.writeFile(getUploadMetaPath(uploadId), JSON.stringify(session), 'utf8').catch(() => undefined);

      res.json({ uploadId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to initialize upload';
      res.status(500).json({ error: msg });
    }
  });

  app.post(
    '/api/uploads/:uploadId/chunk',
    express.raw({ type: '*/*', limit: '16mb' }),
    async (req, res) => {
      try {
        const upload = await getOrLoadPendingUpload(req.params.uploadId);
        if (!upload) {
          res.status(404).json({ error: 'Upload session not found.' });
          return;
        }

        let chunkBuffer: Buffer;
        let bodyOffset: number | undefined;

        if (Buffer.isBuffer(req.body)) {
          chunkBuffer = req.body;
        } else if (req.body && typeof req.body === 'object') {
          const jsonBody = req.body as { dataBase64?: unknown; offset?: unknown };
          if (typeof jsonBody.dataBase64 !== 'string') {
            res.status(400).json({ error: 'Expected binary chunk or base64 JSON payload.' });
            return;
          }
          chunkBuffer = Buffer.from(jsonBody.dataBase64, 'base64');
          if (jsonBody.offset !== undefined) {
            bodyOffset = Number(jsonBody.offset);
          }
        } else {
          res.status(400).json({ error: 'Expected binary or base64 chunk payload.' });
          return;
        }

        const offsetParam = req.query.offset ?? bodyOffset;
        if (offsetParam !== undefined) {
          const offset = Number(offsetParam);
          if (!Number.isFinite(offset) || offset < 0) {
            res.status(400).json({ error: 'Invalid chunk offset.' });
            return;
          }
          const handle = await fs.open(upload.tempPath, 'r+');
          try {
            await handle.write(chunkBuffer, 0, chunkBuffer.length, offset);
          } finally {
            await handle.close();
          }
        } else {
          await fs.appendFile(upload.tempPath, chunkBuffer);
        }

        upload.receivedBytes += chunkBuffer.length;
        res.json({ receivedBytes: upload.receivedBytes, chunkBytes: chunkBuffer.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to write chunk';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post('/api/uploads/:uploadId/complete', async (req, res) => {
    let finalPath: string | null = null;
    try {
      pruneCompletedUploads();
      const cached = completedUploads.get(req.params.uploadId);
      if (cached) {
        const current = getMovie(cached.movie.id) ?? cached.movie;
        res.json({ movie: current });
        return;
      }

      const upload = await getOrLoadPendingUpload(req.params.uploadId);
      if (!upload) {
        res.status(404).json({ error: 'Upload session not found.' });
        return;
      }

      const tempStat = await fs.stat(upload.tempPath).catch(() => null);
      if (!tempStat || tempStat.size === 0) {
        pendingUploads.delete(upload.uploadId);
        await fs.unlink(upload.tempPath).catch(() => undefined);
        await fs.unlink(getUploadMetaPath(upload.uploadId)).catch(() => undefined);
        res.status(400).json({ error: 'Uploaded video file is empty.' });
        return;
      }

      if (upload.totalSize > 0 && tempStat.size < upload.totalSize) {
        res.status(400).json({
          error: `Upload incomplete (${tempStat.size} of ${upload.totalSize} bytes assembled). Please retry uploading the movie.`,
        });
        return;
      }

      const movieId = `mov_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const rawExt = path.extname(upload.filename).toLowerCase();
      const ext = /^\.[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : '.mp4';
      finalPath = path.join(MOVIES_DIR, `${movieId}${ext}`);
      await fs.mkdir(MOVIES_DIR, { recursive: true });
      await fs.rename(upload.tempPath, finalPath);
      pendingUploads.delete(upload.uploadId);
      await fs.unlink(getUploadMetaPath(upload.uploadId)).catch(() => undefined);

      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { title?: string };
      const title =
        typeof body.title === 'string' && body.title.trim()
          ? body.title.trim()
          : typeof req.query.title === 'string' && req.query.title.trim()
            ? req.query.title.trim()
            : undefined;
      const rawMetadata = await probeVideo(finalPath, movieId, upload.filename, title);
      const metadata = await prepareAndRegisterMovie(rawMetadata);

      completedUploads.set(upload.uploadId, { movie: metadata, completedAt: Date.now() });
      res.json({ movie: metadata });
    } catch (err) {
      if (finalPath) {
        await fs.unlink(finalPath).catch(() => undefined);
      }
      const msg = err instanceof Error ? err.message : 'Failed to finalize uploaded movie';
      res.status(500).json({ error: msg });
    }
  });

  app.delete('/api/uploads/:uploadId', async (req, res) => {
    const upload = await getOrLoadPendingUpload(req.params.uploadId);
    if (upload) {
      pendingUploads.delete(req.params.uploadId);
      await fs.unlink(upload.tempPath).catch(() => undefined);
    }
    await fs.unlink(getUploadMetaPath(req.params.uploadId)).catch(() => undefined);
    res.json({ cancelled: true });
  });

  // Import HD video from URL link (YouTube/Vimeo/Direct MP4/HLS)
  app.post('/api/imports/url', async (req, res) => {
    try {
      const { url, preferredQuality = 'best_hd', customTitle } = req.body as {
        url?: string;
        preferredQuality?: ImportQualityTier;
        customTitle?: string;
      };
      if (!url || !url.trim()) {
        res.status(400).json({ error: 'A video URL link is required.' });
        return;
      }

      const importJob = await startUrlImport({
        url,
        preferredQuality,
        customTitle,
      });
      res.status(201).json({ importJob });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start HD video link import';
      res.status(400).json({ error: msg });
    }
  });

  app.get('/api/imports/:importId', (req, res) => {
    const job = getImportJob(req.params.importId);
    if (!job) {
      res.status(404).json({ error: 'Import job not found.' });
      return;
    }
    res.json({ importJob: job });
  });

  app.get('/api/imports/:importId/events', (req, res) => {
    const job = getImportJob(req.params.importId);
    if (!job) {
      res.status(404).json({ error: 'Import job not found.' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    res.write(`data: ${JSON.stringify(job)}\n\n`);

    const unsubscribe = subscribeToImport(req.params.importId, (updated) => {
      res.write(`data: ${JSON.stringify(updated)}\n\n`);
    });

    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.post('/api/imports/:importId/cancel', (req, res) => {
    const job = cancelImportJob(req.params.importId);
    if (!job) {
      res.status(404).json({ error: 'Import job not found.' });
      return;
    }
    res.json({ importJob: job });
  });

  // YouTube Authentication Cookies (cookies.txt) for direct YouTube link downloads
  app.get('/api/settings/youtube-cookies', async (_req, res) => {
    try {
      const cookies = await getYoutubeCookiesStatus();
      res.json({ cookies });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to inspect YouTube cookies status';
      res.status(500).json({ error: msg });
    }
  });

  app.put('/api/settings/youtube-cookies', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { cookiesText?: unknown };
      const cookiesText = typeof body.cookiesText === 'string' ? body.cookiesText : '';
      const cookies = await saveYoutubeCookies(cookiesText);
      res.json({ cookies });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save YouTube cookies';
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/api/settings/youtube-cookies', async (_req, res) => {
    try {
      const cookies = await deleteYoutubeCookies();
      res.json({ cookies });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to clear YouTube cookies';
      res.status(500).json({ error: msg });
    }
  });

  // Generate a real multi-scene test feature video via FFmpeg
  app.post('/api/movies/generate-sample', async (req, res) => {
    try {
      const { durationSeconds = 180, title } = (req.body ?? {}) as {
        durationSeconds?: number;
        title?: string;
      };
      const clampedDur = Math.max(60, Math.min(900, Math.round(Number(durationSeconds) || 180)));
      const movieId = `mov_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const finalPath = path.join(MOVIES_DIR, `${movieId}.mp4`);

      await generateSampleMultiSceneMovie(finalPath, clampedDur);
      const displayTitle = title || `Multi-Scene Test Reel (${Math.round(clampedDur / 60)}m)`;
      const metadata = await probeVideo(finalPath, movieId, `${movieId}.mp4`, displayTitle);
      await registerMovie(metadata);

      res.json({ movie: metadata });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate sample movie';
      res.status(500).json({ error: msg });
    }
  });

  // Movies routes
  app.get('/api/movies', (_req, res) => {
    res.json({ movies: listMovies() });
  });

  app.get('/api/movies/:movieId', (req, res) => {
    const movie = getMovie(req.params.movieId);
    if (!movie) {
      res.status(404).json({ error: 'Movie not found.' });
      return;
    }
    res.json({ movie });
  });

  app.get('/api/movies/:movieId/stream', (req, res) => {
    const movie = getMovie(req.params.movieId);
    if (!movie) {
      res.status(404).json({ error: 'Movie not found.' });
      return;
    }
    const usePreview =
      movie.previewPath &&
      movie.previewStatus === 'ready' &&
      fsSync.existsSync(movie.previewPath);
    streamVideoWithRanges(req, res, usePreview ? movie.previewPath! : movie.filePath);
  });

  app.delete('/api/movies/:movieId', async (req, res) => {
    const ok = await removeMovie(req.params.movieId);
    if (!ok) {
      res.status(404).json({ error: 'Movie not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  // Overlay Thumbnail Image Upload & Serve (supports binary + JSON base64 fallback for WAFs)
  app.post(
    '/api/overlays',
    express.raw({ type: ['application/octet-stream', 'image/*'], limit: '15mb' }),
    async (req, res) => {
      try {
        let buf: Buffer;
        let bodyFilename: string | undefined;

        if (Buffer.isBuffer(req.body)) {
          buf = req.body;
        } else if (req.body && typeof req.body === 'object') {
          const jsonBody = req.body as { dataBase64?: unknown; filename?: unknown };
          if (typeof jsonBody.dataBase64 !== 'string') {
            res.status(400).json({ error: 'Uploaded image file is empty.' });
            return;
          }
          buf = Buffer.from(jsonBody.dataBase64, 'base64');
          if (typeof jsonBody.filename === 'string') {
            bodyFilename = jsonBody.filename;
          }
        } else {
          res.status(400).json({ error: 'Uploaded image file is empty.' });
          return;
        }

        if (buf.length === 0) {
          res.status(400).json({ error: 'Uploaded image file is empty.' });
          return;
        }
        const rawName = String(req.query.filename || bodyFilename || 'overlay.png');
        const ext = path.extname(rawName).toLowerCase();
        const safeExt = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? ext : '.png';
        const storedFilename = `ovl_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${safeExt}`;
        await fs.mkdir(OVERLAYS_DIR, { recursive: true });
        await fs.writeFile(path.join(OVERLAYS_DIR, storedFilename), buf);
        res.json({
          filename: storedFilename,
          originalName: rawName,
          url: `/api/overlays/${storedFilename}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to save overlay image';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.get('/api/overlays/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename);
    const fullPath = path.join(OVERLAYS_DIR, safeName);
    if (!fsSync.existsSync(fullPath)) {
      res.status(404).json({ error: 'Overlay image not found.' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(fullPath);
  });

  // Batch Jobs routes
  app.get('/api/jobs', (_req, res) => {
    res.json({ jobs: listJobs() });
  });

  app.post('/api/jobs', async (req, res) => {
    try {
      const { movieId, config } = req.body as { movieId?: string; config?: BatchConfig };
      if (!movieId || !config) {
        res.status(400).json({ error: 'movieId and config are required.' });
        return;
      }

      if (
        config.quantityMode !== 'max' &&
        (config.requestedClipCount < 1 || config.requestedClipCount > MAX_CLIPS_PER_MOVIE)
      ) {
        res.status(400).json({
          error: `Clip count per movie must be between 1 and ${MAX_CLIPS_PER_MOVIE}.`,
        });
        return;
      }

      const needsOverlay =
        config.framingMode === 'video_top_image_bottom' ||
        config.framingMode === 'image_top_video_bottom' ||
        config.framingMode === 'picture_overlay_on_video';
      if (needsOverlay) {
        const safeOverlay = config.overlayImageFilename
          ? path.basename(config.overlayImageFilename)
          : '';
        if (!safeOverlay || !fsSync.existsSync(path.join(OVERLAYS_DIR, safeOverlay))) {
          res.status(400).json({
            error: 'Please upload a thumbnail/picture image first for the split Video + Image layout.',
          });
          return;
        }
      }

      const movie = getMovie(movieId);
      if (!movie) {
        res.status(404).json({ error: 'Movie not found.' });
        return;
      }

      const job = await createBatchJob(movie, config);
      res.status(201).json({ job });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start batch job';
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/jobs/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Batch job not found.' });
      return;
    }
    res.json({ job });
  });

  app.get('/api/jobs/:jobId/events', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Batch job not found.' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    res.write(`data: ${JSON.stringify(job)}\n\n`);

    const unsubscribe = subscribeToJob(req.params.jobId, (updatedJob) => {
      res.write(`data: ${JSON.stringify(updatedJob)}\n\n`);
    });

    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.post('/api/jobs/:jobId/pause', async (req, res) => {
    const job = await pauseJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Batch job not found.' });
      return;
    }
    res.json({ job });
  });

  app.post('/api/jobs/:jobId/resume', async (req, res) => {
    const job = await resumeJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Batch job not found.' });
      return;
    }
    res.json({ job });
  });

  app.post('/api/jobs/:jobId/cancel', async (req, res) => {
    const job = await cancelJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Batch job not found.' });
      return;
    }
    res.json({ job });
  });

  app.post('/api/jobs/:jobId/retry-failed', async (req, res) => {
    const job = await retryFailedClips(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Batch job not found.' });
      return;
    }
    res.json({ job });
  });

  app.patch('/api/jobs/:jobId/concurrency', async (req, res) => {
    const { workerConcurrency } = req.body as { workerConcurrency?: number };
    const job = await updateJobConcurrency(req.params.jobId, Number(workerConcurrency ?? 2));
    if (!job) {
      res.status(404).json({ error: 'Batch job not found.' });
      return;
    }
    res.json({ job });
  });

  app.delete('/api/jobs/:jobId', async (req, res) => {
    const deleted = await deleteJob(req.params.jobId);
    if (!deleted) {
      res.status(404).json({ error: 'Batch job not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  // Clip stream, thumbnail, individual download, and bulk ZIP download
  app.get('/api/jobs/:jobId/clips/:clipId/stream', (req, res) => {
    const job = getJob(req.params.jobId);
    const clip = job?.clips.find((c) => c.id === req.params.clipId);
    if (!clip?.outputPath) {
      res.status(404).json({ error: 'Clip file not available yet.' });
      return;
    }
    streamVideoWithRanges(req, res, clip.outputPath);
  });

  app.get('/api/jobs/:jobId/clips/:clipId/thumbnail', (req, res) => {
    const job = getJob(req.params.jobId);
    const clip = job?.clips.find((c) => c.id === req.params.clipId);
    if (!clip?.thumbnailPath || !fsSync.existsSync(clip.thumbnailPath)) {
      res.status(404).json({ error: 'Thumbnail not found.' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(clip.thumbnailPath);
  });

  app.get('/api/jobs/:jobId/clips/:clipId/download', (req, res) => {
    const job = getJob(req.params.jobId);
    const clip = job?.clips.find((c) => c.id === req.params.clipId);
    if (!clip?.outputPath || !fsSync.existsSync(clip.outputPath)) {
      res.status(404).json({ error: 'Clip file not available yet.' });
      return;
    }
    res.download(clip.outputPath, clip.outputFilename);
  });

  app.get('/api/jobs/:jobId/download-zip', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Batch job not found.' });
      return;
    }

    const completedClips = job.clips.filter(
      (c) => c.status === 'completed' && c.outputPath && fsSync.existsSync(c.outputPath)
    );

    if (completedClips.length === 0) {
      res.status(400).json({ error: 'No completed clips available to archive yet.' });
      return;
    }

    const safeTitle = job.movieTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 32) || 'movie';
    const zipFilename = `${safeTitle}_${completedClips.length}_clips.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    const archive = new ZipArchive({ zlib: { level: 1 } }); // Fast level 1 since MP4 is already compressed
    archive.on('error', (err: Error) => {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        res.end();
      }
    });

    archive.pipe(res);

    // Include manifest JSON summarizing all clips, timestamps, and AI descriptions
    const manifest = completedClips.map((c) => ({
      index: c.index,
      filename: c.outputFilename,
      title: c.title,
      category: c.category,
      startSeconds: c.startSeconds,
      endSeconds: c.endSeconds,
      durationSeconds: c.durationSeconds,
      resolution: c.actualWidth && c.actualHeight ? `${c.actualWidth}x${c.actualHeight}` : undefined,
      summary: c.summary,
      transcriptSnippet: c.transcriptSnippet,
    }));
    archive.append(JSON.stringify(manifest, null, 2), { name: 'clips_manifest.json' });

    for (const clip of completedClips) {
      if (clip.outputPath) {
        archive.file(clip.outputPath, { name: `clips/${clip.outputFilename}` });
      }
    }

    void archive.finalize();
  });

  // Helper: Resolve public origin from reverse proxy headers or Host header so external tools receive valid https:// URLs
  const getPublicBaseUrl = (req: express.Request): string => {
    const forwardedProto = req.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim();
    const forwardedHost = req.headers['x-forwarded-host']?.toString().split(',')[0]?.trim();
    const host = forwardedHost || req.get('host') || '';
    const proto = forwardedProto || req.protocol || 'http';
    if (host) {
      return `${proto}://${host}`;
    }
    const configuredUrl = process.env.PUBLIC_URL || process.env.APP_URL;
    if (configuredUrl && configuredUrl !== 'MY_APP_URL' && /^https?:\/\//i.test(configuredUrl)) {
      return configuredUrl.replace(/\/+$/, '');
    }
    return `http://localhost:${PORT}`;
  };

  const verifyVideoFeedAuth = (req: express.Request, res: express.Response): boolean => {
    const settings = getIntegrationSettings();
    if (!settings.feedEnabled) {
      res.status(503).json({ error: 'External video feed is paused in FrameSplit settings.' });
      return false;
    }
    if (!settings.authEnabled || !settings.apiKey) {
      return true;
    }

    const authHeader = (req.headers.authorization || '').trim();
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : authHeader;
    const xApiKey = (req.headers['x-api-key'] || '').toString().trim();
    const queryToken = (
      req.query.token ||
      req.query.apiKey ||
      req.query.key ||
      ''
    ).toString().trim();

    if (
      bearerToken === settings.apiKey ||
      xApiKey === settings.apiKey ||
      queryToken === settings.apiKey
    ) {
      return true;
    }

    res.status(401).json({
      error: 'Unauthorized. Provide Authorization: Bearer <API_KEY> or X-API-Key header.',
    });
    return false;
  };

  // Persistent Clip Library & External Integration Settings (Internal Studio UI)
  app.get('/api/library', (req, res) => {
    const aspectRatio = typeof req.query.aspectRatio === 'string' ? req.query.aspectRatio : undefined;
    const movieId = typeof req.query.movieId === 'string' ? req.query.movieId : undefined;
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
    const videos = listLibraryVideos({ aspectRatio, movieId, jobId });
    const totalOutputBytes = videos.reduce((acc, v) => acc + (v.fileSizeBytes || 0), 0);
    res.json({ videos, totalOutputBytes });
  });

  app.delete('/api/library/:videoId', async (req, res) => {
    const deleted = await deleteLibraryVideo(req.params.videoId);
    if (!deleted) {
      res.status(404).json({ error: 'Library video not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  app.get('/api/integration', (req, res) => {
    const settings = getIntegrationSettings();
    const baseUrl = getPublicBaseUrl(req);
    const envPublic =
      (process.env.PUBLIC_URL || process.env.APP_URL || '').trim();
    const suggestedPublicUrl =
      envPublic && envPublic !== 'MY_APP_URL' && /^https?:\/\//i.test(envPublic)
        ? envPublic.replace(/\/+$/, '')
        : baseUrl;
    res.json({
      settings,
      feedPath: '/api/videos',
      feedUrl: `${baseUrl}/api/videos`,
      suggestedPublicFeedUrl: `${suggestedPublicUrl}/api/videos`,
    });
  });

  app.put('/api/integration', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        feedEnabled?: boolean;
        authEnabled?: boolean;
        apiKey?: string;
        webhookUrl?: string;
        regenerateKey?: boolean;
      };
      const settings = await updateIntegrationSettings(body);
      res.json({ settings });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save integration settings';
      res.status(500).json({ error: msg });
    }
  });

  // External Video Feed API (/api/videos) for Gemini TikTok AutoPilot & external integrations
  app.get('/api/videos', (req, res) => {
    if (!verifyVideoFeedAuth(req, res)) return;

    const aspectRatio = typeof req.query.aspectRatio === 'string' ? req.query.aspectRatio : undefined;
    const movieId = typeof req.query.movieId === 'string' ? req.query.movieId : undefined;
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;

    const videos = listLibraryVideos({ aspectRatio, movieId, jobId, since, limit });
    const baseUrl = getPublicBaseUrl(req);
    const settings = getIntegrationSettings();
    const tokenForMedia =
      settings.authEnabled && settings.apiKey ? settings.apiKey : undefined;

    const feedItems = videos.map((v) => toVideoFeedItem(v, baseUrl, tokenForMedia));

    if (req.query.format === 'array') {
      res.json(feedItems);
      return;
    }

    res.json({
      ok: true,
      count: feedItems.length,
      total: feedItems.length,
      updatedAt: new Date().toISOString(),
      videos: feedItems,
    });
  });

  app.get('/api/videos/:videoId', (req, res) => {
    if (!verifyVideoFeedAuth(req, res)) return;
    const video = getLibraryVideo(req.params.videoId);
    if (!video || !fsSync.existsSync(video.filePath)) {
      res.status(404).json({ error: 'Video not found in library.' });
      return;
    }
    const baseUrl = getPublicBaseUrl(req);
    const settings = getIntegrationSettings();
    const tokenForMedia =
      settings.authEnabled && settings.apiKey ? settings.apiKey : undefined;
    res.json({
      ok: true,
      video: toVideoFeedItem(video, baseUrl, tokenForMedia),
    });
  });

  app.get('/api/videos/:videoId/stream', (req, res) => {
    if (!verifyVideoFeedAuth(req, res)) return;
    const video = getLibraryVideo(req.params.videoId);
    if (!video || !fsSync.existsSync(video.filePath)) {
      res.status(404).json({ error: 'Video file not found in library.' });
      return;
    }
    streamVideoWithRanges(req, res, video.filePath, 'video/mp4');
  });

  app.get('/api/videos/:videoId/download', (req, res) => {
    if (!verifyVideoFeedAuth(req, res)) return;
    const video = getLibraryVideo(req.params.videoId);
    if (!video || !fsSync.existsSync(video.filePath)) {
      res.status(404).json({ error: 'Video file not found in library.' });
      return;
    }
    res.download(video.filePath, video.filename);
  });

  app.get('/api/videos/:videoId/thumbnail', (req, res) => {
    if (!verifyVideoFeedAuth(req, res)) return;
    const video = getLibraryVideo(req.params.videoId);
    if (!video?.thumbnailPath || !fsSync.existsSync(video.thumbnailPath)) {
      res.status(404).json({ error: 'Thumbnail not found.' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(video.thumbnailPath);
  });

  app.delete('/api/videos/:videoId', async (req, res) => {
    const deleted = await deleteLibraryVideo(req.params.videoId);
    if (!deleted) {
      res.status(404).json({ error: 'Video not found in library.' });
      return;
    }
    res.json({ deleted: true });
  });

  // External Auto-Watch & TikTok Auto-Clip Pipeline Routes
  app.get('/api/watch/status', (req, res) => {
    const baseUrl = getPublicBaseUrl(req);
    res.json(getWatchStatus(baseUrl));
  });

  app.put('/api/watch/config', async (req, res) => {
    try {
      const status = await updateWatchConfig(req.body ?? {});
      const baseUrl = getPublicBaseUrl(req);
      res.json({ ...status, ...getWatchStatus(baseUrl) });
    } catch (err) {
      const statusCode = err instanceof WatchLockedError ? err.statusCode : 500;
      const msg = err instanceof Error ? err.message : 'Failed to update Auto-Watch config';
      res.status(statusCode).json({ error: msg });
    }
  });

  app.post('/api/watch/switch', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { enabled?: boolean; switchLocked?: boolean };
      const baseUrl = getPublicBaseUrl(req);
      const status = await setWatchSwitch(
        {
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
          switchLocked: typeof body.switchLocked === 'boolean' ? body.switchLocked : undefined,
        },
        baseUrl
      );
      res.json(status);
    } catch (err) {
      const statusCode = err instanceof WatchLockedError ? err.statusCode : 500;
      const msg = err instanceof Error ? err.message : 'Failed to toggle Auto-Run switch';
      res.status(statusCode).json({ error: msg });
    }
  });

  app.post('/api/watch/clear', async (req, res) => {
    try {
      const baseUrl = getPublicBaseUrl(req);
      const status = await clearWatchItems(baseUrl);
      res.json(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to clear detected videos';
      res.status(500).json({ error: msg });
    }
  });

  app.delete('/api/watch/items', async (req, res) => {
    try {
      const baseUrl = getPublicBaseUrl(req);
      const status = await clearWatchItems(baseUrl);
      res.json(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to clear detected videos';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/watch/check-now', (req, res) => {
    triggerWatchCheckNow();
    const baseUrl = getPublicBaseUrl(req);
    res.json(getWatchStatus(baseUrl));
  });

  app.post('/api/watch/ping', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        eventsUrl?: string;
        authHeaderName?: string;
        authToken?: string;
      };
      const ping = await pingWatchConnection({
        eventsUrl: typeof body.eventsUrl === 'string' ? body.eventsUrl : undefined,
        authHeaderName: typeof body.authHeaderName === 'string' ? body.authHeaderName : undefined,
        authToken: typeof body.authToken === 'string' ? body.authToken : undefined,
      });
      res.json({ ping });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ping failed';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/watch/connect', async (req, res) => {
    try {
      const baseUrl = getPublicBaseUrl(req);
      const result = await connectWatchSource(req.body ?? {}, baseUrl);
      res.json(result);
    } catch (err) {
      const statusCode = err instanceof WatchLockedError ? err.statusCode : 500;
      const msg = err instanceof Error ? err.message : 'Failed to connect watch source';
      res.status(statusCode).json({ error: msg });
    }
  });

  app.post('/api/watch/fetch', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        eventsUrl?: string;
        authHeaderName?: string;
        authToken?: string;
      };
      const result = await fetchExternalVideos({
        eventsUrl: typeof body.eventsUrl === 'string' ? body.eventsUrl : undefined,
        authHeaderName: typeof body.authHeaderName === 'string' ? body.authHeaderName : undefined,
        authToken: typeof body.authToken === 'string' ? body.authToken : undefined,
      });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch available videos';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/watch/ingest', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        url?: string;
        videoUrl?: string;
        fallbackUrls?: string[];
        title?: string;
        movieId?: string;
        force?: boolean;
      };
      const items = await ingestWatchPayload({
        url: body.url,
        videoUrl: body.videoUrl,
        fallbackUrls: Array.isArray(body.fallbackUrls) ? body.fallbackUrls : undefined,
        title: body.title,
        movieId: body.movieId,
        force: body.force,
        rawPayload: body,
      });
      res.status(202).json({
        ok: true,
        queuedCount: items.length,
        items,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to ingest video for auto-clipping';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/watch/retry/:itemId', async (req, res) => {
    try {
      const item = await retryWatchItem(req.params.itemId);
      res.status(202).json({ ok: true, item });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to retry item';
      res.status(404).json({ error: msg });
    }
  });

  app.post('/api/watch/retry-failed', async (_req, res) => {
    try {
      const items = await retryFailedWatchItems();
      res.status(202).json({ ok: true, queuedCount: items.length, items });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to retry failed items';
      res.status(500).json({ error: msg });
    }
  });

  // Ensure unknown API routes always return JSON 404 rather than HTML SPA fallback
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Vite dev middleware vs static production serving
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use('/assets', express.static(path.join(distDir, 'assets'), { maxAge: '1y', immutable: true }));
    app.use(express.static(distDir, { maxAge: '5m' }));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`FrameSplit server listening on http://localhost:${PORT}`);
  });
  // Disable Node's default 5-min request timeout so multi-GB uploads, ZIP exports, and long streams never abort
  server.requestTimeout = 0;
  server.headersTimeout = 120000;
  server.keepAliveTimeout = 65000;
}

void startServer();

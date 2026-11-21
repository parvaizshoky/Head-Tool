import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_CLIPS_PER_MOVIE,
  computeMaxNonOverlappingClips,
} from '../src/types/clipper.ts';
import type {
  AnalysisChunk,
  BatchConfig,
  BatchJob,
  DetectedMoment,
  GeneratedClip,
  MovieMetadata,
} from '../src/types/clipper.ts';
import { distributeClipsAcrossMovie } from './distributor.ts';
import {
  applyFaststartPreview,
  detectSceneCutsInChunk,
  extractAnalysisChunk,
  generateBrowserPreviewMp4,
  isBrowserNativeMovie,
  isMp4FaststartReady,
  renderClipWithThumbnail,
} from './ffmpeg.ts';
import { analyzeMovieChunkWithGemini } from './gemini.ts';
import { initializeLibrary, saveClipToLibrary } from './library.ts';

export const STORAGE_ROOT = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.resolve(process.cwd(), 'storage');
export const MOVIES_DIR = path.join(STORAGE_ROOT, 'movies');
export const OVERLAYS_DIR = path.join(STORAGE_ROOT, 'overlays');
export const UPLOADS_TMP_DIR = path.join(STORAGE_ROOT, 'uploads_tmp');
export const JOBS_DIR = path.join(STORAGE_ROOT, 'jobs');
const MOVIES_INDEX_PATH = path.join(STORAGE_ROOT, 'movies.json');

const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(100);

const moviesMap = new Map<string, MovieMetadata>();
const jobsMap = new Map<string, BatchJob>();
const jobSceneCutsMap = new Map<string, number[]>();
const activeRunners = new Set<string>();
const controlFlags = new Map<string, { paused: boolean; cancelled: boolean }>();

async function ensureDirs(): Promise<void> {
  await fs.mkdir(STORAGE_ROOT, { recursive: true });
  await fs.mkdir(MOVIES_DIR, { recursive: true });
  await fs.mkdir(OVERLAYS_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_TMP_DIR, { recursive: true });
  await fs.mkdir(JOBS_DIR, { recursive: true });
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

let moviesPersistQueue: Promise<void> = Promise.resolve();

async function persistMoviesIndex(): Promise<void> {
  const next = moviesPersistQueue
    .catch(() => undefined)
    .then(async () => {
      await atomicWriteJson(MOVIES_INDEX_PATH, Array.from(moviesMap.values()));
    });
  moviesPersistQueue = next;
  await next;
}

const persistQueues = new Map<string, Promise<void>>();

async function persistJob(job: BatchJob): Promise<void> {
  if (!jobsMap.has(job.id)) return;
  job.updatedAt = new Date().toISOString();
  recomputeJobStats(job);
  jobEvents.emit(`job:${job.id}`, job);

  const prev = persistQueues.get(job.id) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      if (!jobsMap.has(job.id)) return;
      const jobPath = path.join(JOBS_DIR, job.id, 'job.json');
      await atomicWriteJson(jobPath, job);
    });
  persistQueues.set(job.id, next);
  await next;
}

export function subscribeToJob(jobId: string, listener: (job: BatchJob) => void): () => void {
  const eventName = `job:${jobId}`;
  jobEvents.on(eventName, listener);
  return () => {
    jobEvents.off(eventName, listener);
  };
}

export function recomputeJobStats(job: BatchJob): void {
  const totalChunks = job.chunks.length;
  const analyzedChunks = job.chunks.filter(
    (c) => c.status === 'completed' || c.status === 'failed'
  ).length;
  const analysisPercent =
    totalChunks > 0 ? Math.round((analyzedChunks / totalChunks) * 100) : 0;

  const totalClips = job.clips.length;
  const completed = job.clips.filter((c) => c.status === 'completed').length;
  const processing = job.clips.filter((c) => c.status === 'processing').length;
  const failed = job.clips.filter((c) => c.status === 'failed').length;
  const queued = job.clips.filter((c) => c.status === 'queued').length;
  const remaining = queued + processing;

  const totalRequested =
    totalClips > 0
      ? totalClips
      : job.config.quantityMode === 'max'
        ? computeMaxNonOverlappingClips(
            job.movieDurationSeconds,
            job.config.clipDurationSeconds
          )
        : Math.min(MAX_CLIPS_PER_MOVIE, Math.max(1, job.config.requestedClipCount));

  const renderPercent =
    totalClips > 0 ? Math.round(((completed + failed) / totalClips) * 100) : 0;

  let progressPercent = 0;
  if (job.phase === 'completed') {
    progressPercent = 100;
  } else if (job.phase === 'analyzing' || job.phase === 'chunking') {
    progressPercent = Math.round(analysisPercent * 0.25);
  } else if (job.phase === 'distributing') {
    progressPercent = 25;
  } else {
    progressPercent = Math.min(99, Math.round(25 + renderPercent * 0.75));
  }

  const totalOutputBytes = job.clips.reduce(
    (acc, clip) => acc + (clip.fileSizeBytes ?? 0),
    0
  );

  job.stats = {
    totalRequested,
    completed,
    processing,
    failed,
    remaining,
    progressPercent,
    analyzedChunks,
    totalChunks,
    analysisPercent,
    renderPercent,
    totalOutputBytes,
  };
}

export async function initializeStorage(): Promise<void> {
  await ensureDirs();

  try {
    const rawMovies = await fs.readFile(MOVIES_INDEX_PATH, 'utf8');
    const parsed = JSON.parse(rawMovies) as MovieMetadata[];
    for (const m of parsed) {
      try {
        await fs.access(m.filePath);
        moviesMap.set(m.id, m);
      } catch {
        // Movie file missing from disk, skip
      }
    }
  } catch {
    // No movies.json yet
  }

  try {
    const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jobFile = path.join(JOBS_DIR, entry.name, 'job.json');
      try {
        const raw = await fs.readFile(jobFile, 'utf8');
        const job = JSON.parse(raw) as BatchJob;

        // Recover any interrupted in-progress tasks cleanly to paused/queued state
        let modified = false;
        for (const chunk of job.chunks) {
          if (chunk.status === 'extracting' || chunk.status === 'analyzing') {
            chunk.status = 'pending';
            modified = true;
          }
        }
        for (const clip of job.clips) {
          if (clip.status === 'processing') {
            clip.status = 'queued';
            modified = true;
          }
        }
        if (
          job.phase === 'analyzing' ||
          job.phase === 'chunking' ||
          job.phase === 'distributing' ||
          job.phase === 'rendering'
        ) {
          job.phase = 'paused';
          job.statusMessage = 'Paused after server restart. Click Resume to continue.';
          modified = true;
        }
        recomputeJobStats(job);
        jobsMap.set(job.id, job);
        if (modified) {
          await atomicWriteJson(jobFile, job);
        }
      } catch {
        // Skip invalid job folder
      }
    }
  } catch {
    // No jobs dir yet
  }

  // Clean up orphaned temporary upload fragments older than 24 hours
  try {
    const tmpEntries = await fs.readdir(UPLOADS_TMP_DIR, { withFileTypes: true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of tmpEntries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(UPLOADS_TMP_DIR, entry.name);
      const st = await fs.stat(fullPath).catch(() => null);
      if (st && st.mtimeMs < cutoff) {
        await fs.unlink(fullPath).catch(() => undefined);
      }
    }
  } catch {
    // Ignore tmp cleanup error
  }

  await initializeLibrary(Array.from(jobsMap.values()));
}

export function listMovies(): MovieMetadata[] {
  return Array.from(moviesMap.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function getMovie(movieId: string): MovieMetadata | undefined {
  return moviesMap.get(movieId);
}

export async function registerMovie(movie: MovieMetadata): Promise<MovieMetadata> {
  moviesMap.set(movie.id, movie);
  await persistMoviesIndex();
  return movie;
}

export async function prepareAndRegisterMovie(metadata: MovieMetadata): Promise<MovieMetadata> {
  const ext = path.extname(metadata.filePath).toLowerCase();
  if (isBrowserNativeMovie(metadata)) {
    if (ext === '.mp4' || ext === '.m4v') {
      const faststartReady = await isMp4FaststartReady(metadata.filePath);
      if (!faststartReady) {
        const previewPath = path.join(MOVIES_DIR, `${metadata.id}_preview.mp4`);
        await registerMovie(metadata);
        // Generate faststart copy in background so /complete responds immediately without reverse-proxy timeouts
        void applyFaststartPreview(metadata.filePath, previewPath)
          .then(async () => {
            const current = getMovie(metadata.id);
            if (current) {
              current.previewPath = previewPath;
              current.previewStatus = 'ready';
              await registerMovie(current);
            } else {
              await fs.unlink(previewPath).catch(() => undefined);
            }
          })
          .catch(async () => {
            await fs.unlink(previewPath).catch(() => undefined);
          });
        return metadata;
      }
    }
    return registerMovie(metadata);
  }

  const previewPath = path.join(MOVIES_DIR, `${metadata.id}_preview.mp4`);
  metadata.previewPath = previewPath;
  if (metadata.fileSizeBytes <= 8 * 1024 * 1024) {
    try {
      await generateBrowserPreviewMp4(metadata.filePath, previewPath, metadata.hasAudio);
      metadata.previewStatus = 'ready';
    } catch {
      metadata.previewPath = undefined;
    }
    return registerMovie(metadata);
  }

  metadata.previewStatus = 'preparing';
  await registerMovie(metadata);
  void generateBrowserPreviewMp4(metadata.filePath, previewPath, metadata.hasAudio)
    .then(async () => {
      const current = getMovie(metadata.id);
      if (current) {
        current.previewStatus = 'ready';
        await registerMovie(current);
      } else {
        await fs.unlink(previewPath).catch(() => undefined);
      }
    })
    .catch(async () => {
      await fs.unlink(previewPath).catch(() => undefined);
      const current = getMovie(metadata.id);
      if (current) {
        current.previewStatus = undefined;
        current.previewPath = undefined;
        await registerMovie(current);
      }
    });
  return metadata;
}

export async function removeMovie(movieId: string): Promise<boolean> {
  const movie = moviesMap.get(movieId);
  if (!movie) return false;
  moviesMap.delete(movieId);
  await persistMoviesIndex();
  await fs.unlink(movie.filePath).catch(() => undefined);
  if (movie.previewPath) {
    await fs.unlink(movie.previewPath).catch(() => undefined);
  }
  return true;
}

export function listJobs(): BatchJob[] {
  return Array.from(jobsMap.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function getJob(jobId: string): BatchJob | undefined {
  return jobsMap.get(jobId);
}

export async function deleteJob(jobId: string): Promise<boolean> {
  const job = jobsMap.get(jobId);
  if (!job) return false;
  controlFlags.set(jobId, { paused: false, cancelled: true });
  jobsMap.delete(jobId);
  jobSceneCutsMap.delete(jobId);
  const jobDir = path.join(JOBS_DIR, jobId);
  await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

function buildChunks(durationSeconds: number): AnalysisChunk[] {
  let chunkDuration = 300;
  if (durationSeconds <= 900) {
    chunkDuration = Math.max(1, durationSeconds);
  } else if (durationSeconds <= 1800) {
    chunkDuration = Math.max(300, Math.ceil(durationSeconds / 3));
  } else {
    chunkDuration = Math.min(900, Math.max(300, Math.ceil(durationSeconds / 10)));
  }

  const chunks: AnalysisChunk[] = [];
  let index = 0;
  for (let start = 0; start < durationSeconds - 0.5; start += chunkDuration) {
    const end = Math.min(durationSeconds, start + chunkDuration);
    const actualDur = Math.max(1, end - start);
    chunks.push({
      index,
      startSeconds: Math.round(start * 100) / 100,
      endSeconds: Math.round(end * 100) / 100,
      durationSeconds: Math.round(actualDur * 100) / 100,
      status: 'pending',
      momentsFound: 0,
      attempts: 0,
    });
    index += 1;
  }

  if (chunks.length === 0) {
    chunks.push({
      index: 0,
      startSeconds: 0,
      endSeconds: durationSeconds,
      durationSeconds,
      status: 'pending',
      momentsFound: 0,
      attempts: 0,
    });
  }

  return chunks;
}

export async function createBatchJob(movie: MovieMetadata, config: BatchConfig): Promise<BatchJob> {
  const jobId = `job_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const chunks = buildChunks(movie.durationSeconds);
  const analysisMode: 'fast' | 'ai' = config.analysisMode === 'ai' ? 'ai' : 'fast';

  const job: BatchJob = {
    id: jobId,
    movieId: movie.id,
    movieTitle: movie.title,
    movieDurationSeconds: movie.durationSeconds,
    movieWidth: movie.width,
    movieHeight: movie.height,
    config: {
      ...config,
      analysisMode,
      aspectRatio: config.aspectRatio ?? 'source',
      framingMode: config.framingMode ?? 'fit_blur',
      overlayImageFilename: config.overlayImageFilename
        ? path.basename(config.overlayImageFilename)
        : undefined,
      overlayPlacement: config.overlayPlacement
        ? {
            xPct: Math.max(-150, Math.min(150, Number(config.overlayPlacement.xPct ?? 0))),
            yPct: Math.max(-150, Math.min(150, Number(config.overlayPlacement.yPct ?? 0))),
            widthPct: Math.max(10, Math.min(250, Number(config.overlayPlacement.widthPct ?? 100))),
            heightPct: Math.max(10, Math.min(250, Number(config.overlayPlacement.heightPct ?? 100))),
            lockAspect: Boolean(config.overlayPlacement.lockAspect ?? true),
          }
        : undefined,
      videoPlacement: config.videoPlacement
        ? {
            xPct: Math.max(-150, Math.min(150, Number(config.videoPlacement.xPct ?? 0))),
            yPct: Math.max(-150, Math.min(150, Number(config.videoPlacement.yPct ?? 0))),
            widthPct: Math.max(10, Math.min(250, Number(config.videoPlacement.widthPct ?? 100))),
            heightPct: Math.max(10, Math.min(250, Number(config.videoPlacement.heightPct ?? 100))),
            lockAspect: Boolean(config.videoPlacement.lockAspect ?? true),
          }
        : undefined,
      overlayBackdrop: config.overlayBackdrop ?? 'fit_blur',
      videoSplitPercent: Math.max(30, Math.min(75, Math.round(config.videoSplitPercent ?? 50))),
      splitMediaFit: config.splitMediaFit ?? 'fit',
      playbackSpeed: Math.max(0.5, Math.min(2.0, Number(config.playbackSpeed ?? 1))),
      requestedClipCount: Math.min(
        MAX_CLIPS_PER_MOVIE,
        Math.max(1, Math.round(config.requestedClipCount || 1))
      ),
      workerConcurrency: Math.max(1, Math.min(6, Math.round(config.workerConcurrency || 3))),
      maxRetries: Math.max(0, Math.min(5, Math.round(config.maxRetries ?? 2))),
      clipDurationSeconds: Math.max(2, Math.min(movie.durationSeconds, Math.round(config.clipDurationSeconds || 30))),
    },
    phase: 'queued',
    statusMessage:
      analysisMode === 'fast'
        ? 'Instant Fast Mode queued: preparing timeline clips...'
        : `Queued ${chunks.length} timeline segments for full-movie Gemini analysis`,
    chunks,
    moments: [],
    clips: [],
    stats: {
      totalRequested: config.requestedClipCount,
      completed: 0,
      processing: 0,
      failed: 0,
      remaining: config.requestedClipCount,
      progressPercent: 0,
      analyzedChunks: 0,
      totalChunks: chunks.length,
      analysisPercent: 0,
      renderPercent: 0,
      totalOutputBytes: 0,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  recomputeJobStats(job);
  jobsMap.set(jobId, job);
  controlFlags.set(jobId, { paused: false, cancelled: false });
  await persistJob(job);

  // Kick off background worker pipeline asynchronously
  void runJobPipeline(jobId);

  return job;
}

export async function pauseJob(jobId: string): Promise<BatchJob | undefined> {
  const job = jobsMap.get(jobId);
  if (!job) return undefined;
  const flags = controlFlags.get(jobId) ?? { paused: false, cancelled: false };
  flags.paused = true;
  controlFlags.set(jobId, flags);
  job.phase = 'paused';
  job.statusMessage = 'Batch paused by user. Active tasks will settle safely.';
  await persistJob(job);
  return job;
}

export async function resumeJob(jobId: string): Promise<BatchJob | undefined> {
  const job = jobsMap.get(jobId);
  if (!job) return undefined;
  const flags = controlFlags.get(jobId) ?? { paused: false, cancelled: false };
  flags.paused = false;
  flags.cancelled = false;
  controlFlags.set(jobId, flags);

  const hasPendingChunks = job.chunks.some((c) => c.status === 'pending' || c.status === 'failed');
  job.phase = job.clips.length === 0 || hasPendingChunks ? 'analyzing' : 'rendering';
  job.statusMessage = 'Resuming background batch workers...';
  await persistJob(job);

  void runJobPipeline(jobId);
  return job;
}

export async function cancelJob(jobId: string): Promise<BatchJob | undefined> {
  const job = jobsMap.get(jobId);
  if (!job) return undefined;
  const flags = controlFlags.get(jobId) ?? { paused: false, cancelled: false };
  flags.cancelled = true;
  controlFlags.set(jobId, flags);
  job.phase = 'cancelled';
  job.statusMessage = 'Batch cancelled.';
  await persistJob(job);
  return job;
}

export async function retryFailedClips(jobId: string): Promise<BatchJob | undefined> {
  const job = jobsMap.get(jobId);
  if (!job) return undefined;

  let requeuedCount = 0;
  for (const clip of job.clips) {
    if (clip.status === 'failed') {
      clip.status = 'queued';
      clip.error = undefined;
      requeuedCount += 1;
    }
  }

  for (const chunk of job.chunks) {
    if (chunk.status === 'failed') {
      chunk.status = 'pending';
      chunk.error = undefined;
    }
  }

  if (requeuedCount > 0 || job.chunks.some((c) => c.status === 'pending')) {
    const flags = controlFlags.get(jobId) ?? { paused: false, cancelled: false };
    flags.paused = false;
    flags.cancelled = false;
    controlFlags.set(jobId, flags);
    job.phase = job.clips.length === 0 ? 'analyzing' : 'rendering';
    job.statusMessage = `Re-queued ${requeuedCount} failed clips for rendering.`;
    await persistJob(job);
    void runJobPipeline(jobId);
  }

  return job;
}

export async function updateJobConcurrency(jobId: string, concurrency: number): Promise<BatchJob | undefined> {
  const job = jobsMap.get(jobId);
  if (!job) return undefined;
  job.config.workerConcurrency = Math.max(1, Math.min(6, Math.round(concurrency)));
  await persistJob(job);
  return job;
}

function shouldStop(jobId: string): boolean {
  const flags = controlFlags.get(jobId);
  return Boolean(flags?.paused || flags?.cancelled);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runJobPipeline(jobId: string): Promise<void> {
  if (activeRunners.has(jobId)) return;
  activeRunners.add(jobId);

  try {
    const job = jobsMap.get(jobId);
    if (!job) return;
    const movie = moviesMap.get(job.movieId);
    if (!movie) {
      job.phase = 'failed';
      job.error = 'Source movie file is no longer available on disk.';
      job.statusMessage = job.error;
      await persistJob(job);
      return;
    }

    const jobDir = path.join(JOBS_DIR, job.id);
    const chunksDir = path.join(jobDir, 'chunks');
    const clipsDir = path.join(jobDir, 'clips');
    const thumbsDir = path.join(jobDir, 'thumbs');
    await fs.mkdir(chunksDir, { recursive: true });
    await fs.mkdir(clipsDir, { recursive: true });
    await fs.mkdir(thumbsDir, { recursive: true });

    // PHASE 1: Chunked Full-Movie Analysis (skipped cleanly in Instant Fast Mode or when Gemini key is absent)
    const pendingChunks = job.chunks.filter((c) => c.status === 'pending');
    const requestedMode = job.config.analysisMode ?? 'fast';
    const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY?.trim());
    const useInstantMode = requestedMode === 'fast' || !hasGeminiKey;

    if (pendingChunks.length > 0 && !shouldStop(jobId) && useInstantMode) {
      for (const chunk of pendingChunks) {
        chunk.status = 'completed';
        chunk.momentsFound = 0;
        chunk.error = undefined;
      }
      job.statusMessage =
        requestedMode === 'ai' && !hasGeminiKey
          ? 'Instant timeline mode active (GEMINI_API_KEY not configured). Rendering clips immediately...'
          : 'Instant Fast Mode: jumping straight to parallel clip rendering...';
      await persistJob(job);
    } else if (pendingChunks.length > 0 && !shouldStop(jobId)) {
      job.phase = 'analyzing';
      job.statusMessage = `Analyzing full movie across ${job.chunks.length} chronological chunks with Gemini AI...`;
      await persistJob(job);

      const sceneCuts = jobSceneCutsMap.get(job.id) ?? [];
      const maxDesiredTotal =
        job.config.quantityMode === 'max'
          ? computeMaxNonOverlappingClips(movie.durationSeconds, job.config.clipDurationSeconds)
          : job.config.requestedClipCount;
      const targetMomentsPerChunk = Math.max(
        6,
        Math.min(28, Math.ceil((maxDesiredTotal * 1.4) / Math.max(1, job.chunks.length)))
      );

      // Process 3 chunks concurrently for faster full-movie analysis
      const analysisConcurrency = 3;
      let nextChunkCursor = 0;

      const analyzeWorker = async () => {
        while (!shouldStop(jobId)) {
          const chunk = pendingChunks[nextChunkCursor];
          nextChunkCursor += 1;
          if (!chunk) break;

          const chunkFile = path.join(chunksDir, `chunk_${String(chunk.index).padStart(4, '0')}.mp4`);
          chunk.status = 'extracting';
          chunk.attempts += 1;
          await persistJob(job);

          try {
            await extractAnalysisChunk(
              movie.filePath,
              chunkFile,
              chunk.startSeconds,
              chunk.durationSeconds,
              movie.hasAudio
            );

            if (shouldStop(jobId)) break;

            chunk.status = 'analyzing';
            job.statusMessage = `Gemini analyzing segment ${chunk.index + 1}/${job.chunks.length} (${Math.round((chunk.endSeconds / movie.durationSeconds) * 100)}% of movie)...`;
            await persistJob(job);

            // Run FFmpeg scene-cut detection + Gemini analysis in parallel on the proxy chunk
            const [cuts, geminiMoments] = await Promise.all([
              detectSceneCutsInChunk(chunkFile, chunk.startSeconds),
              analyzeChunkWithRetries({
                chunkPath: chunkFile,
                chunkIndex: chunk.index,
                totalChunks: job.chunks.length,
                chunkStartSeconds: chunk.startSeconds,
                chunkDurationSeconds: chunk.durationSeconds,
                totalMovieDurationSeconds: movie.durationSeconds,
                targetMomentsPerChunk,
                focusCategories: job.config.focusCategories,
                maxRetries: job.config.maxRetries,
              }),
            ]);

            sceneCuts.push(...cuts);
            jobSceneCutsMap.set(job.id, sceneCuts);

            // Replace any previous moments for this chunk (in case of retry)
            job.moments = job.moments
              .filter((m) => m.chunkIndex !== chunk.index)
              .concat(geminiMoments);

            chunk.momentsFound = geminiMoments.length;
            chunk.status = 'completed';
            chunk.error = undefined;
            await persistJob(job);
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Chunk analysis failed';
            chunk.status = 'failed';
            chunk.error = msg;
            // Record any fatal API key / permission error clearly on the job while continuing scene-cut fallback
            if (msg.includes('GEMINI_API_KEY') || msg.includes('PERMISSION_DENIED') || msg.includes('API_KEY_INVALID') || msg.includes('403')) {
              job.error = msg;
            }
            const fallbackCuts = await detectSceneCutsInChunk(chunkFile, chunk.startSeconds).catch(() => []);
            sceneCuts.push(...fallbackCuts);
            jobSceneCutsMap.set(job.id, sceneCuts);
            await persistJob(job);
          } finally {
            await fs.unlink(chunkFile).catch(() => undefined);
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(analysisConcurrency, pendingChunks.length) }, () => analyzeWorker())
      );

      if (shouldStop(jobId)) return;

      // If Gemini failed on all chunks, gracefully fall back to FFmpeg scene-cut + timeline moments
      // so uploaded videos ALWAYS generate clips cleanly.
      const allChunksFailed = job.chunks.every((c) => c.status === 'failed');
      if (allChunksFailed && job.moments.length === 0) {
        const firstErr = job.chunks.find((c) => c.error)?.error ?? 'Gemini analysis unavailable';
        const fallbackMoments: DetectedMoment[] = [];
        const uniqueCuts = Array.from(new Set(sceneCuts)).sort((a, b) => a - b);

        for (let i = 0; i < uniqueCuts.length; i += 1) {
          const ts = uniqueCuts[i];
          const cIdx = Math.min(
            job.chunks.length - 1,
            Math.floor((ts / Math.max(1, movie.durationSeconds)) * job.chunks.length)
          );
          fallbackMoments.push({
            id: `cut-${i}-${Math.round(ts)}`,
            chunkIndex: cIdx,
            startSeconds: Math.max(0, ts - 2),
            endSeconds: Math.min(movie.durationSeconds, ts + job.config.clipDurationSeconds),
            peakSeconds: ts,
            title: `Scene Transition #${i + 1}`,
            category: 'scene',
            summary: `Visual scene cut detected at ${Math.floor(ts)}s.`,
            score: 75,
            source: 'ffmpeg_scene',
          });
        }

        job.moments.push(...fallbackMoments);
        job.error = `AI metadata fallback active (${firstErr}). Clips are still being extracted across the full timeline via FFmpeg.`;
        await persistJob(job);
      }
    }

    if (shouldStop(jobId)) return;

    // PHASE 2: Smart Full-Movie Clip Distribution
    if (job.clips.length === 0) {
      const durLabel =
        movie.durationSeconds >= 60
          ? `${Math.round(movie.durationSeconds / 60)}m`
          : `${Math.round(movie.durationSeconds)}s`;
      job.phase = 'distributing';
      job.statusMessage = `Distributing clips evenly across the full ${durLabel} timeline...`;
      await persistJob(job);

      const cuts = jobSceneCutsMap.get(job.id) ?? [];
      const distributedClips = distributeClipsAcrossMovie({
        totalDurationSeconds: movie.durationSeconds,
        movieTitle: movie.title,
        moments: job.moments,
        sceneCutTimestamps: cuts,
        chunkCount: job.chunks.length,
        config: job.config,
      });

      job.clips = distributedClips;
      job.statusMessage = `Scheduled ${distributedClips.length} clips across 100% of the movie. Starting FFmpeg workers...`;
      await persistJob(job);
    }

    if (shouldStop(jobId)) return;

    // PHASE 3: Parallel Background FFmpeg Rendering Queue with Retry Mechanism
    job.phase = 'rendering';
    job.statusMessage = `Rendering ${job.clips.filter((c) => c.status === 'queued').length} clips via FFmpeg background queue...`;
    await persistJob(job);

    // Spawn worker slots respecting current concurrency (checks dynamic updates mid-batch)
    const activeSlots = new Set<Promise<void>>();
    while (!shouldStop(jobId)) {
      const hasQueued = job.clips.some((c) => c.status === 'queued');
      if (!hasQueued && activeSlots.size === 0) {
        break;
      }

      const desiredConcurrency = Math.max(1, Math.min(6, job.config.workerConcurrency));
      while (
        job.clips.some((c) => c.status === 'queued') &&
        activeSlots.size < desiredConcurrency &&
        !shouldStop(jobId)
      ) {
        const slot = (async () => {
          await renderSingleQueuedClip(jobId, job, movie, clipsDir, thumbsDir);
        })();
        activeSlots.add(slot);
        slot.finally(() => activeSlots.delete(slot));
      }

      if (activeSlots.size > 0) {
        await Promise.race(activeSlots);
      } else {
        await sleep(150);
      }
    }

    if (shouldStop(jobId)) return;

    // Wait for any remaining active slots
    await Promise.all(activeSlots);

    const failedClips = job.clips.filter((c) => c.status === 'failed').length;
    const completedClips = job.clips.filter((c) => c.status === 'completed').length;

    job.phase = 'completed';
    job.completedAt = new Date().toISOString();
    job.statusMessage =
      failedClips > 0
        ? `Batch finished: ${completedClips} clips ready, ${failedClips} failed.`
        : `All ${completedClips} clips generated across the full movie and ready for download.`;
    await persistJob(job);
  } finally {
    activeRunners.delete(jobId);
  }
}

async function renderSingleQueuedClip(
  jobId: string,
  job: BatchJob,
  movie: MovieMetadata,
  clipsDir: string,
  thumbsDir: string
): Promise<void> {
  if (shouldStop(jobId)) return;
  const nextClip = job.clips.find((c) => c.status === 'queued');
  if (!nextClip) return;

  nextClip.status = 'processing';
  nextClip.attempts += 1;
  await persistJob(job);

  const outputPath = path.join(clipsDir, nextClip.outputFilename);
  const thumbnailPath = path.join(thumbsDir, `${nextClip.id}.jpg`);

  const overlayImagePath = job.config.overlayImageFilename
    ? path.join(OVERLAYS_DIR, path.basename(job.config.overlayImageFilename))
    : undefined;

  const ffmpegThreads = job.config.workerConcurrency >= 2 ? 2 : 0;

  try {
    let result;
    try {
      result = await renderClipWithThumbnail({
        moviePath: movie.filePath,
        outputPath,
        thumbnailPath,
        startSeconds: nextClip.startSeconds,
        durationSeconds: nextClip.durationSeconds,
        qualityTier: job.config.qualityTier,
        aspectRatio: job.config.aspectRatio ?? 'source',
        framingMode: job.config.framingMode ?? 'fit_blur',
        overlayImagePath,
        overlayPlacement: job.config.overlayPlacement,
        videoPlacement: job.config.videoPlacement,
        overlayBackdrop: job.config.overlayBackdrop ?? 'fit_blur',
        videoSplitPercent: job.config.videoSplitPercent ?? 50,
        splitMediaFit: job.config.splitMediaFit ?? 'fit',
        playbackSpeed: job.config.playbackSpeed ?? 1,
        sourceWidth: movie.width,
        sourceHeight: movie.height,
        hasAudio: movie.hasAudio,
        sourceVideoCodec: movie.videoCodec,
        sourceAudioCodec: movie.audioCodec,
        ffmpegThreads,
      });
    } catch (primaryErr) {
      // Fallback: if audio stream fails to decode/resample, retry video-only so the clip still succeeds
      if (movie.hasAudio) {
        result = await renderClipWithThumbnail({
          moviePath: movie.filePath,
          outputPath,
          thumbnailPath,
          startSeconds: nextClip.startSeconds,
          durationSeconds: nextClip.durationSeconds,
          qualityTier: job.config.qualityTier,
          aspectRatio: job.config.aspectRatio ?? 'source',
          framingMode: job.config.framingMode ?? 'fit_blur',
          overlayImagePath,
          overlayPlacement: job.config.overlayPlacement,
          videoPlacement: job.config.videoPlacement,
          overlayBackdrop: job.config.overlayBackdrop ?? 'fit_blur',
          videoSplitPercent: job.config.videoSplitPercent ?? 50,
          splitMediaFit: job.config.splitMediaFit ?? 'fit',
          playbackSpeed: job.config.playbackSpeed ?? 1,
          sourceWidth: movie.width,
          sourceHeight: movie.height,
          hasAudio: false,
          sourceVideoCodec: movie.videoCodec,
          sourceAudioCodec: null,
          ffmpegThreads,
        });
      } else {
        throw primaryErr;
      }
    }

    nextClip.status = 'completed';
    nextClip.outputPath = outputPath;
    nextClip.thumbnailPath = thumbnailPath;
    nextClip.fileSizeBytes = result.fileSizeBytes;
    nextClip.actualWidth = result.actualWidth;
    nextClip.actualHeight = result.actualHeight;
    nextClip.durationSeconds = result.outputDurationSeconds;
    nextClip.error = undefined;
    nextClip.completedAt = new Date().toISOString();
    await saveClipToLibrary(job, nextClip).catch(() => undefined);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'FFmpeg clip rendering failed';
    if (nextClip.attempts <= job.config.maxRetries) {
      nextClip.status = 'queued';
      nextClip.error = `Attempt ${nextClip.attempts} failed, retrying: ${errMsg.slice(0, 120)}`;
      await sleep(750 * nextClip.attempts);
    } else {
      nextClip.status = 'failed';
      nextClip.error = errMsg.slice(0, 200);
    }
  }

  const doneCount = job.clips.filter((c) => c.status === 'completed').length;
  job.statusMessage = `Rendered ${doneCount} of ${job.clips.length} clips`;
  await persistJob(job);
}

async function analyzeChunkWithRetries(params: {
  chunkPath: string;
  chunkIndex: number;
  totalChunks: number;
  chunkStartSeconds: number;
  chunkDurationSeconds: number;
  totalMovieDurationSeconds: number;
  targetMomentsPerChunk: number;
  focusCategories: BatchConfig['focusCategories'];
  maxRetries: number;
}): Promise<DetectedMoment[]> {
  let attempt = 0;
  while (true) {
    try {
      return await analyzeMovieChunkWithGemini(params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      // Do not retry fatal auth/config errors
      if (
        msg.includes('GEMINI_API_KEY') ||
        msg.includes('PERMISSION_DENIED') ||
        msg.includes('API_KEY_INVALID') ||
        msg.includes('403')
      ) {
        throw err;
      }
      attempt += 1;
      if (attempt > params.maxRetries) {
        throw err;
      }
      await sleep(1500 * Math.pow(2, attempt - 1));
    }
  }
}

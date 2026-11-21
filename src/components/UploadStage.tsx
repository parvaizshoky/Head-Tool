import React, { useEffect, useRef, useState } from 'react';
import {
  Film,
  Upload,
  ArrowRight,
  AlertCircle,
  X,
  Clapperboard,
  Link2,
  PlugZap,
} from 'lucide-react';
import type { ImportQualityTier, MovieMetadata, UrlImportJob } from '../types/clipper';
import { apiUrl, checkBackendHealth } from '../utils/api';
import { formatBytes, formatTimecode } from '../utils/format';
import { YoutubeCookiesSection } from './YoutubeCookiesSection';

interface UploadStageProps {
  activeMovie: MovieMetadata | null;
  onMovieReady: (movie: MovieMetadata) => void;
  onProceedToConfigure: () => void;
  onOpenAutoSync?: () => void;
}

const DEFAULT_CHUNK_SIZE_BYTES = 512 * 1024; // 512 KB chunks pass strict shared-host/proxy body limits
const MIN_SPLIT_CHUNK_BYTES = 64 * 1024;
const UPLOAD_CONCURRENCY = 3;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];
  const step = 0x2000;
  for (let i = 0; i < bytes.length; i += step) {
    parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length))));
  }
  return btoa(parts.join(''));
}

async function parseErrorMessage(res: Response, fallback: string): Promise<{ message: string; isJson: boolean }> {
  const raw = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
      return { message: parsed.error.trim(), isJson: true };
    }
    return { message: fallback, isJson: true };
  } catch {
    return { message: fallback, isJson: false };
  }
}

const IMPORT_QUALITY_OPTIONS: Array<{ value: ImportQualityTier; label: string }> = [
  { value: 'best_hd', label: 'Best HD Available (1080p / 4K)' },
  { value: '1080p', label: '1080p Full HD' },
  { value: '720p', label: '720p HD' },
  { value: '2k', label: '2K QHD' },
  { value: '4k', label: '4K UHD' },
];

export const UploadStage: React.FC<UploadStageProps> = ({
  activeMovie,
  onMovieReady,
  onProceedToConfigure,
  onOpenAutoSync,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [sourceTab, setSourceTab] = useState<'link' | 'file'>('file');

  // File upload state
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadFilename, setUploadFilename] = useState('');
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [speedMbps, setSpeedMbps] = useState(0);
  const [statusNote, setStatusNote] = useState('');

  // URL link import state
  const [videoUrl, setVideoUrl] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [importQuality, setImportQuality] = useState<ImportQualityTier>('best_hd');
  const [activeImport, setActiveImport] = useState<UrlImportJob | null>(null);
  const [startingImport, setStartingImport] = useState(false);

  // Sample synthesis state
  const [generatingSample, setGeneratingSample] = useState(false);
  const [sampleDuration, setSampleDuration] = useState(180);
  const [error, setError] = useState<string | null>(null);
  const [videoLoadState, setVideoLoadState] = useState<'loading' | 'ready' | 'error'>('loading');

  const onMovieReadyRef = useRef(onMovieReady);
  onMovieReadyRef.current = onMovieReady;

  // Reset video player loading state when active movie changes
  useEffect(() => {
    if (!activeMovie) return;
    setVideoLoadState('loading');
  }, [activeMovie?.id, activeMovie?.previewStatus]);

  useEffect(() => {
    void checkBackendHealth().then((health) => {
      if (!health.ok) {
        setError(
          `Backend server unreachable (${health.status ? `HTTP ${health.status}` : 'network error'}). Make sure the Node.js backend (npm start / node server.ts on Node 22+) is running rather than serving only static dist/ files.`
        );
      }
    });
  }, []);

  // Poll backend if a non-MP4/HEVC video is generating a browser-compatible H.264 preview
  useEffect(() => {
    if (!activeMovie || activeMovie.previewStatus !== 'preparing') return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(apiUrl(`/api/movies/${activeMovie.id}`));
        if (!res.ok || !active) return;
        const data = (await res.json()) as { movie: MovieMetadata };
        if (data.movie.previewStatus !== 'preparing') {
          onMovieReadyRef.current(data.movie);
        }
      } catch {
        // Retry next interval
      }
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [activeMovie?.id, activeMovie?.previewStatus]);

  // Subscribe to SSE progress for active URL import + polling fallback for buffered proxies
  useEffect(() => {
    if (!activeImport) return;
    if (
      activeImport.status === 'completed' ||
      activeImport.status === 'failed' ||
      activeImport.status === 'cancelled'
    ) {
      return;
    }

    let closed = false;
    const applyUpdate = (updated: UrlImportJob, closeFn?: () => void) => {
      if (closed) return;
      setActiveImport(updated);
      if (updated.status === 'completed' && updated.movie) {
        onMovieReadyRef.current(updated.movie);
        setVideoUrl('');
        setCustomTitle('');
        closed = true;
        closeFn?.();
      } else if (updated.status === 'failed') {
        setError(updated.error || 'Failed to import video from link.');
        closed = true;
        closeFn?.();
      } else if (updated.status === 'cancelled') {
        closed = true;
        closeFn?.();
      }
    };

    const source = new EventSource(apiUrl(`/api/imports/${activeImport.id}/events`));
    source.onmessage = (event) => {
      try {
        const updated = JSON.parse(event.data as string) as UrlImportJob;
        applyUpdate(updated, () => source.close());
      } catch {
        // Ignore malformed SSE frame
      }
    };

    const pollTimer = setInterval(async () => {
      if (closed) return;
      try {
        const res = await fetch(apiUrl(`/api/imports/${activeImport.id}`));
        if (!res.ok || closed) return;
        const data = (await res.json()) as { importJob?: UrlImportJob };
        if (data.importJob) {
          applyUpdate(data.importJob, () => source.close());
        }
      } catch {
        // Ignore transient poll error
      }
    }, 2500);

    return () => {
      closed = true;
      clearInterval(pollTimer);
      source.close();
    };
  }, [activeImport?.id, activeImport?.status]);

  const handleUrlImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!videoUrl.trim()) {
      setError('Please paste a video link first.');
      return;
    }
    setError(null);
    setStartingImport(true);
    try {
      const res = await fetch(apiUrl('/api/imports/url'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: videoUrl.trim(),
          preferredQuality: importQuality,
          customTitle: customTitle.trim() || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        importJob?: UrlImportJob;
        error?: string;
      };
      if (!res.ok || !body.importJob) {
        throw new Error(body.error || 'Failed to start HD video link import');
      }
      setActiveImport(body.importJob);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start link import');
    } finally {
      setStartingImport(false);
    }
  };

  const handleCancelImport = async () => {
    if (!activeImport) return;
    await fetch(apiUrl(`/api/imports/${activeImport.id}/cancel`), { method: 'POST' }).catch(() => undefined);
    setActiveImport((prev) =>
      prev ? { ...prev, status: 'cancelled', statusMessage: 'Import cancelled.' } : null
    );
  };

  const handleFileUpload = async (file: File) => {
    if (file.size === 0) {
      setError('Selected video file is empty (0 bytes).');
      return;
    }

    setError(null);
    setUploading(true);
    setUploadFilename(file.name);
    setUploadedBytes(0);
    setTotalBytes(file.size);
    setSpeedMbps(0);
    setStatusNote('Initializing chunked upload session...');

    const controller = new AbortController();
    abortRef.current = controller;
    let activeUploadId: string | null = null;

    try {
      await checkBackendHealth(true);
      const safeFilename = (file.name || '').trim() || 'uploaded_video.mp4';
      const initEndpoint = apiUrl(
        `/api/uploads/init?filename=${encodeURIComponent(safeFilename)}&totalSize=${file.size}`
      );
      let initRes: Response | null = null;
      let lastInitErr: Error | null = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (controller.signal.aborted) {
          throw new Error('Upload cancelled by user.');
        }
        try {
          const candidateRes = await fetch(initEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: safeFilename, totalSize: file.size }),
            signal: controller.signal,
          });
          if (candidateRes.ok || (candidateRes.status >= 400 && candidateRes.status < 500 && candidateRes.status !== 408 && candidateRes.status !== 429)) {
            initRes = candidateRes;
            break;
          }
          const rawErr = await candidateRes.text().catch(() => '');
          let parsedErr: string | undefined;
          try {
            parsedErr = (JSON.parse(rawErr) as { error?: string }).error;
          } catch {
            // Non-JSON proxy/server error
          }
          lastInitErr = new Error(
            parsedErr || `Upload server returned HTTP ${candidateRes.status}. Retrying...`
          );
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err;
          lastInitErr = err instanceof Error ? err : new Error('Network error while initializing upload');
        }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }

      if (!initRes) {
        throw lastInitErr ?? new Error('Unable to reach upload server. Please check connection and try again.');
      }

      if (!initRes.ok) {
        const rawErr = await initRes.text().catch(() => '');
        let parsedErr: string | undefined;
        try {
          parsedErr = (JSON.parse(rawErr) as { error?: string }).error;
        } catch {
          // Non-JSON response
        }
        if (initRes.status === 404) {
          throw new Error(
            parsedErr ||
              'Failed to initialize upload (HTTP 404). Ensure the Node.js backend (npm start / node server.ts on Node 22+) is running and proxying /api/* requests (static dist/ hosting alone will return 404).'
          );
        }
        throw new Error(
          parsedErr || `Failed to initialize upload (HTTP ${initRes.status}). Ensure the backend server is running.`
        );
      }

      const { uploadId } = (await initRes.json()) as { uploadId: string };
      activeUploadId = uploadId;
      const startTime = performance.now();
      const totalChunks = Math.max(1, Math.ceil(file.size / DEFAULT_CHUNK_SIZE_BYTES));
      let nextChunkIndex = 0;
      let completedChunks = 0;
      let bytesAcked = 0;
      let transportMode: 'binary' | 'json_base64' = 'binary';

      const uploadSlice = async (startOffset: number, endOffset: number, chunkLabel: string): Promise<void> => {
        const sliceLen = endOffset - startOffset;
        if (sliceLen <= 0) return;
        const buffer = await file.slice(startOffset, endOffset).arrayBuffer();

        let lastErr: Error | null = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (controller.signal.aborted) {
            throw new Error('Upload cancelled by user.');
          }
          try {
            const useJson = transportMode === 'json_base64';
            const chunkRes = await fetch(
              apiUrl(`/api/uploads/${uploadId}/chunk?offset=${startOffset}`),
              {
                method: 'POST',
                headers: {
                  'Content-Type': useJson ? 'application/json' : 'application/octet-stream',
                },
                body: useJson
                  ? JSON.stringify({ offset: startOffset, dataBase64: arrayBufferToBase64(buffer) })
                  : buffer,
                signal: controller.signal,
              }
            );

            if (!chunkRes.ok) {
              const { message, isJson } = await parseErrorMessage(
                chunkRes,
                `Chunk ${chunkLabel} failed (HTTP ${chunkRes.status})`
              );

              // If reverse proxy rejects request size (413), split slice in half automatically
              if (chunkRes.status === 413 && sliceLen > MIN_SPLIT_CHUNK_BYTES) {
                const midOffset = startOffset + Math.floor(sliceLen / 2);
                await uploadSlice(startOffset, midOffset, `${chunkLabel}a`);
                await uploadSlice(midOffset, endOffset, `${chunkLabel}b`);
                return;
              }

              // If WAF/ModSecurity blocks raw octet-stream (403/406/415 or non-JSON HTML error page), switch to JSON base64
              if (
                transportMode === 'binary' &&
                (chunkRes.status === 403 ||
                  chunkRes.status === 406 ||
                  chunkRes.status === 415 ||
                  (!isJson && chunkRes.status >= 400))
              ) {
                transportMode = 'json_base64';
                lastErr = new Error(message);
                continue;
              }

              throw new Error(message);
            }

            bytesAcked += buffer.byteLength;
            setUploadedBytes(Math.min(file.size, bytesAcked));
            const elapsedSec = Math.max(0.1, (performance.now() - startTime) / 1000);
            setSpeedMbps(bytesAcked / (1024 * 1024) / elapsedSec);
            return;
          } catch (err) {
            if ((err as Error).name === 'AbortError') throw err;
            lastErr = err instanceof Error ? err : new Error('Chunk upload failed');
            await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
          }
        }
        throw lastErr ?? new Error(`Chunk ${chunkLabel} upload failed`);
      };

      const uploadSingleChunk = async (chunkIdx: number) => {
        const startOffset = chunkIdx * DEFAULT_CHUNK_SIZE_BYTES;
        const endOffset = Math.min(file.size, startOffset + DEFAULT_CHUNK_SIZE_BYTES);
        await uploadSlice(startOffset, endOffset, String(chunkIdx + 1));
        completedChunks += 1;
        setStatusNote(
          `Uploading movie (${completedChunks}/${totalChunks} chunks${transportMode === 'json_base64' ? ' · safe mode' : ''})...`
        );
      };

      const workerCount = Math.min(UPLOAD_CONCURRENCY, totalChunks);
      setStatusNote(`Uploading ${totalChunks} chunks in parallel...`);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (!controller.signal.aborted) {
            const idx = nextChunkIndex;
            nextChunkIndex += 1;
            if (idx >= totalChunks) break;
            await uploadSingleChunk(idx);
          }
        })
      );

      setStatusNote('Inspecting video streams & preparing smooth playback...');

      let completeRes: Response | null = null;
      let lastCompleteErr: Error | null = null;
      const cleanTitle = file.name.replace(/\.[^/.]+$/, '');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (controller.signal.aborted) {
          throw new Error('Upload cancelled by user.');
        }
        try {
          const candidateRes = await fetch(
            apiUrl(`/api/uploads/${uploadId}/complete?title=${encodeURIComponent(cleanTitle)}`),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: cleanTitle }),
              signal: controller.signal,
            }
          );
          if (
            candidateRes.ok ||
            (candidateRes.status >= 400 &&
              candidateRes.status < 500 &&
              candidateRes.status !== 408 &&
              candidateRes.status !== 429)
          ) {
            completeRes = candidateRes;
            break;
          }
          const { message } = await parseErrorMessage(
            candidateRes,
            `Failed to finalize movie (HTTP ${candidateRes.status})`
          );
          lastCompleteErr = new Error(message);
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err;
          lastCompleteErr = err instanceof Error ? err : new Error('Failed to finalize uploaded movie');
        }
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }

      if (!completeRes) {
        throw lastCompleteErr ?? new Error('Failed to finalize movie file.');
      }

      if (!completeRes.ok) {
        const { message } = await parseErrorMessage(
          completeRes,
          `Failed to inspect movie file (HTTP ${completeRes.status})`
        );
        throw new Error(message);
      }

      const { movie } = (await completeRes.json()) as { movie: MovieMetadata };
      onMovieReady(movie);
      setStatusNote('');
    } catch (err) {
      if (activeUploadId) {
        void fetch(apiUrl(`/api/uploads/${activeUploadId}`), { method: 'DELETE' }).catch(() => undefined);
      }
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Upload failed');
      }
    } finally {
      setUploading(false);
      abortRef.current = null;
    }
  };

  const handleGenerateSample = async () => {
    setError(null);
    setGeneratingSample(true);
    try {
      const res = await fetch(apiUrl('/api/movies/generate-sample'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          durationSeconds: sampleDuration,
          title: `Feature Test Reel (${Math.round(sampleDuration / 60)}m · 12 Scenes)`,
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || 'Failed to synthesize test movie');
      }
      const { movie } = (await res.json()) as { movie: MovieMetadata };
      onMovieReady(movie);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sample synthesis failed');
    } finally {
      setGeneratingSample(false);
    }
  };

  const uploadPercent = totalBytes > 0 ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 0;
  const isImportingUrl =
    Boolean(activeImport) &&
    activeImport?.status !== 'completed' &&
    activeImport?.status !== 'failed' &&
    activeImport?.status !== 'cancelled';

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Source Movie Ingestion
          </h1>
          <p className="text-sm text-slate-400 max-w-2xl">
            Import a complete HD video directly from a link or upload a movie file from disk (up to 1,000 clips per movie).
          </p>
        </div>

        {/* Source Input Mode Switch */}
        <div className="inline-flex items-center gap-1 p-1 rounded-lg border border-slate-800 bg-[#111622] shrink-0 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => setSourceTab('link')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              sourceTab === 'link'
                ? 'bg-[#171E2E] text-amber-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Link2 className="h-3.5 w-3.5" />
            <span>Import Video Link (HD)</span>
          </button>
          <button
            type="button"
            onClick={() => setSourceTab('file')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              sourceTab === 'file'
                ? 'bg-[#171E2E] text-amber-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Upload className="h-3.5 w-3.5" />
            <span>Upload Movie File</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-900/70 bg-red-950/30 px-4 py-3 text-sm text-red-200">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
          <div className="flex-1">{error}</div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-300 hover:text-white transition-colors"
            aria-label="Dismiss error"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* TAB 1: Import HD Video from Link */}
      {sourceTab === 'link' && (
        <div className="rounded-xl border border-slate-800 bg-[#111622] p-6 space-y-5">
          {isImportingUrl && activeImport ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-100 truncate">
                    {activeImport.resolvedTitle || activeImport.requestedTitle || activeImport.url}
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">{activeImport.statusMessage}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCancelImport()}
                  className="px-3 py-1.5 text-xs font-medium text-slate-300 border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Cancel Import
                </button>
              </div>

              <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-amber-500 transition-[width] duration-200"
                  style={{ width: `${Math.max(4, activeImport.progressPercent)}%` }}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 font-mono tabular-nums">
                <span>
                  {activeImport.progressPercent}%
                  {activeImport.downloadedText ? ` · ${activeImport.downloadedText}` : ''}
                  {activeImport.totalSizeText ? ` / ${activeImport.totalSizeText}` : ''}
                </span>
                <span>
                  {activeImport.speedText ? activeImport.speedText : 'Preparing'}
                  {activeImport.etaText ? ` · ETA ${activeImport.etaText}` : ''}
                </span>
              </div>
            </div>
          ) : (
            <form onSubmit={(e) => void handleUrlImport(e)} className="space-y-4">
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-800 bg-[#0B0E14] text-amber-400">
                  <Link2 className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-base font-medium text-slate-100">
                    Paste any video URL to extract & import in HD
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Supports YouTube, Vimeo, Dailymotion, X, TikTok, direct MP4/MKV/MOV links, and HLS (.m3u8) streams. Automatically merges HD video and audio into MP4.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 pt-1">
                <div className="lg:col-span-6">
                  <label htmlFor="video-url-input" className="block text-xs text-slate-400 mb-1.5">
                    Video Link (URL)
                  </label>
                  <input
                    id="video-url-input"
                    type="url"
                    required
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=... or https://example.com/movie.mp4"
                    className="w-full rounded-lg border border-slate-700 bg-[#0B0E14] px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div className="lg:col-span-3">
                  <label htmlFor="import-quality-select" className="block text-xs text-slate-400 mb-1.5">
                    Import Resolution
                  </label>
                  <select
                    id="import-quality-select"
                    value={importQuality}
                    onChange={(e) => setImportQuality(e.target.value as ImportQualityTier)}
                    className="w-full rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-amber-500"
                  >
                    {IMPORT_QUALITY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="lg:col-span-3">
                  <label htmlFor="import-title-input" className="block text-xs text-slate-400 mb-1.5">
                    Title (Optional)
                  </label>
                  <input
                    id="import-title-input"
                    type="text"
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    placeholder="Auto-detected from link"
                    className="w-full rounded-lg border border-slate-700 bg-[#0B0E14] px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end pt-1">
                <button
                  type="submit"
                  disabled={startingImport || uploading}
                  className="px-5 py-2.5 text-sm font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {startingImport ? 'Connecting to Link...' : 'Import HD Video'}
                </button>
              </div>
            </form>
          )}

          <YoutubeCookiesSection />
        </div>
      )}

      {/* TAB 2: Upload Local Movie File */}
      {sourceTab === 'file' && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const dropped = e.dataTransfer.files?.[0];
            if (dropped && !uploading) {
              void handleFileUpload(dropped);
            }
          }}
          className={`rounded-xl border transition-colors p-8 ${
            isDragging
              ? 'border-amber-500 bg-amber-500/5'
              : 'border-slate-800 bg-[#111622] hover:border-slate-700'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,.mkv,.mov,.mp4,.webm,.avi,.m4v"
            className="hidden"
            onChange={(e) => {
              const selected = e.target.files?.[0];
              if (selected) {
                void handleFileUpload(selected);
                e.target.value = '';
              }
            }}
          />

          {uploading ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-100 truncate">{uploadFilename}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{statusNote}</p>
                </div>
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="px-3 py-1.5 text-xs font-medium text-slate-300 border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                >
                  Cancel Upload
                </button>
              </div>

              <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-amber-500 transition-[width] duration-150"
                  style={{ width: `${uploadPercent}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-xs text-slate-400 tabular-nums">
                <span>
                  {formatBytes(uploadedBytes)} / {formatBytes(totalBytes)} ({uploadPercent}%)
                </span>
                <span>{speedMbps.toFixed(1)} MB/s</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="flex items-start gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-slate-800 bg-[#0B0E14] text-amber-400">
                  <Upload className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-base font-medium text-slate-100">
                    Drop a full movie file here or browse from disk
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Supports MP4, MKV, MOV, WebM, AVI, and M4V · 720p, 1080p, 2K, and 4K source files · Adaptive multi-GB chunked streaming
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-5 py-2.5 text-sm font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Select Movie File
              </button>
            </div>
          )}
        </div>
      )}

      {onOpenAutoSync && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-slate-800/90 bg-[#111622] px-6 py-4">
          <div className="flex items-start gap-3">
            <PlugZap className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-slate-100">
                Connect Another Tool to Download & Auto-Clip Videos
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Enter your external tool URL & API key, test with Ping, fetch available videos, and automatically clip into 1-minute TikTok 9:16 parts.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenAutoSync}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <PlugZap className="h-3.5 w-3.5" />
            <span>Connect External Tool</span>
          </button>
        </div>
      )}

      {/* Real FFmpeg Sample Movie Generator for immediate pipeline testing */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-slate-800/90 bg-[#111622] px-6 py-4">
        <div className="flex items-start gap-3">
          <Clapperboard className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-slate-200">
              Need a real multi-scene video immediately to test bulk HD clipping?
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              Synthesizes an actual 720p MP4 feature reel on the server with 12 visual chapters and synced audio using FFmpeg.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <select
            value={sampleDuration}
            onChange={(e) => setSampleDuration(Number(e.target.value))}
            disabled={generatingSample}
            className="rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
            aria-label="Test reel duration"
          >
            <option value={120}>2 min reel (12 scenes)</option>
            <option value={180}>3 min reel (12 scenes)</option>
            <option value={360}>6 min reel (12 scenes)</option>
            <option value={600}>10 min reel (12 scenes)</option>
          </select>
          <button
            type="button"
            onClick={() => void handleGenerateSample()}
            disabled={generatingSample || uploading || isImportingUrl}
            className="px-4 py-2 text-xs font-medium text-slate-100 border border-slate-700 bg-[#171E2E] rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {generatingSample ? 'Synthesizing MP4...' : 'Generate Test Reel'}
          </button>
        </div>
      </div>

      {/* Inspected Active Movie Panel */}
      {activeMovie ? (
        <div className="rounded-xl border border-slate-800 bg-[#111622] overflow-hidden">
          <div className="flex flex-col lg:flex-row items-stretch">
            <div className="relative lg:w-[440px] min-h-[240px] shrink-0 bg-black flex items-center justify-center border-b lg:border-b-0 lg:border-r border-slate-800">
              {activeMovie.previewStatus === 'preparing' ? (
                <div className="p-6 text-center space-y-2">
                  <div className="h-6 w-6 mx-auto rounded-full border-2 border-amber-500 border-t-transparent animate-spin" />
                  <p className="text-xs font-medium text-slate-200">
                    Preparing smooth browser preview...
                  </p>
                  <p className="text-[11px] text-slate-400">
                    You can already configure and start clipping while preview optimizes.
                  </p>
                </div>
              ) : videoLoadState === 'error' ? (
                <div className="p-6 text-center space-y-2">
                  <Film className="h-7 w-7 text-amber-400 mx-auto" />
                  <p className="text-xs font-medium text-slate-200">
                    Source ready for clipping ({activeMovie.videoCodec.toUpperCase()})
                  </p>
                  <p className="text-[11px] text-slate-400 max-w-xs mx-auto">
                    Browser could not decode this stream directly, but FFmpeg & Gemini clip generation works normally.
                  </p>
                </div>
              ) : (
                <>
                  <video
                    key={`${activeMovie.id}-${activeMovie.previewStatus ?? 'native'}`}
                    src={apiUrl(`/api/movies/${activeMovie.id}/stream`)}
                    controls
                    playsInline
                    preload="auto"
                    onLoadedData={() => setVideoLoadState('ready')}
                    onCanPlay={() => setVideoLoadState('ready')}
                    onError={() => setVideoLoadState('error')}
                    className="w-full h-full max-h-[260px] object-contain"
                  />
                  {videoLoadState === 'loading' && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50">
                      <div className="flex items-center gap-2 rounded-lg bg-[#111622]/90 border border-slate-800 px-3 py-1.5 text-xs text-slate-200">
                        <div className="h-3.5 w-3.5 rounded-full border-2 border-amber-500 border-t-transparent animate-spin" />
                        <span>Loading video stream...</span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex-1 p-6 flex flex-col justify-between gap-6">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span>Active Source Movie</span>
                  <span aria-hidden="true">·</span>
                  <span>{activeMovie.originalFilename}</span>
                  {activeMovie.sourceUrl && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="truncate max-w-xs text-amber-400/90">
                        Imported from link
                      </span>
                    </>
                  )}
                </div>
                <h2 className="text-xl font-semibold text-slate-100 mt-1 truncate">
                  {activeMovie.title}
                </h2>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4 mt-5 pt-5 border-t border-slate-800/80">
                  <div>
                    <div className="text-xs text-slate-400">Total Duration</div>
                    <div className="text-sm font-medium text-slate-100 tabular-nums mt-0.5">
                      {formatTimecode(activeMovie.durationSeconds)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-400">Resolution</div>
                    <div className="text-sm font-medium text-slate-100 tabular-nums mt-0.5">
                      {activeMovie.width}×{activeMovie.height}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-400">Frame Rate</div>
                    <div className="text-sm font-medium text-slate-100 tabular-nums mt-0.5">
                      {activeMovie.fps} fps
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-400">Video Codec</div>
                    <div className="text-sm font-medium text-slate-100 uppercase mt-0.5">
                      {activeMovie.videoCodec}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-400">Audio Stream</div>
                    <div className="text-sm font-medium text-slate-100 uppercase mt-0.5">
                      {activeMovie.hasAudio ? activeMovie.audioCodec || 'AAC' : 'No Audio'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-400">Source Size</div>
                    <div className="text-sm font-medium text-slate-100 tabular-nums mt-0.5">
                      {formatBytes(activeMovie.fileSizeBytes)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800/80">
                <button
                  type="button"
                  onClick={onProceedToConfigure}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors whitespace-nowrap cursor-pointer"
                >
                  <span>Configure HD Clip Batch</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-800 bg-[#0E121B] px-6 py-10 text-center">
          <Film className="h-8 w-8 text-slate-600 mx-auto mb-3" />
          <p className="text-sm font-medium text-slate-300">No source movie selected yet</p>
          <p className="text-xs text-slate-500 mt-1">
            Import an HD video from a link, upload a movie file, or generate a real test reel to begin.
          </p>
        </div>
      )}
    </div>
  );
};

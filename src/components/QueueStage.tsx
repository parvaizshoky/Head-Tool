import React, { useMemo, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Clock,
  Download,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Search,
  Square,
  AlertCircle,
  Film,
} from 'lucide-react';
import type { BatchJob, ClipStatus, GeneratedClip } from '../types/clipper';
import { apiUrl } from '../utils/api';
import { CATEGORY_LABELS, formatBytes, formatTimecode } from '../utils/format';

interface QueueStageProps {
  job: BatchJob | null;
  onPause: (jobId: string) => Promise<void>;
  onResume: (jobId: string) => Promise<void>;
  onCancel: (jobId: string) => Promise<void>;
  onRetryFailed: (jobId: string) => Promise<void>;
  onChangeConcurrency: (jobId: string, concurrency: number) => Promise<void>;
  onPlayClip: (clip: GeneratedClip) => void;
  onOpenLibrary: () => void;
}

const PAGE_SIZE = 50;

export const QueueStage: React.FC<QueueStageProps> = ({
  job,
  onPause,
  onResume,
  onCancel,
  onRetryFailed,
  onChangeConcurrency,
  onPlayClip,
  onOpenLibrary,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | ClipStatus>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const filteredClips = useMemo(() => {
    if (!job) return [];
    const q = search.trim().toLowerCase();
    return job.clips.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.summary.toLowerCase().includes(q) ||
        CATEGORY_LABELS[c.category].toLowerCase().includes(q) ||
        c.outputFilename.toLowerCase().includes(q)
      );
    });
  }, [job, statusFilter, search]);

  if (!job) {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#111622] p-10 text-center space-y-3">
        <Film className="h-8 w-8 text-slate-600 mx-auto" />
        <h2 className="text-lg font-semibold text-slate-100">No active batch job</h2>
        <p className="text-sm text-slate-400 max-w-md mx-auto">
          Configure and launch a clip generation batch to monitor full-movie Gemini analysis and parallel FFmpeg rendering here.
        </p>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(filteredClips.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visibleClips = filteredClips.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const isRunning =
    job.phase === 'queued' ||
    job.phase === 'chunking' ||
    job.phase === 'analyzing' ||
    job.phase === 'distributing' ||
    job.phase === 'rendering';

  return (
    <div className="space-y-6">
      {/* Header & Batch Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="capitalize text-slate-200 font-medium">{job.phase}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{formatTimecode(job.movieDurationSeconds)} runtime</span>
            <span aria-hidden="true">·</span>
            <span>{job.config.qualityTier.toUpperCase()}</span>
            {job.config.aspectRatio && job.config.aspectRatio !== 'source' && (
              <>
                <span aria-hidden="true">·</span>
                <span>{job.config.aspectRatio}</span>
              </>
            )}
            {job.config.playbackSpeed && job.config.playbackSpeed !== 1 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{job.config.playbackSpeed}x</span>
              </>
            )}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100 mt-1">
            {job.movieTitle}
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">{job.statusMessage}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {isRunning && (
            <button
              type="button"
              onClick={() => void onPause(job.id)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 border border-slate-700 bg-[#171E2E] rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap cursor-pointer"
            >
              <Pause className="h-3.5 w-3.5" />
              <span>Pause</span>
            </button>
          )}

          {job.phase === 'paused' && (
            <button
              type="button"
              onClick={() => void onResume(job.id)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors whitespace-nowrap cursor-pointer"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              <span>Resume</span>
            </button>
          )}

          {(job.stats.failed > 0 || job.chunks.some((c) => c.status === 'failed')) && (
            <button
              type="button"
              onClick={() => void onRetryFailed(job.id)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-amber-200 border border-amber-800/70 bg-amber-950/30 rounded-lg hover:bg-amber-900/40 transition-colors whitespace-nowrap cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Retry Failed</span>
            </button>
          )}

          {isRunning && (
            <button
              type="button"
              onClick={() => void onCancel(job.id)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-red-200 border border-red-900/70 bg-red-950/30 rounded-lg hover:bg-red-900/40 transition-colors whitespace-nowrap cursor-pointer"
            >
              <Square className="h-3.5 w-3.5" />
              <span>Cancel</span>
            </button>
          )}

          {job.stats.completed > 0 && (
            <>
              <button
                type="button"
                onClick={onOpenLibrary}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-100 border border-slate-700 bg-[#171E2E] rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap cursor-pointer"
              >
                <span>View Library ({job.stats.completed})</span>
              </button>
              <a
                href={apiUrl(`/api/jobs/${job.id}/download-zip`)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors whitespace-nowrap"
              >
                <Archive className="h-3.5 w-3.5" />
                <span>Download ZIP ({job.stats.completed})</span>
              </a>
            </>
          )}
        </div>
      </div>

      {job.error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-900/70 bg-red-950/30 px-4 py-3 text-sm text-red-200">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
          <div className="space-y-0.5">
            <div className="font-medium">Pipeline Warning / Error</div>
            <div className="text-xs text-red-300/90">{job.error}</div>
          </div>
        </div>
      )}

      {/* 6-Metric Bulk Queue Telemetry */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="rounded-xl border border-slate-800 bg-[#111622] px-4 py-3.5">
          <div className="text-xs text-slate-400">Total Requested</div>
          <div className="text-xl font-semibold text-slate-100 tabular-nums mt-1">
            {job.stats.totalRequested.toLocaleString()}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#111622] px-4 py-3.5">
          <div className="text-xs text-slate-400">Completed</div>
          <div className="text-xl font-semibold text-emerald-400 tabular-nums mt-1">
            {job.stats.completed.toLocaleString()}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#111622] px-4 py-3.5">
          <div className="text-xs text-slate-400">Currently Processing</div>
          <div className="text-xl font-semibold text-amber-400 tabular-nums mt-1">
            {job.stats.processing.toLocaleString()}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#111622] px-4 py-3.5">
          <div className="text-xs text-slate-400">Failed</div>
          <div className="text-xl font-semibold text-red-400 tabular-nums mt-1">
            {job.stats.failed.toLocaleString()}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#111622] px-4 py-3.5">
          <div className="text-xs text-slate-400">Remaining</div>
          <div className="text-xl font-semibold text-slate-200 tabular-nums mt-1">
            {job.stats.remaining.toLocaleString()}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#111622] px-4 py-3.5">
          <div className="text-xs text-slate-400">Overall Progress</div>
          <div className="text-xl font-semibold text-slate-100 tabular-nums mt-1">
            {job.stats.progressPercent}%
          </div>
        </div>
      </div>

      {/* Overall Progress Bar + Dynamic Worker Capacity */}
      <div className="rounded-xl border border-slate-800 bg-[#111622] p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs text-slate-300 tabular-nums">
            Analysis: <span className="text-slate-100 font-medium">{job.stats.analyzedChunks}/{job.stats.totalChunks} chunks ({job.stats.analysisPercent}%)</span>
            <span className="mx-2 text-slate-600" aria-hidden="true">·</span>
            Rendering: <span className="text-slate-100 font-medium">{job.stats.renderPercent}%</span>
            <span className="mx-2 text-slate-600" aria-hidden="true">·</span>
            Output Volume: <span className="text-slate-100 font-medium">{formatBytes(job.stats.totalOutputBytes)}</span>
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-300 shrink-0">
            <label htmlFor="live-concurrency" className="whitespace-nowrap">
              FFmpeg Workers:
            </label>
            <select
              id="live-concurrency"
              value={job.config.workerConcurrency}
              onChange={(e) => void onChangeConcurrency(job.id, Number(e.target.value))}
              className="rounded-md border border-slate-700 bg-[#0B0E14] px-2.5 py-1 text-xs font-mono text-slate-100 focus:outline-none focus:border-amber-500"
            >
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n} parallel
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="h-2.5 w-full rounded-full bg-slate-800 overflow-hidden">
          <div
            className={`h-full transition-[width] duration-300 ${
              job.phase === 'failed'
                ? 'bg-red-500'
                : job.phase === 'completed'
                  ? 'bg-emerald-500'
                  : 'bg-amber-500'
            }`}
            style={{ width: `${job.stats.progressPercent}%` }}
          />
        </div>
      </div>

      {/* Complete Movie Analysis & Distribution Timeline Map */}
      <div className="rounded-xl border border-slate-800 bg-[#111622] p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Full-Movie Chunk Coverage & Clip Distribution Map
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Every segment from 00:00:00 to {formatTimecode(job.movieDurationSeconds)} is analyzed; clips are distributed across the complete runtime.
            </p>
          </div>
          <div className="text-xs font-mono text-slate-400 tabular-nums shrink-0">
            {job.moments.length} AI moments detected
          </div>
        </div>

        {/* Chunk bars */}
        <div className="space-y-2">
          <div className="flex items-center gap-1 h-7">
            {job.chunks.map((chunk) => {
              const color =
                chunk.status === 'completed'
                  ? 'bg-emerald-500/75 hover:bg-emerald-400'
                  : chunk.status === 'analyzing' || chunk.status === 'extracting'
                    ? 'bg-amber-500 hover:bg-amber-400'
                    : chunk.status === 'failed'
                      ? 'bg-red-500/80 hover:bg-red-400'
                      : 'bg-slate-800 hover:bg-slate-700';
              return (
                <div
                  key={chunk.index}
                  title={`Chunk ${chunk.index + 1}: ${formatTimecode(chunk.startSeconds)} – ${formatTimecode(chunk.endSeconds)} · ${chunk.status} · ${chunk.momentsFound} moments${chunk.error ? ` (${chunk.error})` : ''}`}
                  className={`flex-1 h-full rounded-sm transition-colors ${color}`}
                />
              );
            })}
          </div>

          {/* Distributed Clip Markers across 0% -> 100% of movie */}
          {job.clips.length > 0 && (
            <div className="relative h-4 w-full rounded-sm bg-[#0B0E14] border border-slate-800/80 overflow-hidden">
              {job.clips.map((clip) => {
                const leftPct = (clip.startSeconds / Math.max(1, job.movieDurationSeconds)) * 100;
                const widthPct = Math.max(
                  0.35,
                  (clip.durationSeconds / Math.max(1, job.movieDurationSeconds)) * 100
                );
                const bg =
                  clip.status === 'completed'
                    ? 'bg-emerald-400'
                    : clip.status === 'processing'
                      ? 'bg-amber-400'
                      : clip.status === 'failed'
                        ? 'bg-red-500'
                        : 'bg-slate-500/60';
                return (
                  <div
                    key={clip.id}
                    title={`#${clip.index} ${clip.title} (${formatTimecode(clip.startSeconds)}–${formatTimecode(clip.endSeconds)})`}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    className={`absolute top-0.5 bottom-0.5 rounded-[1px] ${bg}`}
                  />
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 tabular-nums">
            <span>00:00:00 (Start)</span>
            <span>{formatTimecode(job.movieDurationSeconds * 0.5)} (Midpoint)</span>
            <span>{formatTimecode(job.movieDurationSeconds)} (End)</span>
          </div>
        </div>
      </div>

      {/* Clip Processing Table */}
      <div className="rounded-xl border border-slate-800 bg-[#111622] overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-[#0B0E14] border border-slate-800">
            {(['all', 'completed', 'processing', 'queued', 'failed'] as const).map((tab) => {
              const active = statusFilter === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setStatusFilter(tab);
                    setPage(1);
                  }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'bg-[#171E2E] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab}
                </button>
              );
            })}
          </div>

          <div className="relative w-full md:w-72">
            <Search className="h-3.5 w-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Filter clips by title or category..."
              className="w-full rounded-lg border border-slate-800 bg-[#0B0E14] pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500"
            />
          </div>
        </div>

        {job.clips.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-400">
            {isRunning
              ? 'Waiting for full-movie chunk analysis to finish before scheduling clips...'
              : 'No clips scheduled in this job.'}
          </div>
        ) : visibleClips.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-slate-400">
            No clips match the current filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] font-medium text-slate-400 bg-[#0E121B]">
                  <th className="py-2.5 px-4 w-16">#</th>
                  <th className="py-2.5 px-4">Clip Title & Category</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Timecode</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Status</th>
                  <th className="py-2.5 px-4 text-right whitespace-nowrap">Size</th>
                  <th className="py-2.5 px-4 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 text-xs">
                {visibleClips.map((clip) => (
                  <tr key={clip.id} className="hover:bg-[#171E2E]/50 transition-colors">
                    <td className="py-2.5 px-4 font-mono text-slate-400 tabular-nums">
                      {String(clip.index).padStart(4, '0')}
                    </td>
                    <td className="py-2.5 px-4 max-w-md">
                      <div className="font-medium text-slate-100 truncate">{clip.title}</div>
                      <div className="text-[11px] text-slate-400 truncate mt-0.5">
                        {CATEGORY_LABELS[clip.category]} · Score {clip.score}/100 · {clip.summary}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-300 tabular-nums whitespace-nowrap">
                      {formatTimecode(clip.startSeconds)} – {formatTimecode(clip.endSeconds)}
                    </td>
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      {clip.status === 'completed' && (
                        <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Completed</span>
                        </span>
                      )}
                      {clip.status === 'processing' && (
                        <span className="inline-flex items-center gap-1.5 text-amber-400 font-medium">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span>Processing</span>
                        </span>
                      )}
                      {clip.status === 'queued' && (
                        <span className="inline-flex items-center gap-1.5 text-slate-400">
                          <Clock className="h-3.5 w-3.5" />
                          <span>Queued</span>
                        </span>
                      )}
                      {clip.status === 'failed' && (
                        <span
                          title={clip.error || 'Rendering failed'}
                          className="inline-flex items-center gap-1.5 text-red-400 font-medium"
                        >
                          <AlertCircle className="h-3.5 w-3.5" />
                          <span>Failed</span>
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-slate-300 tabular-nums whitespace-nowrap">
                      {clip.fileSizeBytes ? formatBytes(clip.fileSizeBytes) : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right whitespace-nowrap">
                      {clip.status === 'completed' ? (
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onPlayClip(clip)}
                            className="px-2.5 py-1 text-xs font-medium text-slate-200 border border-slate-700 rounded hover:bg-slate-800 transition-colors cursor-pointer"
                          >
                            Play
                          </button>
                          <a
                            href={apiUrl(`/api/jobs/${job.id}/clips/${clip.id}/download`)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-950 bg-amber-500 rounded hover:bg-amber-400 transition-colors"
                          >
                            <Download className="h-3 w-3" />
                            <span>MP4</span>
                          </a>
                        </div>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-slate-800 text-xs text-slate-400">
            <span className="tabular-nums">
              Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredClips.length)} of{' '}
              {filteredClips.length.toLocaleString()} clips
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
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
                className="px-3 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

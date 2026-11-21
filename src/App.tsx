import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Trash2, Film, Layers } from 'lucide-react';
import type { BatchConfig, BatchJob, LibraryVideo, MovieMetadata } from './types/clipper';
import type { PreviewTarget } from './components/ClipPlayerModal';
import { apiUrl, checkBackendHealth } from './utils/api';
import { formatTimecode } from './utils/format';
import { UploadStage } from './components/UploadStage';

const ConfigureStage = lazy(() =>
  import('./components/ConfigureStage').then((m) => ({ default: m.ConfigureStage }))
);
const QueueStage = lazy(() =>
  import('./components/QueueStage').then((m) => ({ default: m.QueueStage }))
);
const LibraryStage = lazy(() =>
  import('./components/LibraryStage').then((m) => ({ default: m.LibraryStage }))
);
const AutoSyncStage = lazy(() =>
  import('./components/AutoSyncStage').then((m) => ({ default: m.AutoSyncStage }))
);
const ClipPlayerModal = lazy(() =>
  import('./components/ClipPlayerModal').then((m) => ({ default: m.ClipPlayerModal }))
);

type StageTab = 'upload' | 'configure' | 'queue' | 'library' | 'autosync';

export default function App() {
  const [stage, setStage] = useState<StageTab>('upload');
  const [movies, setMovies] = useState<MovieMetadata[]>([]);
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [libraryVideos, setLibraryVideos] = useState<LibraryVideo[]>([]);
  const [libraryTotalBytes, setLibraryTotalBytes] = useState<number>(0);
  const [activeMovieId, setActiveMovieId] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);

  const loadLibrary = useCallback(async () => {
    try {
      const libRes = await fetch(apiUrl('/api/library'));
      if (libRes.ok) {
        const data = (await libRes.json()) as {
          videos: LibraryVideo[];
          totalOutputBytes: number;
        };
        setLibraryVideos(data.videos);
        setLibraryTotalBytes(data.totalOutputBytes || 0);
      }
    } catch {
      // Ignore transient network error
    }
  }, []);

  const loadWorkspaceData = async () => {
    try {
      await checkBackendHealth();
      const [movRes, jobRes, libRes] = await Promise.all([
        fetch(apiUrl('/api/movies')),
        fetch(apiUrl('/api/jobs')),
        fetch(apiUrl('/api/library')),
      ]);
      if (movRes.ok) {
        const data = (await movRes.json()) as { movies: MovieMetadata[] };
        setMovies(data.movies);
        setActiveMovieId((prev) => prev ?? data.movies[0]?.id ?? null);
      }
      if (jobRes.ok) {
        const data = (await jobRes.json()) as { jobs: BatchJob[] };
        setJobs(data.jobs);
        setActiveJobId((prev) => prev ?? data.jobs[0]?.id ?? null);
      }
      if (libRes.ok) {
        const data = (await libRes.json()) as {
          videos: LibraryVideo[];
          totalOutputBytes: number;
        };
        setLibraryVideos(data.videos);
        setLibraryTotalBytes(data.totalOutputBytes || 0);
      }
    } catch {
      // Initial load retry handled by user action
    }
  };

  useEffect(() => {
    void loadWorkspaceData();
  }, []);

  // Subscribe to SSE live updates for the selected active job + fallback sync while running
  useEffect(() => {
    if (!activeJobId) return;
    const source = new EventSource(apiUrl(`/api/jobs/${activeJobId}/events`));
    source.onmessage = (event) => {
      try {
        const updated = JSON.parse(event.data as string) as BatchJob;
        setJobs((prev) => {
          const exists = prev.some((j) => j.id === updated.id);
          if (!exists) return [updated, ...prev];
          return prev.map((j) => (j.id === updated.id ? updated : j));
        });
      } catch {
        // Ignore keepalive or malformed frame
      }
    };

    const pollTimer = setInterval(async () => {
      try {
        const res = await fetch(apiUrl(`/api/jobs/${activeJobId}`));
        if (!res.ok) return;
        const { job } = (await res.json()) as { job: BatchJob };
        setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));
      } catch {
        // Ignore transient network hiccup
      }
    }, 5000);

    return () => {
      clearInterval(pollTimer);
      source.close();
    };
  }, [activeJobId]);

  const activeMovie = movies.find((m) => m.id === activeMovieId) ?? null;
  const activeJob = jobs.find((j) => j.id === activeJobId) ?? null;
  const activeCompletedCount = activeJob?.stats.completed ?? 0;

  useEffect(() => {
    if (stage === 'library' || activeCompletedCount > 0) {
      void loadLibrary();
    }
  }, [stage, activeCompletedCount, loadLibrary]);

  const handleMovieReady = useCallback((movie: MovieMetadata) => {
    setMovies((prev) => [movie, ...prev.filter((m) => m.id !== movie.id)]);
    setActiveMovieId(movie.id);
  }, []);

  const handleDeleteLibraryVideo = useCallback(async (videoId: string) => {
    const res = await fetch(apiUrl(`/api/library/${encodeURIComponent(videoId)}`), {
      method: 'DELETE',
    });
    if (res.ok) {
      setLibraryVideos((prev) => {
        const next = prev.filter((v) => v.id !== videoId);
        setLibraryTotalBytes(next.reduce((acc, v) => acc + (v.fileSizeBytes || 0), 0));
        return next;
      });
    }
  }, []);

  const handleDeleteMovie = async (movieId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(apiUrl(`/api/movies/${movieId}`), { method: 'DELETE' });
    setMovies((prev) => {
      const next = prev.filter((m) => m.id !== movieId);
      setActiveMovieId((curr) => (curr === movieId ? next[0]?.id ?? null : curr));
      return next;
    });
  };

  const handleDeleteJob = async (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(apiUrl(`/api/jobs/${jobId}`), { method: 'DELETE' });
    setJobs((prev) => {
      const next = prev.filter((j) => j.id !== jobId);
      setActiveJobId((curr) => (curr === jobId ? next[0]?.id ?? null : curr));
      return next;
    });
  };

  const handleStartBatch = async (config: BatchConfig) => {
    if (!activeMovie) return;
    const res = await fetch(apiUrl('/api/jobs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movieId: activeMovie.id, config }),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(errBody.error || 'Failed to launch batch job');
    }
    const { job } = (await res.json()) as { job: BatchJob };
    setJobs((prev) => [job, ...prev]);
    setActiveJobId(job.id);
    setStage('queue');
  };

  const handleJobAction = async (
    jobId: string,
    action: 'pause' | 'resume' | 'cancel' | 'retry-failed'
  ) => {
    const res = await fetch(apiUrl(`/api/jobs/${jobId}/${action}`), { method: 'POST' });
    if (res.ok) {
      const { job } = (await res.json()) as { job: BatchJob };
      setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));
    }
  };

  const handleChangeConcurrency = async (jobId: string, workerConcurrency: number) => {
    const res = await fetch(apiUrl(`/api/jobs/${jobId}/concurrency`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerConcurrency }),
    });
    if (res.ok) {
      const { job } = (await res.json()) as { job: BatchJob };
      setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0E14] text-slate-100 flex flex-col">
      {/* 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-slate-800 bg-[#0E121B]">
        <button
          type="button"
          onClick={() => setStage('upload')}
          className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
        >
          FrameSplit
        </button>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
          <button
            type="button"
            onClick={() => setStage('upload')}
            className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
              stage === 'upload'
                ? 'text-amber-400'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Source Movie
          </button>
          <button
            type="button"
            onClick={() => setStage('configure')}
            className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
              stage === 'configure'
                ? 'text-amber-400'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Configure Batch
          </button>
          <button
            type="button"
            onClick={() => setStage('queue')}
            className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
              stage === 'queue'
                ? 'text-amber-400'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Processing Queue
          </button>
          <button
            type="button"
            onClick={() => setStage('library')}
            className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
              stage === 'library'
                ? 'text-amber-400'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Clip Library
          </button>
          <button
            type="button"
            onClick={() => setStage('autosync')}
            className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
              stage === 'autosync'
                ? 'text-amber-400'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Auto-Sync
          </button>
        </nav>

        <div className="shrink-0">
          <button
            type="button"
            onClick={() => setStage('upload')}
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Upload Movie
          </button>
        </div>
      </header>

      {/* Mobile Stage Switcher */}
      <div className="flex md:hidden items-center gap-1 overflow-x-auto px-4 py-2 border-b border-slate-800 bg-[#0E121B]">
        {(
          [
            ['upload', 'Source'],
            ['configure', 'Configure'],
            ['queue', 'Queue'],
            ['library', 'Library'],
            ['autosync', 'Auto-Sync'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setStage(id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
              stage === id ? 'bg-[#171E2E] text-amber-400' : 'text-slate-400'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Studio Workspace Layout */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Sidebar: Movies & Batch Jobs */}
        <aside className="w-full lg:w-[272px] shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800 bg-[#0E121B] p-4 space-y-6">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-xs font-semibold text-slate-400">Source Movies</h2>
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                {movies.length}
              </span>
            </div>

            {movies.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-800 px-3 py-4 text-xs text-slate-500">
                No uploaded movies yet.
              </div>
            ) : (
              <div className="space-y-1.5">
                {movies.map((mov) => {
                  const selected = mov.id === activeMovieId;
                  return (
                    <div
                      key={mov.id}
                      onClick={() => {
                        setActiveMovieId(mov.id);
                        if (stage === 'queue' || stage === 'library' || stage === 'autosync') {
                          setStage('configure');
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          setActiveMovieId(mov.id);
                        }
                      }}
                      className={`group flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors cursor-pointer ${
                        selected
                          ? 'border-amber-500/60 bg-amber-500/10'
                          : 'border-slate-800/80 bg-[#111622] hover:border-slate-700'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <Film className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                          <span className="text-xs font-medium text-slate-100 truncate">
                            {mov.title}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5">
                          {formatTimecode(mov.durationSeconds)} · {mov.width}×{mov.height}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => void handleDeleteMovie(mov.id, e)}
                        className="p-1 text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                        aria-label={`Delete ${mov.title}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2.5 pt-4 border-t border-slate-800/80">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-xs font-semibold text-slate-400">Batch Jobs</h2>
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                {jobs.length}
              </span>
            </div>

            {jobs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-800 px-3 py-4 text-xs text-slate-500">
                No batch jobs started.
              </div>
            ) : (
              <div className="space-y-1.5">
                {jobs.map((job) => {
                  const selected = job.id === activeJobId;
                  return (
                    <div
                      key={job.id}
                      onClick={() => {
                        setActiveJobId(job.id);
                        setStage(job.phase === 'completed' && job.stats.completed > 0 ? 'library' : 'queue');
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          setActiveJobId(job.id);
                          setStage('queue');
                        }
                      }}
                      className={`group flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors cursor-pointer ${
                        selected
                          ? 'border-amber-500/60 bg-amber-500/10'
                          : 'border-slate-800/80 bg-[#111622] hover:border-slate-700'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <Layers className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                          <span className="text-xs font-medium text-slate-100 truncate">
                            {job.movieTitle}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono tabular-nums mt-0.5">
                          <span>
                            {job.stats.completed}/{job.stats.totalRequested} clips
                          </span>
                          <span>{job.stats.progressPercent}%</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => void handleDeleteJob(job.id, e)}
                        className="p-1 text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                        aria-label={`Delete batch ${job.movieTitle}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        {/* Main Studio Canvas */}
        <main className="flex-1 min-w-0 p-6 lg:p-8 max-w-[1200px]">
          {stage === 'upload' && (
            <UploadStage
              activeMovie={activeMovie}
              onMovieReady={handleMovieReady}
              onProceedToConfigure={() => setStage('configure')}
              onOpenAutoSync={() => setStage('autosync')}
            />
          )}

          <Suspense
            fallback={
              <div className="rounded-xl border border-slate-800 bg-[#111622] p-10 text-center text-sm text-slate-400">
                Loading studio module...
              </div>
            }
          >
            {stage === 'configure' && (
              <ConfigureStage
                movie={activeMovie}
                onStartBatch={handleStartBatch}
                onGoToUpload={() => setStage('upload')}
              />
            )}

            {stage === 'queue' && (
              <QueueStage
                job={activeJob}
                onPause={(id) => handleJobAction(id, 'pause')}
                onResume={(id) => handleJobAction(id, 'resume')}
                onCancel={(id) => handleJobAction(id, 'cancel')}
                onRetryFailed={(id) => handleJobAction(id, 'retry-failed')}
                onChangeConcurrency={handleChangeConcurrency}
                onPlayClip={(clip) => {
                  if (activeJob) {
                    setPreviewTarget({ kind: 'jobClip', jobId: activeJob.id, clip });
                  }
                }}
                onOpenLibrary={() => setStage('library')}
              />
            )}

            {stage === 'library' && (
              <LibraryStage
                activeJob={activeJob}
                libraryVideos={libraryVideos}
                libraryTotalBytes={libraryTotalBytes}
                onPlayVideo={(video) => setPreviewTarget({ kind: 'libraryVideo', video })}
                onDeleteVideo={handleDeleteLibraryVideo}
                onRefreshLibrary={loadLibrary}
              />
            )}

            {stage === 'autosync' && (
              <AutoSyncStage
                movies={movies}
                onOpenQueueForJob={(jobId) => {
                  setActiveJobId(jobId);
                  setStage('queue');
                  void loadWorkspaceData();
                }}
                onOpenLibrary={() => {
                  void loadLibrary();
                  setStage('library');
                }}
                onRefreshWorkspace={loadWorkspaceData}
              />
            )}
          </Suspense>
        </main>
      </div>

      {previewTarget && (
        <Suspense fallback={null}>
          <ClipPlayerModal
            target={previewTarget}
            onClose={() => setPreviewTarget(null)}
          />
        </Suspense>
      )}
    </div>
  );
}

import React, { useEffect } from 'react';
import { Download, X } from 'lucide-react';
import type { GeneratedClip, LibraryVideo } from '../types/clipper';
import { apiUrl } from '../utils/api';
import { CATEGORY_LABELS, formatBytes, formatTimecode } from '../utils/format';

export type PreviewTarget =
  | { kind: 'jobClip'; jobId: string; clip: GeneratedClip }
  | { kind: 'libraryVideo'; video: LibraryVideo };

interface ClipPlayerModalProps {
  target: PreviewTarget | null;
  onClose: () => void;
}

export const ClipPlayerModal: React.FC<ClipPlayerModalProps> = ({ target, onClose }) => {
  useEffect(() => {
    if (!target) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [target, onClose]);

  if (!target) return null;

  const isLibrary = target.kind === 'libraryVideo';
  const title = isLibrary ? target.video.title : target.clip.title;
  const category = isLibrary ? target.video.category : target.clip.category;
  const startSeconds = isLibrary ? target.video.startSeconds : target.clip.startSeconds;
  const endSeconds = isLibrary ? target.video.endSeconds : target.clip.endSeconds;
  const summary = isLibrary ? target.video.summary : target.clip.summary;
  const transcriptSnippet = isLibrary
    ? target.video.transcriptSnippet
    : target.clip.transcriptSnippet;
  const actualWidth = isLibrary ? target.video.actualWidth : target.clip.actualWidth;
  const actualHeight = isLibrary ? target.video.actualHeight : target.clip.actualHeight;
  const fileSizeBytes = isLibrary ? target.video.fileSizeBytes : target.clip.fileSizeBytes;
  const filename = isLibrary ? target.video.filename : target.clip.outputFilename;
  const headerBadge = isLibrary ? target.video.movieTitle : `Clip #${target.clip.index}`;

  const streamSrc = isLibrary
    ? apiUrl(`/api/videos/${encodeURIComponent(target.video.id)}/stream`)
    : apiUrl(`/api/jobs/${encodeURIComponent(target.jobId)}/clips/${encodeURIComponent(target.clip.id)}/stream`);

  const downloadHref = isLibrary
    ? apiUrl(`/api/videos/${encodeURIComponent(target.video.id)}/download`)
    : apiUrl(`/api/jobs/${encodeURIComponent(target.jobId)}/clips/${encodeURIComponent(target.clip.id)}/download`);

  const playerKey = isLibrary ? target.video.id : `${target.jobId}_${target.clip.id}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-4xl rounded-xl border border-slate-800 bg-[#111622] overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-slate-800">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-400 tabular-nums">
              <span className="font-mono text-amber-400 truncate max-w-[200px]">{headerBadge}</span>
              <span aria-hidden="true">·</span>
              <span>{CATEGORY_LABELS[category]}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">
                {formatTimecode(startSeconds)} – {formatTimecode(endSeconds)}
              </span>
            </div>
            <h2 className="text-base font-semibold text-slate-100 truncate mt-0.5">
              {title}
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
            aria-label="Close preview"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="bg-black">
          <video
            key={playerKey}
            src={streamSrc}
            controls
            autoPlay
            playsInline
            preload="auto"
            className="w-full max-h-[60vh] object-contain"
          />
        </div>

        <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1.5 min-w-0">
            <p className="text-sm text-slate-200">{summary}</p>
            {transcriptSnippet && (
              <p className="text-xs italic text-slate-400">“{transcriptSnippet}”</p>
            )}
            <div className="text-xs text-slate-400 font-mono tabular-nums">
              {actualWidth && actualHeight ? `${actualWidth}×${actualHeight}` : 'MP4'} ·{' '}
              {formatBytes(fileSizeBytes)} · {filename}
            </div>
          </div>

          <a
            href={downloadHref}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="h-4 w-4" />
            <span>Download MP4</span>
          </a>
        </div>
      </div>
    </div>
  );
};

import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  RotateCcw,
  Lock,
  Unlock,
  Move,
  ImagePlus,
  GripHorizontal,
  Film,
  Image as ImageIcon,
} from 'lucide-react';
import type {
  AspectRatioPreset,
  FramingMode,
  MovieMetadata,
  OverlayPlacement,
  SplitMediaFit,
} from '../types/clipper';
import { apiUrl } from '../utils/api';
import { formatTimecode } from '../utils/format';

interface InteractiveFramePreviewProps {
  movie: MovieMetadata;
  aspectRatio: AspectRatioPreset;
  framingMode: FramingMode;
  overlayPreviewUrl?: string;
  overlayPlacement: OverlayPlacement;
  onChangePlacement: (next: OverlayPlacement) => void;
  videoPlacement: OverlayPlacement;
  onChangeVideoPlacement: (next: OverlayPlacement) => void;
  overlayBackdrop: 'fit_blur' | 'crop_fill';
  videoSplitPercent: number;
  onChangeSplitPercent: (next: number) => void;
  splitMediaFit: SplitMediaFit;
  playbackSpeed: number;
  onRequestUploadOverlay: () => void;
  onResetPlacement: () => void;
  onResetVideoPlacement: () => void;
}

type HandleType =
  | 'move'
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'tl'
  | 'tr'
  | 'bl'
  | 'br';

type LayerTarget = 'video' | 'picture';

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function getPreviewContainerLayout(
  ratio: AspectRatioPreset,
  movieWidth: number,
  movieHeight: number
): { className: string; style?: React.CSSProperties } {
  switch (ratio) {
    case '9:16':
      return { className: 'w-[220px] sm:w-[244px] aspect-[9/16]' };
    case '4:5':
      return { className: 'w-[236px] sm:w-[260px] aspect-[4/5]' };
    case '1:1':
      return { className: 'w-[260px] sm:w-[280px] aspect-square' };
    case '16:9':
      return { className: 'w-full max-w-[360px] aspect-video' };
    case 'source':
    default: {
      const isVertical = movieHeight > movieWidth;
      return {
        className: isVertical ? 'w-[220px] sm:w-[244px]' : 'w-full max-w-[360px]',
        style: {
          aspectRatio: `${Math.max(1, movieWidth)} / ${Math.max(1, movieHeight)}`,
        },
      };
    }
  }
}

export const InteractiveFramePreview: React.FC<InteractiveFramePreviewProps> = ({
  movie,
  aspectRatio,
  framingMode,
  overlayPreviewUrl,
  overlayPlacement,
  onChangePlacement,
  videoPlacement,
  onChangeVideoPlacement,
  overlayBackdrop,
  videoSplitPercent,
  onChangeSplitPercent,
  splitMediaFit,
  playbackSpeed,
  onRequestUploadOverlay,
  onResetPlacement,
  onResetVideoPlacement,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const videoZoneRef = useRef<HTMLDivElement | null>(null);
  const overlayZoneRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(movie.durationSeconds || 1);
  const [isDragging, setIsDragging] = useState(false);
  const [activeLayer, setActiveLayer] = useState<LayerTarget>('video');

  const isSplitOverlayMode =
    framingMode === 'video_top_image_bottom' || framingMode === 'image_top_video_bottom';
  const isPictureOnVideoMode = framingMode === 'picture_overlay_on_video';
  const hasInteractiveOverlay = isSplitOverlayMode || isPictureOnVideoMode;

  useEffect(() => {
    if (!hasInteractiveOverlay && activeLayer === 'picture') {
      setActiveLayer('video');
    }
  }, [hasInteractiveOverlay, activeLayer]);

  useEffect(() => {
    if (overlayPreviewUrl && hasInteractiveOverlay) {
      setActiveLayer('picture');
    }
  }, [overlayPreviewUrl]);

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(movie.durationSeconds || 1);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
      videoRef.current.playbackRate = playbackSpeed;
    }
  }, [movie.id]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  const togglePlay = () => {
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      vid.playbackRate = playbackSpeed;
      void vid.play().catch(() => undefined);
    } else {
      vid.pause();
    }
  };

  const handleSeek = (nextSec: number) => {
    const vid = videoRef.current;
    setCurrentTime(nextSec);
    if (vid) {
      vid.currentTime = nextSec;
    }
  };

  const toggleMute = () => {
    const vid = videoRef.current;
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (vid) {
      vid.muted = nextMuted;
    }
  };

  const beginLayerDrag = (
    e: React.PointerEvent,
    target: LayerTarget,
    actionType: HandleType
  ) => {
    const zoneEl = target === 'video' ? videoZoneRef.current : overlayZoneRef.current;
    if (!zoneEl) return;
    e.preventDefault();
    e.stopPropagation();

    setActiveLayer(target);

    const rect = zoneEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const initial = target === 'video' ? { ...videoPlacement } : { ...overlayPlacement };
    const applyChange = target === 'video' ? onChangeVideoPlacement : onChangePlacement;
    const startClientX = e.clientX;
    const startClientY = e.clientY;

    setIsDragging(true);

    const onPointerMove = (moveEv: PointerEvent) => {
      const dxPct = ((moveEv.clientX - startClientX) / rect.width) * 100;
      const dyPct = ((moveEv.clientY - startClientY) / rect.height) * 100;

      if (actionType === 'move') {
        applyChange({
          ...initial,
          xPct: round1(clamp(initial.xPct + dxPct, -120, 120)),
          yPct: round1(clamp(initial.yPct + dyPct, -120, 120)),
        });
        return;
      }

      if (actionType === 'right') {
        applyChange({
          ...initial,
          widthPct: round1(clamp(initial.widthPct + dxPct, 10, 250)),
          lockAspect: false,
        });
        return;
      }

      if (actionType === 'left') {
        const nextW = clamp(initial.widthPct - dxPct, 10, 250);
        const nextX = initial.xPct + (initial.widthPct - nextW);
        applyChange({
          ...initial,
          xPct: round1(nextX),
          widthPct: round1(nextW),
          lockAspect: false,
        });
        return;
      }

      if (actionType === 'bottom') {
        applyChange({
          ...initial,
          heightPct: round1(clamp(initial.heightPct + dyPct, 10, 250)),
          lockAspect: false,
        });
        return;
      }

      if (actionType === 'top') {
        const nextH = clamp(initial.heightPct - dyPct, 10, 250);
        const nextY = initial.yPct + (initial.heightPct - nextH);
        applyChange({
          ...initial,
          yPct: round1(nextY),
          heightPct: round1(nextH),
          lockAspect: false,
        });
        return;
      }

      // Corner handles (tl, tr, bl, br)
      const fromLeft = actionType === 'tl' || actionType === 'bl';
      const fromTop = actionType === 'tl' || actionType === 'tr';
      const dw = fromLeft ? -dxPct : dxPct;
      const dh = fromTop ? -dyPct : dyPct;

      let nextW: number;
      let nextH: number;

      if (initial.lockAspect) {
        const factorW = (initial.widthPct + dw) / Math.max(5, initial.widthPct);
        const factorH = (initial.heightPct + dh) / Math.max(5, initial.heightPct);
        const rawFactor = (factorW + factorH) / 2;
        const minFactor = Math.max(10 / initial.widthPct, 10 / initial.heightPct);
        const maxFactor = Math.min(250 / initial.widthPct, 250 / initial.heightPct);
        const factor = clamp(rawFactor, minFactor, maxFactor);
        nextW = initial.widthPct * factor;
        nextH = initial.heightPct * factor;
      } else {
        nextW = clamp(initial.widthPct + dw, 10, 250);
        nextH = clamp(initial.heightPct + dh, 10, 250);
      }

      const nextX = fromLeft ? initial.xPct + (initial.widthPct - nextW) : initial.xPct;
      const nextY = fromTop ? initial.yPct + (initial.heightPct - nextH) : initial.yPct;

      applyChange({
        ...initial,
        xPct: round1(nextX),
        yPct: round1(nextY),
        widthPct: round1(nextW),
        heightPct: round1(nextH),
      });
    };

    const onPointerUp = () => {
      setIsDragging(false);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const beginSplitDrag = (e: React.PointerEvent) => {
    if (!frameRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = frameRef.current.getBoundingClientRect();
    if (rect.height <= 0) return;

    const startClientY = e.clientY;
    const frameHeight = rect.height;
    const initialSplit = videoSplitPercent;

    setIsDragging(true);

    const onPointerMove = (moveEv: PointerEvent) => {
      const dyPct = ((moveEv.clientY - startClientY) / frameHeight) * 100;
      const nextSplit =
        framingMode === 'video_top_image_bottom'
          ? initialSplit + dyPct
          : initialSplit - dyPct;
      onChangeSplitPercent(Math.round(clamp(nextSplit, 30, 75)));
    };

    const onPointerUp = () => {
      setIsDragging(false);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const renderEightHandles = (target: LayerTarget, label: string) => {
    const isSelected = activeLayer === target;
    if (!isSelected) return null;

    return (
      <>
        <div className="pointer-events-none absolute top-1 left-1 rounded bg-slate-950/85 px-1.5 py-0.5 text-[9px] font-mono text-amber-300 flex items-center gap-1 shadow z-40">
          <Move className="h-2.5 w-2.5" />
          <span>{label}</span>
        </div>

        {/* 4 Edge Handles (inset cleanly inside frame edges so handles stay clickable at 100% size) */}
        <div
          title="Drag top edge to resize height"
          onPointerDown={(e) => beginLayerDrag(e, target, 'top')}
          className="absolute top-0.5 left-1/2 -translate-x-1/2 h-2.5 w-7 rounded-full bg-amber-400 border border-slate-950 shadow cursor-ns-resize touch-none hover:scale-110 transition-transform z-40"
        />
        <div
          title="Drag bottom edge to resize height"
          onPointerDown={(e) => beginLayerDrag(e, target, 'bottom')}
          className="absolute bottom-0.5 left-1/2 -translate-x-1/2 h-2.5 w-7 rounded-full bg-amber-400 border border-slate-950 shadow cursor-ns-resize touch-none hover:scale-110 transition-transform z-40"
        />
        <div
          title="Drag left edge to resize width"
          onPointerDown={(e) => beginLayerDrag(e, target, 'left')}
          className="absolute left-0.5 top-1/2 -translate-y-1/2 w-2.5 h-7 rounded-full bg-amber-400 border border-slate-950 shadow cursor-ew-resize touch-none hover:scale-110 transition-transform z-40"
        />
        <div
          title="Drag right edge to resize width"
          onPointerDown={(e) => beginLayerDrag(e, target, 'right')}
          className="absolute right-0.5 top-1/2 -translate-y-1/2 w-2.5 h-7 rounded-full bg-amber-400 border border-slate-950 shadow cursor-ew-resize touch-none hover:scale-110 transition-transform z-40"
        />

        {/* 4 Corner Handles */}
        <div
          title="Drag top-left corner to resize"
          onPointerDown={(e) => beginLayerDrag(e, target, 'tl')}
          className="absolute top-0.5 left-0.5 h-3.5 w-3.5 rounded-sm bg-amber-300 border-2 border-slate-950 shadow cursor-nwse-resize touch-none hover:scale-110 transition-transform z-40"
        />
        <div
          title="Drag top-right corner to resize"
          onPointerDown={(e) => beginLayerDrag(e, target, 'tr')}
          className="absolute top-0.5 right-0.5 h-3.5 w-3.5 rounded-sm bg-amber-300 border-2 border-slate-950 shadow cursor-nesw-resize touch-none hover:scale-110 transition-transform z-40"
        />
        <div
          title="Drag bottom-left corner to resize"
          onPointerDown={(e) => beginLayerDrag(e, target, 'bl')}
          className="absolute bottom-0.5 left-0.5 h-3.5 w-3.5 rounded-sm bg-amber-300 border-2 border-slate-950 shadow cursor-nesw-resize touch-none hover:scale-110 transition-transform z-40"
        />
        <div
          title="Drag bottom-right corner to resize"
          onPointerDown={(e) => beginLayerDrag(e, target, 'br')}
          className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded-sm bg-amber-300 border-2 border-slate-950 shadow cursor-nwse-resize touch-none hover:scale-110 transition-transform z-40"
        />
      </>
    );
  };

  const frameLayout = getPreviewContainerLayout(aspectRatio, movie.width, movie.height);

  const videoUsesCover =
    (isSplitOverlayMode && splitMediaFit === 'fill') ||
    (isPictureOnVideoMode && aspectRatio !== 'source' && overlayBackdrop === 'crop_fill') ||
    (!hasInteractiveOverlay && aspectRatio !== 'source' && framingMode === 'crop_fill');

  const videoFitClass = !videoPlacement.lockAspect
    ? 'object-fill'
    : videoUsesCover
      ? 'object-cover'
      : 'object-contain';

  const renderVideoLayer = () => (
    <div
      onPointerDown={(e) => beginLayerDrag(e, 'video', 'move')}
      onDoubleClick={togglePlay}
      style={{
        left: `${videoPlacement.xPct}%`,
        top: `${videoPlacement.yPct}%`,
        width: `${videoPlacement.widthPct}%`,
        height: `${videoPlacement.heightPct}%`,
      }}
      className={`absolute group touch-none select-none cursor-grab active:cursor-grabbing ${
        activeLayer === 'video'
          ? `z-30 ${isDragging ? 'ring-2 ring-amber-400' : 'ring-1 ring-amber-400/90'}`
          : 'z-10 ring-1 ring-transparent hover:ring-sky-400/60'
      }`}
    >
      <video
        ref={videoRef}
        src={apiUrl(`/api/movies/${movie.id}/stream`)}
        muted={isMuted}
        playsInline
        loop
        preload="metadata"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          el.playbackRate = playbackSpeed;
          if (Number.isFinite(el.duration) && el.duration > 0) {
            setDuration(el.duration);
          }
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onPlay={() => {
          if (videoRef.current) videoRef.current.playbackRate = playbackSpeed;
          setIsPlaying(true);
        }}
        onPause={() => setIsPlaying(false)}
        className={`w-full h-full pointer-events-none select-none ${videoFitClass}`}
      />
      {renderEightHandles('video', 'Video')}
    </div>
  );

  const renderOverlayBox = () => {
    if (!overlayPreviewUrl) {
      return (
        <button
          type="button"
          onClick={onRequestUploadOverlay}
          className="inset-2 absolute border border-dashed border-amber-500/60 bg-amber-500/5 hover:bg-amber-500/10 rounded-md flex flex-col items-center justify-center gap-1.5 px-2 text-center transition-colors cursor-pointer z-20"
        >
          <ImagePlus className="h-5 w-5 text-amber-400" />
          <span className="text-[11px] font-medium text-amber-200">Click to Select Picture</span>
          <span className="text-[10px] text-slate-400">Drag & resize with cursor</span>
        </button>
      );
    }

    return (
      <div
        onPointerDown={(e) => beginLayerDrag(e, 'picture', 'move')}
        style={{
          left: `${overlayPlacement.xPct}%`,
          top: `${overlayPlacement.yPct}%`,
          width: `${overlayPlacement.widthPct}%`,
          height: `${overlayPlacement.heightPct}%`,
        }}
        className={`absolute group touch-none select-none cursor-grab active:cursor-grabbing ${
          activeLayer === 'picture'
            ? `z-30 ${isDragging ? 'ring-2 ring-amber-400' : 'ring-1 ring-amber-400/90'}`
            : 'z-20 ring-1 ring-white/25 hover:ring-amber-400/70'
        }`}
      >
        <img
          src={overlayPreviewUrl}
          alt="Preview overlay picture"
          draggable={false}
          className={`w-full h-full pointer-events-none select-none ${
            overlayPlacement.lockAspect ? 'object-contain' : 'object-fill'
          }`}
        />
        {renderEightHandles('picture', 'Picture')}
      </div>
    );
  };

  const editedPlacement = activeLayer === 'video' ? videoPlacement : overlayPlacement;
  const updateEditedPlacement =
    activeLayer === 'video' ? onChangeVideoPlacement : onChangePlacement;
  const resetEditedPlacement =
    activeLayer === 'video' ? onResetVideoPlacement : onResetPlacement;

  return (
    <div className="rounded-xl border border-slate-800 bg-[#0B0E14] p-4 flex flex-col items-center gap-3.5">
      <div className="w-full flex items-center justify-between gap-2">
        <div className="text-[11px] font-mono uppercase tracking-wider text-slate-300">
          Live Interactive Preview ({aspectRatio === 'source' ? `${movie.width}×${movie.height}` : aspectRatio})
        </div>
        {playbackSpeed !== 1 && (
          <span className="text-[11px] font-mono text-amber-400 tabular-nums">
            {playbackSpeed}x speed
          </span>
        )}
      </div>

      {/* Output Ratio Frame */}
      <div
        ref={frameRef}
        style={frameLayout.style}
        className={`${frameLayout.className} rounded-lg border border-slate-700 bg-[#0B0E14] overflow-hidden relative flex flex-col shadow-inner select-none`}
      >
        {isSplitOverlayMode ? (
          framingMode === 'video_top_image_bottom' ? (
            <>
              <div
                ref={videoZoneRef}
                style={{ height: `${videoSplitPercent}%` }}
                className="w-full relative bg-[#0B0E14] overflow-hidden shrink-0"
              >
                {renderVideoLayer()}
              </div>

              {/* Draggable Split Divider */}
              <div
                onPointerDown={beginSplitDrag}
                title="Drag up/down to adjust Video vs Picture split ratio"
                className="h-2 w-full bg-slate-800 hover:bg-amber-500/70 border-y border-slate-700 flex items-center justify-center cursor-ns-resize touch-none shrink-0 z-30 transition-colors"
              >
                <GripHorizontal className="h-3 w-3 text-slate-300" />
              </div>

              <div
                ref={overlayZoneRef}
                style={{ height: `calc(${100 - videoSplitPercent}% - 8px)` }}
                className="w-full relative bg-[#0B0E14] overflow-hidden flex-1"
              >
                {renderOverlayBox()}
              </div>
            </>
          ) : (
            <>
              <div
                ref={overlayZoneRef}
                style={{ height: `calc(${100 - videoSplitPercent}% - 8px)` }}
                className="w-full relative bg-[#0B0E14] overflow-hidden flex-1"
              >
                {renderOverlayBox()}
              </div>

              {/* Draggable Split Divider */}
              <div
                onPointerDown={beginSplitDrag}
                title="Drag up/down to adjust Picture vs Video split ratio"
                className="h-2 w-full bg-slate-800 hover:bg-amber-500/70 border-y border-slate-700 flex items-center justify-center cursor-ns-resize touch-none shrink-0 z-30 transition-colors"
              >
                <GripHorizontal className="h-3 w-3 text-slate-300" />
              </div>

              <div
                ref={videoZoneRef}
                style={{ height: `${videoSplitPercent}%` }}
                className="w-full relative bg-[#0B0E14] overflow-hidden shrink-0"
              >
                {renderVideoLayer()}
              </div>
            </>
          )
        ) : isPictureOnVideoMode ? (
          <div
            ref={(el) => {
              videoZoneRef.current = el;
              overlayZoneRef.current = el;
            }}
            className="w-full h-full relative overflow-hidden bg-[#0E121B]"
          >
            {renderVideoLayer()}
            {renderOverlayBox()}
          </div>
        ) : (
          <div ref={videoZoneRef} className="w-full h-full relative overflow-hidden bg-[#0E121B]">
            {renderVideoLayer()}
          </div>
        )}
      </div>

      {/* Video Preview Transport Controls */}
      <div className="w-full rounded-lg border border-slate-800 bg-[#111622] px-3 py-2 flex items-center gap-2.5">
        <button
          type="button"
          onClick={togglePlay}
          className="h-7 w-7 rounded-md bg-amber-500 text-slate-950 hover:bg-amber-400 flex items-center justify-center shrink-0 cursor-pointer transition-colors"
          aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
        >
          {isPlaying ? (
            <Pause className="h-3.5 w-3.5 fill-current" />
          ) : (
            <Play className="h-3.5 w-3.5 fill-current ml-0.5" />
          )}
        </button>

        <input
          type="range"
          min={0}
          max={Math.max(1, duration)}
          step={0.25}
          value={Math.min(currentTime, duration)}
          onChange={(e) => handleSeek(Number(e.target.value))}
          aria-label="Preview video scrub bar"
          className="flex-1 accent-amber-500 cursor-pointer"
        />

        <span className="text-[11px] font-mono text-slate-300 tabular-nums whitespace-nowrap">
          {formatTimecode(currentTime)} / {formatTimecode(duration)}
        </span>

        <button
          type="button"
          onClick={toggleMute}
          className="p-1.5 rounded-md border border-slate-800 text-slate-300 hover:text-white hover:border-slate-700 cursor-pointer shrink-0"
          aria-label={isMuted ? 'Unmute preview audio' : 'Mute preview audio'}
          title={isMuted ? 'Unmute preview' : 'Mute preview'}
        >
          {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* Layer Size & Position Controls (Video + Picture) */}
      <div className="w-full rounded-lg border border-slate-800 bg-[#111622] p-3 space-y-3">
        {hasInteractiveOverlay && (
          <div className="flex items-center gap-1.5 p-1 rounded-md bg-[#0B0E14] border border-slate-800">
            <button
              type="button"
              onClick={() => setActiveLayer('video')}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                activeLayer === 'video'
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Film className="h-3.5 w-3.5" />
              <span>Edit Video</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveLayer('picture')}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                activeLayer === 'picture'
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <ImageIcon className="h-3.5 w-3.5" />
              <span>Edit Picture</span>
            </button>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-200">
            {activeLayer === 'video' ? 'Video Size & Position' : 'Picture Size & Position'}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                updateEditedPlacement({
                  ...editedPlacement,
                  lockAspect: !editedPlacement.lockAspect,
                })
              }
              className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border transition-colors cursor-pointer ${
                editedPlacement.lockAspect
                  ? 'border-amber-500/60 bg-amber-500/15 text-amber-200'
                  : 'border-slate-700 bg-[#0B0E14] text-slate-300'
              }`}
              title={
                editedPlacement.lockAspect
                  ? 'Keep Proportions ON (switch to Free Stretch or drag edge handles)'
                  : 'Free Stretch ON (widen or heighten freely)'
              }
            >
              {editedPlacement.lockAspect ? (
                <>
                  <Lock className="h-3 w-3" />
                  <span>Keep Ratio</span>
                </>
              ) : (
                <>
                  <Unlock className="h-3 w-3" />
                  <span>Free Stretch</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={resetEditedPlacement}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-slate-300 hover:text-white rounded border border-slate-800 bg-[#0B0E14] cursor-pointer"
              title="Reset size & center position"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Reset</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex items-center justify-between text-[11px] text-slate-300 mb-1">
              <span>Width</span>
              <span className="font-mono text-amber-400 tabular-nums">
                {Math.round(editedPlacement.widthPct)}%
              </span>
            </div>
            <input
              type="range"
              min={10}
              max={200}
              step={1}
              value={editedPlacement.widthPct}
              onChange={(e) => {
                const nextW = Number(e.target.value);
                updateEditedPlacement({
                  ...editedPlacement,
                  widthPct: nextW,
                  lockAspect: false,
                });
              }}
              aria-label="Active layer width percentage"
              className="w-full accent-amber-500 cursor-pointer"
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-[11px] text-slate-300 mb-1">
              <span>Height</span>
              <span className="font-mono text-amber-400 tabular-nums">
                {Math.round(editedPlacement.heightPct)}%
              </span>
            </div>
            <input
              type="range"
              min={10}
              max={200}
              step={1}
              value={editedPlacement.heightPct}
              onChange={(e) => {
                const nextH = Number(e.target.value);
                updateEditedPlacement({
                  ...editedPlacement,
                  heightPct: nextH,
                  lockAspect: false,
                });
              }}
              aria-label="Active layer height percentage"
              className="w-full accent-amber-500 cursor-pointer"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400 pt-1 border-t border-slate-800/80">
          <span className="font-mono tabular-nums">
            X: {Math.round(editedPlacement.xPct)}% · Y: {Math.round(editedPlacement.yPct)}%
          </span>
          <span>Drag to move · Grab any edge or corner to resize</span>
        </div>
      </div>
    </div>
  );
};

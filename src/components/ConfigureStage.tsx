import React, { useRef, useState } from 'react';
import { Play, AlertTriangle, ImagePlus, Gauge, Ratio, Zap, Sparkles } from 'lucide-react';
import {
  MAX_CLIPS_PER_MOVIE,
  computeMaxNonOverlappingClips,
} from '../types/clipper';
import type {
  AspectRatioPreset,
  BatchConfig,
  FramingMode,
  MomentCategory,
  MovieMetadata,
  OverlayPlacement,
  QualityTier,
  SplitMediaFit,
} from '../types/clipper';
import { apiUrl } from '../utils/api';
import {
  ASPECT_RATIO_INFO,
  CATEGORY_LABELS,
  QUALITY_TIER_INFO,
  SPEED_PRESETS,
  formatDurationLabel,
  formatTimecode,
} from '../utils/format';
import { InteractiveFramePreview } from './InteractiveFramePreview';

interface ConfigureStageProps {
  movie: MovieMetadata | null;
  onStartBatch: (config: BatchConfig) => Promise<void>;
  onGoToUpload: () => void;
}

const QUANTITY_PRESETS = [3, 5, 10, 20, 50, 100, 200, 500, 1000];
const DURATION_PRESETS = [
  { label: '15s', seconds: 15 },
  { label: '30s', seconds: 30 },
  { label: '1m', seconds: 60 },
  { label: '2m', seconds: 120 },
  { label: '3m', seconds: 180 },
  { label: '5m', seconds: 300 },
  { label: '10m', seconds: 600 },
];

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

const DEFAULT_SPLIT_PLACEMENT: OverlayPlacement = {
  xPct: 0,
  yPct: 0,
  widthPct: 100,
  heightPct: 100,
  lockAspect: true,
};

const DEFAULT_OVERLAY_PLACEMENT: OverlayPlacement = {
  xPct: 15,
  yPct: 8,
  widthPct: 70,
  heightPct: 26,
  lockAspect: true,
};

export const ConfigureStage: React.FC<ConfigureStageProps> = ({
  movie,
  onStartBatch,
  onGoToUpload,
}) => {
  const overlayInputRef = useRef<HTMLInputElement | null>(null);

  const [quantityMode, setQuantityMode] = useState<'preset' | 'custom' | 'max'>('preset');
  const [presetQty, setPresetQty] = useState<number>(20);
  const [customQty, setCustomQty] = useState<string>('150');

  const [durationMode, setDurationMode] = useState<'preset' | 'custom'>('preset');
  const [presetDuration, setPresetDuration] = useState<number>(30);
  const [customDuration, setCustomDuration] = useState<string>('45');

  const [qualityTier, setQualityTier] = useState<QualityTier>('720p');
  const [analysisMode, setAnalysisMode] = useState<'fast' | 'ai'>('fast');
  const [aspectRatio, setAspectRatio] = useState<AspectRatioPreset>('source');
  const [framingMode, setFramingMode] = useState<FramingMode>('fit_blur');
  const [overlayImageFilename, setOverlayImageFilename] = useState<string | undefined>(undefined);
  const [overlayImageName, setOverlayImageName] = useState<string | undefined>(undefined);
  const [overlayPreviewUrl, setOverlayPreviewUrl] = useState<string | undefined>(undefined);
  const [uploadingOverlay, setUploadingOverlay] = useState<boolean>(false);
  const [overlayPlacement, setOverlayPlacement] = useState<OverlayPlacement>(DEFAULT_SPLIT_PLACEMENT);
  const [videoPlacement, setVideoPlacement] = useState<OverlayPlacement>(DEFAULT_SPLIT_PLACEMENT);
  const [overlayBackdrop, setOverlayBackdrop] = useState<'fit_blur' | 'crop_fill'>('fit_blur');
  const [videoSplitPercent, setVideoSplitPercent] = useState<number>(50);
  const [splitMediaFit, setSplitMediaFit] = useState<SplitMediaFit>('fit');

  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);

  const [focusCategories, setFocusCategories] = useState<MomentCategory[]>(ALL_CATEGORIES);
  const [preventOverlap, setPreventOverlap] = useState<boolean>(true);
  const [allowOverlapWhenExceeding, setAllowOverlapWhenExceeding] = useState<boolean>(false);
  const [workerConcurrency, setWorkerConcurrency] = useState<number>(3);
  const [maxRetries, setMaxRetries] = useState<number>(2);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  if (!movie) {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#111622] p-10 text-center space-y-4">
        <h2 className="text-lg font-semibold text-slate-100">Select or import a movie first</h2>
        <p className="text-sm text-slate-400 max-w-md mx-auto">
          Import an HD video from a link, choose a film from the sidebar, or upload a movie file to configure bulk HD clip extraction.
        </p>
        <button
          type="button"
          onClick={onGoToUpload}
          className="px-5 py-2.5 text-sm font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors cursor-pointer"
        >
          Go to Source Movie
        </button>
      </div>
    );
  }

  const effectiveClipDuration =
    movie.durationSeconds <= 2
      ? Math.max(1, Math.round(movie.durationSeconds))
      : Math.max(
          2,
          Math.min(
            Math.round(movie.durationSeconds),
            durationMode === 'preset' ? presetDuration : Math.max(2, Number(customDuration) || 30)
          )
        );

  const maxNonOverlapping = computeMaxNonOverlappingClips(
    movie.durationSeconds,
    effectiveClipDuration
  );

  const rawInputCount =
    quantityMode === 'max'
      ? maxNonOverlapping
      : quantityMode === 'preset'
        ? presetQty
        : Math.max(1, Math.floor(Number(customQty) || 1));

  const cappedByPerMovieLimit = rawInputCount > MAX_CLIPS_PER_MOVIE;
  const rawRequestedCount = Math.min(MAX_CLIPS_PER_MOVIE, rawInputCount);

  const exceedsNonOverlapping =
    preventOverlap && !allowOverlapWhenExceeding && rawRequestedCount > maxNonOverlapping;

  const projectedClipCount = exceedsNonOverlapping ? maxNonOverlapping : rawRequestedCount;

  const isSplitOverlayMode =
    framingMode === 'video_top_image_bottom' || framingMode === 'image_top_video_bottom';
  const isPictureOverlayMode = framingMode === 'picture_overlay_on_video';
  const hasOverlayLayout = isSplitOverlayMode || isPictureOverlayMode;

  const outputDurationAtSpeed = Math.round((effectiveClipDuration / playbackSpeed) * 10) / 10;

  const selectFramingMode = (nextMode: FramingMode) => {
    setFramingMode(nextMode);
    if (nextMode === 'picture_overlay_on_video' && framingMode !== 'picture_overlay_on_video') {
      setOverlayPlacement(DEFAULT_OVERLAY_PLACEMENT);
    } else if (
      (nextMode === 'video_top_image_bottom' || nextMode === 'image_top_video_bottom') &&
      !isSplitOverlayMode
    ) {
      setOverlayPlacement(DEFAULT_SPLIT_PLACEMENT);
    }
  };

  const handleResetPlacement = () => {
    setOverlayPlacement(
      isPictureOverlayMode ? DEFAULT_OVERLAY_PLACEMENT : DEFAULT_SPLIT_PLACEMENT
    );
  };

  const handleResetVideoPlacement = () => {
    setVideoPlacement(DEFAULT_SPLIT_PLACEMENT);
  };

  const toggleCategory = (cat: MomentCategory) => {
    setFocusCategories((prev) =>
      prev.includes(cat) ? prev.filter((item) => item !== cat) : [...prev, cat]
    );
  };

  const handleUploadOverlay = async (file: File) => {
    if (file.size === 0) {
      setError('Selected picture file is empty.');
      return;
    }
    setError(null);
    setUploadingOverlay(true);
    try {
      const buffer = await file.arrayBuffer();
      const overlayEndpoint = apiUrl(`/api/overlays?filename=${encodeURIComponent(file.name)}`);
      let res = await fetch(overlayEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer,
      });

      if (res.status === 403 || res.status === 406 || res.status === 415) {
        const bytes = new Uint8Array(buffer);
        const parts: string[] = [];
        for (let i = 0; i < bytes.length; i += 0x2000) {
          parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x2000, bytes.length))));
        }
        res = await fetch(overlayEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, dataBase64: btoa(parts.join('')) }),
        });
      }

      const data = (await res.json().catch(() => ({}))) as {
        filename?: string;
        originalName?: string;
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.filename || !data.url) {
        throw new Error(data.error || 'Failed to upload thumbnail picture.');
      }
      setOverlayImageFilename(data.filename);
      setOverlayImageName(data.originalName || file.name);
      setOverlayPreviewUrl(apiUrl(data.url));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload thumbnail image');
    } finally {
      setUploadingOverlay(false);
    }
  };

  const handleLaunch = async () => {
    setError(null);
    if (hasOverlayLayout && !overlayImageFilename) {
      setError('Please upload a thumbnail picture for the selected Picture layout first.');
      return;
    }

    setSubmitting(true);
    try {
      const config: BatchConfig = {
        quantityMode,
        requestedClipCount: rawRequestedCount,
        clipDurationSeconds: effectiveClipDuration,
        qualityTier,
        analysisMode,
        aspectRatio,
        framingMode,
        overlayImageFilename: hasOverlayLayout ? overlayImageFilename : undefined,
        overlayImageName: hasOverlayLayout ? overlayImageName : undefined,
        overlayPlacement: hasOverlayLayout ? overlayPlacement : undefined,
        videoPlacement,
        overlayBackdrop: isPictureOverlayMode ? overlayBackdrop : undefined,
        videoSplitPercent: isSplitOverlayMode ? videoSplitPercent : undefined,
        splitMediaFit: isSplitOverlayMode ? splitMediaFit : undefined,
        playbackSpeed,
        focusCategories: focusCategories.length > 0 ? focusCategories : ALL_CATEGORIES,
        preventOverlap,
        allowOverlapWhenExceeding,
        workerConcurrency,
        maxRetries,
      };
      await onStartBatch(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to launch batch job');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Batch Clip Configuration
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-1">
            <span className="text-slate-200 font-medium">{movie.title}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{formatTimecode(movie.durationSeconds)}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">
              {movie.width}×{movie.height}
            </span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">
              Limit: {MAX_CLIPS_PER_MOVIE.toLocaleString()} clips / movie
            </span>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-900/70 bg-red-950/30 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* 1. Clip Quantity */}
      <section className="rounded-xl border border-slate-800 bg-[#111622] p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Clip Quantity</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Generate up to {MAX_CLIPS_PER_MOVIE.toLocaleString()} clips from a single movie using presets, custom count, or maximum non-overlapping capacity.
            </p>
          </div>
          <div className="text-xs font-mono text-amber-400 tabular-nums shrink-0">
            Target: {projectedClipCount.toLocaleString()} / {MAX_CLIPS_PER_MOVIE.toLocaleString()} max
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {QUANTITY_PRESETS.map((qty) => {
            const active = quantityMode === 'preset' && presetQty === qty;
            return (
              <button
                key={qty}
                type="button"
                onClick={() => {
                  setQuantityMode('preset');
                  setPresetQty(qty);
                }}
                className={`px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                  active
                    ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                    : 'border-slate-800 bg-[#0B0E14] text-slate-300 hover:border-slate-700 hover:text-white'
                }`}
              >
                {qty} clips
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => setQuantityMode('custom')}
            className={`px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              quantityMode === 'custom'
                ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                : 'border-slate-800 bg-[#0B0E14] text-slate-300 hover:border-slate-700 hover:text-white'
            }`}
          >
            Custom Number
          </button>

          <button
            type="button"
            onClick={() => setQuantityMode('max')}
            className={`px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              quantityMode === 'max'
                ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                : 'border-slate-800 bg-[#0B0E14] text-slate-300 hover:border-slate-700 hover:text-white'
            }`}
          >
            Maximum Possible ({maxNonOverlapping.toLocaleString()})
          </button>
        </div>

        {quantityMode === 'custom' && (
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <label htmlFor="custom-qty" className="text-xs text-slate-300 whitespace-nowrap">
              Exact clip count (1–{MAX_CLIPS_PER_MOVIE.toLocaleString()}):
            </label>
            <input
              id="custom-qty"
              type="number"
              min={1}
              max={MAX_CLIPS_PER_MOVIE}
              step={1}
              value={customQty}
              onChange={(e) => setCustomQty(e.target.value)}
              className="w-36 rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-amber-500"
            />
            {cappedByPerMovieLimit ? (
              <span className="text-xs text-amber-300">
                Capped at {MAX_CLIPS_PER_MOVIE.toLocaleString()} clips per movie limit
              </span>
            ) : (
              <span className="text-xs text-slate-400">
                Maximum {MAX_CLIPS_PER_MOVIE.toLocaleString()} clips per movie
              </span>
            )}
          </div>
        )}

        <div className="pt-3 border-t border-slate-800/80 space-y-2">
          <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={preventOverlap}
              onChange={(e) => setPreventOverlap(e.target.checked)}
              className="h-4 w-4 rounded border-slate-700 bg-[#0B0E14] accent-amber-500"
            />
            <span>
              Enforce smart non-overlapping distribution across the full movie timeline
            </span>
          </label>

          {preventOverlap && rawRequestedCount > maxNonOverlapping && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-amber-800/60 bg-amber-950/25 px-3.5 py-2.5 text-xs text-amber-200">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                <span>
                  At {formatDurationLabel(effectiveClipDuration)} per clip, this {formatTimecode(movie.durationSeconds)} movie fits at most{' '}
                  <strong className="font-mono">{maxNonOverlapping}</strong> non-overlapping clips.
                  {!allowOverlapWhenExceeding
                    ? ` Output will automatically cap at ${maxNonOverlapping} unique clips.`
                    : ` Staggered sliding windows enabled to produce ${rawRequestedCount} clips.`}
                </span>
              </div>
              <label className="flex items-center gap-2 shrink-0 cursor-pointer text-amber-300 font-medium">
                <input
                  type="checkbox"
                  checked={allowOverlapWhenExceeding}
                  onChange={(e) => setAllowOverlapWhenExceeding(e.target.checked)}
                  className="h-4 w-4 rounded border-amber-700 bg-[#0B0E14] accent-amber-500"
                />
                <span>Allow staggered windows</span>
              </label>
            </div>
          )}
        </div>
      </section>

      {/* 2. Clip Duration & Video Playback Speed */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="rounded-xl border border-slate-800 bg-[#111622] p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-100">Clip Duration</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Choose target source duration per clip.
              </p>
            </div>
            <div className="text-xs font-mono text-slate-300 tabular-nums">
              {formatDurationLabel(effectiveClipDuration)} / clip
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {DURATION_PRESETS.map((preset) => {
              const active = durationMode === 'preset' && presetDuration === preset.seconds;
              return (
                <button
                  key={preset.seconds}
                  type="button"
                  onClick={() => {
                    setDurationMode('preset');
                    setPresetDuration(preset.seconds);
                  }}
                  className={`px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                      : 'border-slate-800 bg-[#0B0E14] text-slate-300 hover:border-slate-700 hover:text-white'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => setDurationMode('custom')}
              className={`px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                durationMode === 'custom'
                  ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                  : 'border-slate-800 bg-[#0B0E14] text-slate-300 hover:border-slate-700 hover:text-white'
              }`}
            >
              Custom
            </button>
          </div>

          {durationMode === 'custom' && (
            <div className="flex items-center gap-3 pt-2">
              <label htmlFor="custom-dur" className="text-xs text-slate-300 whitespace-nowrap">
                Duration (seconds):
              </label>
              <input
                id="custom-dur"
                type="number"
                min={2}
                max={Math.floor(movie.durationSeconds)}
                value={customDuration}
                onChange={(e) => setCustomDuration(e.target.value)}
                className="w-28 rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-amber-500"
              />
              <span className="text-xs text-slate-400 tabular-nums">
                = {formatTimecode(effectiveClipDuration)}
              </span>
            </div>
          )}
        </section>

        {/* Playback Speed Adjustment */}
        <section className="rounded-xl border border-slate-800 bg-[#111622] p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-amber-400 shrink-0" />
              <div>
                <h2 className="text-base font-semibold text-slate-100">Video Playback Speed</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Adjust audio & video speed for every rendered clip (0.5x – 2.0x).
                </p>
              </div>
            </div>
            <div className="text-xs font-mono text-amber-400 tabular-nums shrink-0">
              {playbackSpeed.toFixed(2).replace(/\.00$/, '.0')}x
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {SPEED_PRESETS.map((sp) => {
              const active = Math.abs(playbackSpeed - sp) < 0.01;
              return (
                <button
                  key={sp}
                  type="button"
                  onClick={() => setPlaybackSpeed(sp)}
                  className={`px-3 py-1.5 text-xs font-medium font-mono rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                    active
                      ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                      : 'border-slate-800 bg-[#0B0E14] text-slate-300 hover:border-slate-700 hover:text-white'
                  }`}
                >
                  {sp}x
                </button>
              );
            })}
          </div>

          <div className="space-y-1.5">
            <input
              type="range"
              min={0.5}
              max={2.0}
              step={0.05}
              value={playbackSpeed}
              onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
              className="w-full accent-amber-500 cursor-pointer"
              aria-label="Video playback speed"
            />
            <div className="flex items-center justify-between text-[11px] text-slate-400 tabular-nums">
              <span>0.5x (Slow-Mo)</span>
              <span>
                Final clip length: <strong className="text-slate-200">{outputDurationAtSpeed}s</strong>{' '}
                {playbackSpeed !== 1 ? `(from ${effectiveClipDuration}s segment)` : ''}
              </span>
              <span>2.0x (Fast)</span>
            </div>
          </div>
        </section>
      </div>

      {/* 3. Platform Aspect Ratio & Split Video + Picture Layout */}
      <section className="rounded-xl border border-slate-800 bg-[#111622] p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Ratio className="h-4 w-4 text-amber-400 shrink-0" />
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Aspect Ratio & Split Thumbnail Layout (TikTok / YouTube / Facebook / Reels)
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Convert any long movie into vertical 9:16, square 1:1, portrait 4:5, or widescreen 16:9 — optionally stacking your video with a persistent top or bottom thumbnail picture.
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {ASPECT_RATIO_INFO.map((item) => {
            const active = aspectRatio === item.ratio;
            return (
              <button
                key={item.ratio}
                type="button"
                onClick={() => setAspectRatio(item.ratio)}
                className={`text-left rounded-lg border p-3.5 transition-colors cursor-pointer ${
                  active
                    ? 'border-amber-500 bg-amber-500/10'
                    : 'border-slate-800 bg-[#0B0E14] hover:border-slate-700'
                }`}
              >
                <div className="text-sm font-semibold text-slate-100">{item.label}</div>
                <div className="text-[11px] text-slate-400 mt-1">{item.platforms}</div>
              </button>
            );
          })}
        </div>

        <div className="pt-4 border-t border-slate-800/80 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 space-y-4">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2.5">
                Video Framing & Overlay Layout
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {aspectRatio !== 'source' && (
                  <>
                    <button
                      type="button"
                      onClick={() => selectFramingMode('fit_blur')}
                      className={`text-left rounded-lg border px-3.5 py-2.5 transition-colors cursor-pointer ${
                        framingMode === 'fit_blur'
                          ? 'border-amber-500 bg-amber-500/15 text-amber-200'
                          : 'border-slate-800 bg-[#0B0E14] text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <div className="text-xs font-semibold">Blur Background (Full Video)</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        Keeps full video frame over a blurred backdrop
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => selectFramingMode('crop_fill')}
                      className={`text-left rounded-lg border px-3.5 py-2.5 transition-colors cursor-pointer ${
                        framingMode === 'crop_fill'
                          ? 'border-amber-500 bg-amber-500/15 text-amber-200'
                          : 'border-slate-800 bg-[#0B0E14] text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <div className="text-xs font-semibold">Center Crop Fill</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        Zooms & crops edge-to-edge to fill ratio
                      </div>
                    </button>
                  </>
                )}

                <button
                  type="button"
                  onClick={() => selectFramingMode('video_top_image_bottom')}
                  className={`text-left rounded-lg border px-3.5 py-2.5 transition-colors cursor-pointer ${
                    framingMode === 'video_top_image_bottom'
                      ? 'border-amber-500 bg-amber-500/15 text-amber-200'
                      : 'border-slate-800 bg-[#0B0E14] text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-semibold">Video on Top + Picture Below</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Video plays in top half, picture stays pinned below
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => selectFramingMode('image_top_video_bottom')}
                  className={`text-left rounded-lg border px-3.5 py-2.5 transition-colors cursor-pointer ${
                    framingMode === 'image_top_video_bottom'
                      ? 'border-amber-500 bg-amber-500/15 text-amber-200'
                      : 'border-slate-800 bg-[#0B0E14] text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-semibold">Picture on Top + Video Below</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Picture stays pinned on top, video plays below
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => selectFramingMode('picture_overlay_on_video')}
                  className={`text-left rounded-lg border px-3.5 py-2.5 transition-colors cursor-pointer ${
                    framingMode === 'picture_overlay_on_video'
                      ? 'border-amber-500 bg-amber-500/15 text-amber-200'
                      : 'border-slate-800 bg-[#0B0E14] text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-semibold">Picture Overlay on Video</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Drag & resize picture anywhere directly on top of video
                  </div>
                </button>

                {aspectRatio === 'source' && hasOverlayLayout && (
                  <button
                    type="button"
                    onClick={() => selectFramingMode('fit_blur')}
                    className="text-left rounded-lg border border-slate-800 bg-[#0B0E14] px-3.5 py-2.5 text-slate-300 hover:border-slate-700 transition-colors cursor-pointer"
                  >
                    <div className="text-xs font-semibold">Standard Full Video (No Image)</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Revert to normal full-frame video output
                    </div>
                  </button>
                )}
              </div>
            </div>

            {hasOverlayLayout && (
              <div className="rounded-xl border border-slate-800 bg-[#0B0E14] p-4 space-y-4">
                <input
                  ref={overlayInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const selected = e.target.files?.[0];
                    if (selected) {
                      void handleUploadOverlay(selected);
                      e.target.value = '';
                    }
                  }}
                />

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-12 w-12 rounded-lg border border-slate-800 bg-[#111622] flex items-center justify-center overflow-hidden shrink-0">
                      {overlayPreviewUrl ? (
                        <img
                          src={overlayPreviewUrl}
                          alt="Overlay thumbnail"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <ImagePlus className="h-5 w-5 text-amber-400" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-slate-100 truncate">
                        {overlayImageName ? overlayImageName : 'Upload Thumbnail / Picture Overlay'}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        PNG, JPG, or WebP · Drag & resize in the live preview panel on the right
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={uploadingOverlay}
                    onClick={() => overlayInputRef.current?.click()}
                    className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {uploadingOverlay
                      ? 'Uploading Picture...'
                      : overlayPreviewUrl
                        ? 'Change Picture'
                        : 'Select Picture'}
                  </button>
                </div>

                {isSplitOverlayMode && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-800/80">
                    <div>
                      <div className="flex items-center justify-between text-xs text-slate-300 mb-1">
                        <span>Split Balance (Video / Picture)</span>
                        <span className="font-mono text-amber-400 tabular-nums">
                          {videoSplitPercent}% / {100 - videoSplitPercent}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={30}
                        max={75}
                        step={1}
                        value={videoSplitPercent}
                        onChange={(e) => setVideoSplitPercent(Number(e.target.value))}
                        className="w-full accent-amber-500 cursor-pointer"
                      />
                    </div>

                    <div>
                      <div className="text-xs text-slate-300 mb-1.5">Video Panel Fit</div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setSplitMediaFit('fit')}
                          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                            splitMediaFit === 'fit'
                              ? 'border-amber-500 bg-amber-500/15 text-amber-200'
                              : 'border-slate-800 bg-[#111622] text-slate-400'
                          }`}
                        >
                          Fit Full Video
                        </button>
                        <button
                          type="button"
                          onClick={() => setSplitMediaFit('fill')}
                          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                            splitMediaFit === 'fill'
                              ? 'border-amber-500 bg-amber-500/15 text-amber-200'
                              : 'border-slate-800 bg-[#111622] text-slate-400'
                          }`}
                        >
                          Crop to Fill
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {isPictureOverlayMode && aspectRatio !== 'source' && (
                  <div className="pt-2 border-t border-slate-800/80">
                    <div className="text-xs text-slate-300 mb-1.5">Video Backdrop Framing</div>
                    <div className="flex items-center gap-2 max-w-sm">
                      <button
                        type="button"
                        onClick={() => setOverlayBackdrop('fit_blur')}
                        className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                          overlayBackdrop === 'fit_blur'
                            ? 'border-amber-500 bg-amber-500/15 text-amber-200'
                            : 'border-slate-800 bg-[#111622] text-slate-400'
                        }`}
                      >
                        Blur Background
                      </button>
                      <button
                        type="button"
                        onClick={() => setOverlayBackdrop('crop_fill')}
                        className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                          overlayBackdrop === 'crop_fill'
                            ? 'border-amber-500 bg-amber-500/15 text-amber-200'
                            : 'border-slate-800 bg-[#111622] text-slate-400'
                        }`}
                      >
                        Center Crop Fill
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Interactive Live Video + Picture Preview Editor */}
          <div className="lg:col-span-5">
            <InteractiveFramePreview
              movie={movie}
              aspectRatio={aspectRatio}
              framingMode={framingMode}
              overlayPreviewUrl={overlayPreviewUrl}
              overlayPlacement={overlayPlacement}
              onChangePlacement={setOverlayPlacement}
              videoPlacement={videoPlacement}
              onChangeVideoPlacement={setVideoPlacement}
              overlayBackdrop={overlayBackdrop}
              videoSplitPercent={videoSplitPercent}
              onChangeSplitPercent={setVideoSplitPercent}
              splitMediaFit={splitMediaFit}
              playbackSpeed={playbackSpeed}
              onRequestUploadOverlay={() => overlayInputRef.current?.click()}
              onResetPlacement={handleResetPlacement}
              onResetVideoPlacement={handleResetVideoPlacement}
            />
          </div>
        </div>
      </section>

      {/* 4. Export Quality & Audio Sync */}
      <section className="rounded-xl border border-slate-800 bg-[#111622] p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Export Resolution & A/V Sync</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Preserves frame-accurate audio synchronization up to 4K UHD ({movie.width}×{movie.height} source).
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {QUALITY_TIER_INFO.map((item) => {
            const active = qualityTier === item.tier;
            const cappedBySource =
              aspectRatio === 'source' && item.height !== null && item.height > movie.height;
            return (
              <button
                key={item.tier}
                type="button"
                onClick={() => setQualityTier(item.tier)}
                className={`text-left rounded-lg border p-3.5 transition-colors cursor-pointer ${
                  active
                    ? 'border-amber-500 bg-amber-500/10'
                    : 'border-slate-800 bg-[#0B0E14] hover:border-slate-700'
                }`}
              >
                <div className="text-sm font-semibold text-slate-100">{item.label}</div>
                <div className="text-xs text-slate-400 mt-1">{item.detail}</div>
                <div className="text-[11px] mt-2 font-mono text-slate-400">
                  {cappedBySource
                    ? `Capped at ${movie.height}p source`
                    : item.tier === 'source'
                      ? `Native ${movie.height}p`
                      : 'Export resolution ready'}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* 5. Clip Extraction Mode, AI Focus & Server Worker Capacity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 rounded-xl border border-slate-800 bg-[#111622] p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Clipping Engine Mode & Scene Focus
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Use Instant Fast Mode to slice & render clips within seconds, or Gemini AI Mode for full-movie scene scoring.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setAnalysisMode('fast')}
              className={`text-left rounded-lg border p-3.5 transition-colors cursor-pointer ${
                analysisMode === 'fast'
                  ? 'border-amber-500 bg-amber-500/15 text-amber-200'
                  : 'border-slate-800 bg-[#0B0E14] text-slate-300 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center gap-2 text-xs font-semibold">
                <Zap className="h-4 w-4 text-amber-400 shrink-0" />
                <span>Instant Fast Clip (Seconds)</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                Skips slow movie pre-encoding & runs parallel high-speed FFmpeg cuts immediately (zero re-encode on Original ratio).
              </div>
            </button>

            <button
              type="button"
              onClick={() => setAnalysisMode('ai')}
              className={`text-left rounded-lg border p-3.5 transition-colors cursor-pointer ${
                analysisMode === 'ai'
                  ? 'border-amber-500 bg-amber-500/15 text-amber-200'
                  : 'border-slate-800 bg-[#0B0E14] text-slate-300 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center gap-2 text-xs font-semibold">
                <Sparkles className="h-4 w-4 text-amber-400 shrink-0" />
                <span>AI Smart Highlights (Gemini)</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                Analyzes chronological chunks from 00:00:00 to {formatTimecode(movie.durationSeconds)} to prioritize dialogue & action peaks.
              </div>
            </button>
          </div>

          <div className="pt-2 border-t border-slate-800/80 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-300">
                AI Moment Categories{' '}
                {analysisMode === 'fast' ? '(used when AI Mode is selected)' : ''}
              </span>
              <button
                type="button"
                onClick={() => setFocusCategories(ALL_CATEGORIES)}
                className="text-xs text-amber-400 hover:text-amber-300 cursor-pointer whitespace-nowrap"
              >
                Select All
              </button>
            </div>

            <div
              className={`flex flex-wrap gap-2 transition-opacity ${
                analysisMode === 'fast' ? 'opacity-60' : 'opacity-100'
              }`}
            >
              {ALL_CATEGORIES.map((cat) => {
                const selected = focusCategories.includes(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => toggleCategory(cat)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      selected
                        ? 'border-amber-500/70 bg-amber-500/15 text-amber-200'
                        : 'border-slate-800 bg-[#0B0E14] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {CATEGORY_LABELS[cat]}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-800 bg-[#111622] p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Server Queue Capacity</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Configure parallel FFmpeg workers and retry policy.
            </p>
          </div>

          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between text-xs text-slate-300 mb-1.5">
                <span>Parallel FFmpeg Workers</span>
                <span className="font-mono text-amber-400 tabular-nums">{workerConcurrency} workers</span>
              </div>
              <input
                type="range"
                min={1}
                max={6}
                value={workerConcurrency}
                onChange={(e) => setWorkerConcurrency(Number(e.target.value))}
                className="w-full accent-amber-500 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-xs text-slate-300 mb-1.5">
                <span>Automatic Clip Retries</span>
                <span className="font-mono text-slate-200 tabular-nums">{maxRetries} retries</span>
              </div>
              <input
                type="range"
                min={0}
                max={5}
                value={maxRetries}
                onChange={(e) => setMaxRetries(Number(e.target.value))}
                className="w-full accent-amber-500 cursor-pointer"
              />
            </div>
          </div>
        </section>
      </div>

      {/* Submit Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-slate-800 bg-[#111622] px-6 py-4">
        <div className="text-xs text-slate-300 space-y-0.5">
          <div className="font-medium text-slate-100">
            Ready to process {projectedClipCount.toLocaleString()} × {formatDurationLabel(effectiveClipDuration)} clips
            {playbackSpeed !== 1 ? ` at ${playbackSpeed}x speed` : ''}
          </div>
          <div className="text-slate-400 tabular-nums">
            Ratio: {aspectRatio === 'source' ? 'Original' : aspectRatio} ·{' '}
            {isSplitOverlayMode
              ? framingMode === 'video_top_image_bottom'
                ? 'Video Top + Picture Bottom'
                : 'Picture Top + Video Bottom'
              : isPictureOverlayMode
                ? 'Picture Overlay on Video'
                : aspectRatio === 'source'
                  ? 'Full Frame'
                  : framingMode === 'crop_fill'
                    ? 'Center Crop'
                    : 'Blur Fill'}{' '}
            · {qualityTier.toUpperCase()} MP4 + ZIP
          </div>
        </div>

        <button
          type="button"
          onClick={() => void handleLaunch()}
          disabled={submitting || uploadingOverlay}
          className="inline-flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Play className="h-4 w-4 fill-current" />
          <span>
            {submitting
              ? 'Starting Background Queue...'
              : analysisMode === 'fast'
                ? `Fast Generate ${projectedClipCount.toLocaleString()} Clips`
                : `Analyze Full Movie & Generate ${projectedClipCount.toLocaleString()} Clips`}
          </span>
        </button>
      </div>
    </div>
  );
};

export const MAX_CLIPS_PER_MOVIE = 1000;

export function computeMaxNonOverlappingClips(
  totalDurationSeconds: number,
  clipDurationSeconds: number
): number {
  const safeTotal = Math.max(1, totalDurationSeconds);
  const safeClipDur =
    safeTotal <= 2
      ? safeTotal
      : Math.max(2, Math.min(clipDurationSeconds, safeTotal));
  const tolerance = Math.min(1, safeClipDur * 0.05);
  const rawMax = Math.max(1, Math.floor((safeTotal + tolerance) / safeClipDur));
  return Math.min(MAX_CLIPS_PER_MOVIE, rawMax);
}

export type QualityTier = 'source' | '720p' | '1080p' | '2k' | '4k';
export type ImportQualityTier = 'best_hd' | '720p' | '1080p' | '2k' | '4k';
export type AspectRatioPreset = 'source' | '9:16' | '16:9' | '1:1' | '4:5';
export type FramingMode =
  | 'fit_blur'
  | 'crop_fill'
  | 'video_top_image_bottom'
  | 'image_top_video_bottom'
  | 'picture_overlay_on_video';
export type SplitMediaFit = 'fit' | 'fill';

export interface OverlayPlacement {
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  lockAspect: boolean;
}

export type UrlImportStatus =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'merging'
  | 'probing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface UrlImportJob {
  id: string;
  url: string;
  requestedTitle?: string;
  resolvedTitle?: string;
  preferredQuality: ImportQualityTier;
  status: UrlImportStatus;
  statusMessage: string;
  progressPercent: number;
  downloadedText?: string;
  totalSizeText?: string;
  speedText?: string;
  etaText?: string;
  error?: string;
  movie?: MovieMetadata;
  createdAt: string;
  updatedAt: string;
}

export type MomentCategory =
  | 'scene'
  | 'dialogue'
  | 'action'
  | 'emotional'
  | 'comedy'
  | 'memorable_quote'
  | 'story_milestone'
  | 'highlight';

export type JobPhase =
  | 'queued'
  | 'chunking'
  | 'analyzing'
  | 'distributing'
  | 'rendering'
  | 'completed'
  | 'paused'
  | 'failed'
  | 'cancelled';

export type ChunkStatus =
  | 'pending'
  | 'extracting'
  | 'analyzing'
  | 'completed'
  | 'failed';

export type ClipStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed';

export interface MovieMetadata {
  id: string;
  title: string;
  originalFilename: string;
  sourceUrl?: string;
  filePath: string;
  fileSizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  hasAudio: boolean;
  bitrateKbps: number;
  previewPath?: string;
  previewStatus?: 'ready' | 'preparing';
  createdAt: string;
}

export interface DetectedMoment {
  id: string;
  chunkIndex: number;
  startSeconds: number;
  endSeconds: number;
  peakSeconds: number;
  title: string;
  category: MomentCategory;
  summary: string;
  transcriptSnippet?: string;
  score: number;
  source: 'gemini' | 'ffmpeg_scene';
}

export interface AnalysisChunk {
  index: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  status: ChunkStatus;
  momentsFound: number;
  error?: string;
  attempts: number;
}

export interface GeneratedClip {
  id: string;
  index: number;
  chunkIndex: number;
  title: string;
  category: MomentCategory;
  summary: string;
  transcriptSnippet?: string;
  score: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  status: ClipStatus;
  attempts: number;
  error?: string;
  outputFilename: string;
  outputPath?: string;
  thumbnailPath?: string;
  fileSizeBytes?: number;
  actualWidth?: number;
  actualHeight?: number;
  completedAt?: string;
}

export interface BatchConfig {
  quantityMode: 'preset' | 'custom' | 'max';
  requestedClipCount: number;
  clipDurationSeconds: number;
  qualityTier: QualityTier;
  analysisMode?: 'fast' | 'ai';
  aspectRatio?: AspectRatioPreset;
  framingMode?: FramingMode;
  overlayImageFilename?: string;
  overlayImageName?: string;
  overlayPlacement?: OverlayPlacement;
  videoPlacement?: OverlayPlacement;
  overlayBackdrop?: 'fit_blur' | 'crop_fill';
  videoSplitPercent?: number;
  splitMediaFit?: SplitMediaFit;
  playbackSpeed?: number;
  focusCategories: MomentCategory[];
  preventOverlap: boolean;
  allowOverlapWhenExceeding: boolean;
  workerConcurrency: number;
  maxRetries: number;
}

export interface BatchJob {
  id: string;
  movieId: string;
  movieTitle: string;
  movieDurationSeconds: number;
  movieWidth: number;
  movieHeight: number;
  config: BatchConfig;
  phase: JobPhase;
  statusMessage: string;
  error?: string;
  chunks: AnalysisChunk[];
  moments: DetectedMoment[];
  clips: GeneratedClip[];
  stats: {
    totalRequested: number;
    completed: number;
    processing: number;
    failed: number;
    remaining: number;
    progressPercent: number;
    analyzedChunks: number;
    totalChunks: number;
    analysisPercent: number;
    renderPercent: number;
    totalOutputBytes: number;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface LibraryVideo {
  id: string;
  jobId: string;
  clipId: string;
  movieId: string;
  movieTitle: string;
  title: string;
  caption: string;
  summary: string;
  transcriptSnippet?: string;
  category: MomentCategory;
  score: number;
  filename: string;
  filePath: string;
  thumbnailPath?: string;
  fileSizeBytes: number;
  durationSeconds: number;
  startSeconds: number;
  endSeconds: number;
  actualWidth?: number;
  actualHeight?: number;
  aspectRatio: AspectRatioPreset;
  playbackSpeed: number;
  partNumber?: number;
  totalParts?: number;
  jobCreatedAt?: string;
  createdAt: string;
}

export interface VideoFeedItem {
  id: string;
  title: string;
  caption: string;
  description: string;
  category: MomentCategory;
  partNumber?: number;
  totalParts?: number;
  url: string;
  videoUrl: string;
  video_url: string;
  downloadUrl: string;
  download_url: string;
  thumbnailUrl?: string;
  thumbnail_url?: string;
  filename: string;
  mimeType: string;
  duration: number;
  durationSeconds: number;
  width?: number;
  height?: number;
  aspectRatio: AspectRatioPreset;
  fileSizeBytes: number;
  jobId: string;
  movieId: string;
  movieTitle: string;
  createdAt: string;
}

export interface IntegrationSettings {
  feedEnabled: boolean;
  authEnabled: boolean;
  apiKey: string;
  webhookUrl: string;
}

export type WatchConnectionState =
  | 'disabled'
  | 'connecting'
  | 'connected_sse'
  | 'polling_json'
  | 'auth_blocked'
  | 'error';

export interface WatchSourceConfig {
  enabled: boolean;
  locked: boolean;
  switchLocked?: boolean;
  eventsUrl: string;
  authHeaderName: string;
  authToken: string;
  autoClip: boolean;
  aspectRatio: AspectRatioPreset;
  framingMode: FramingMode;
  clipDurationSeconds: number;
  quantityMode: 'max' | 'preset';
  requestedClipCount: number;
  qualityTier: QualityTier;
  analysisMode: 'fast' | 'ai';
  workerConcurrency: number;
}

export interface WatchDetectedItem {
  id: string;
  sourceKey: string;
  videoUrl: string;
  fallbackUrls?: string[];
  title: string;
  status: 'queued' | 'downloading' | 'clipping' | 'completed' | 'cleaned' | 'failed';
  statusMessage: string;
  movieId?: string;
  jobId?: string;
  clipsTotal?: number;
  clipsCompleted?: number;
  cleanupAt?: string;
  cleanedAt?: string;
  error?: string;
  detectedAt: string;
  updatedAt: string;
}

export interface YoutubeCookiesStatus {
  configured: boolean;
  cookieCount: number;
  domains: string[];
  updatedAt?: string;
}

export interface WatchPingResult {
  ok: boolean;
  state: WatchConnectionState;
  httpStatus?: number;
  latencyMs: number;
  contentType?: string;
  detectedVideosCount?: number;
  resolvedUrl?: string;
  message: string;
  checkedAt: string;
}

export interface ExternalFeedVideo {
  sourceKey: string;
  videoUrl: string;
  fallbackUrls?: string[];
  title: string;
  alreadyProcessed: boolean;
}

export interface WatchFetchResult {
  ping: WatchPingResult;
  videos: ExternalFeedVideo[];
}

export interface WatchStatusResponse {
  config: WatchSourceConfig;
  state: WatchConnectionState;
  statusMessage: string;
  lastCheckedAt?: string;
  lastError?: string;
  lastPing?: WatchPingResult;
  breakActive?: boolean;
  breakEndsAt?: string;
  breakItemTitle?: string;
  crawlIntervalSeconds?: number;
  items: WatchDetectedItem[];
  ingestUrl?: string;
  feedUrl?: string;
}

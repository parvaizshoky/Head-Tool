import { spawn, spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AspectRatioPreset,
  FramingMode,
  MovieMetadata,
  OverlayPlacement,
  QualityTier,
  SplitMediaFit,
} from '../src/types/clipper.ts';

interface FFprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  tags?: Record<string, string>;
}

interface FFprobeOutput {
  format?: {
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
  streams?: FFprobeStream[];
}

let cachedFfmpegPath: string | null = null;
let cachedFfprobePath: string | null = null;
let cachedSupportsDrawtext: boolean | null = null;

function isExecutableFile(candidatePath: string): boolean {
  try {
    if (!candidatePath || !fsSync.existsSync(candidatePath)) return false;
    const stat = fsSync.statSync(candidatePath);
    if (!stat.isFile()) return false;
    fsSync.accessSync(candidatePath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureExecutable(candidatePath: string): boolean {
  try {
    if (!candidatePath || !fsSync.existsSync(candidatePath)) return false;
    const stat = fsSync.statSync(candidatePath);
    if (!stat.isFile()) return false;
    try {
      fsSync.accessSync(candidatePath, fsSync.constants.X_OK);
      return true;
    } catch {
      fsSync.chmodSync(candidatePath, 0o755);
      fsSync.accessSync(candidatePath, fsSync.constants.X_OK);
      return true;
    }
  } catch {
    return false;
  }
}

function findBinaryOnPath(binaryName: string): string | null {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binaryName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function getFfmpegPath(): string {
  if (cachedFfmpegPath && isExecutableFile(cachedFfmpegPath)) {
    return cachedFfmpegPath;
  }

  const candidates = [
    process.env.FFMPEG_PATH,
    findBinaryOnPath('ffmpeg'),
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/bin/ffmpeg',
    path.join(os.tmpdir(), 'framesplit-bin', 'ffmpeg'),
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    if (ensureExecutable(candidate)) {
      cachedFfmpegPath = candidate;
      return candidate;
    }
  }

  throw new Error(
    'FFmpeg binary could not be located. Ensure ffmpeg is installed on PATH or set FFMPEG_PATH.'
  );
}

export function getFfprobePath(): string {
  if (cachedFfprobePath && isExecutableFile(cachedFfprobePath)) {
    return cachedFfprobePath;
  }

  const candidates = [
    process.env.FFPROBE_PATH,
    findBinaryOnPath('ffprobe'),
    '/usr/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/bin/ffprobe',
    path.join(os.tmpdir(), 'framesplit-bin', 'ffprobe'),
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    if (ensureExecutable(candidate)) {
      cachedFfprobePath = candidate;
      return candidate;
    }
  }

  throw new Error(
    'FFprobe binary could not be located. Ensure ffprobe is installed on PATH or set FFPROBE_PATH.'
  );
}

function supportsDrawtextFilter(ffmpegBin: string): boolean {
  if (cachedSupportsDrawtext !== null) return cachedSupportsDrawtext;
  try {
    const res = spawnSync(ffmpegBin, ['-hide_banner', '-filters'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    cachedSupportsDrawtext = /\bdrawtext\b/.test(combined);
  } catch {
    cachedSupportsDrawtext = false;
  }
  return cachedSupportsDrawtext;
}

function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep tail of stderr to avoid unbounded memory for long FFmpeg logs
      stderr += chunk.toString();
      if (stderr.length > 32768) {
        stderr = stderr.slice(-16384);
      }
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${path.basename(command)} exited with code ${code}: ${stderr.slice(-800)}`));
      }
    });
  });
}

function parseFrameRate(raw?: string): number {
  if (!raw) return 24;
  const parts = raw.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (den > 0 && Number.isFinite(num / den)) {
      return Math.round((num / den) * 100) / 100;
    }
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}

function parseHmsDurationTag(raw?: string): number {
  if (!raw) return 0;
  const match = /^(\d+):(\d{2}):(\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export async function probeVideo(
  filePath: string,
  id: string,
  originalFilename: string,
  title?: string
): Promise<MovieMetadata> {
  const stat = await fs.stat(filePath);
  if (stat.size === 0) {
    throw new Error('Uploaded video file is empty (0 bytes).');
  }

  const ffprobeBin = getFfprobePath();
  const { stdout } = await runProcess(ffprobeBin, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as FFprobeOutput;
  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');

  if (!videoStream) {
    throw new Error('No video stream found in uploaded file.');
  }

  const rawDuration =
    Number(parsed.format?.duration) ||
    Number(videoStream.duration) ||
    Number(audioStream?.duration) ||
    parseHmsDurationTag(videoStream.tags?.DURATION) ||
    parseHmsDurationTag(audioStream?.tags?.DURATION) ||
    0;

  const durationSeconds = Math.max(1, Number.isFinite(rawDuration) ? rawDuration : 1);
  const width = videoStream.width ?? 1920;
  const height = videoStream.height ?? 1080;
  const fps = parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate);
  const bitrateKbps = Math.round(Number(parsed.format?.bit_rate ?? 0) / 1000);

  return {
    id,
    title: title || originalFilename.replace(/\.[^/.]+$/, ''),
    originalFilename,
    filePath,
    fileSizeBytes: stat.size,
    durationSeconds,
    width,
    height,
    fps,
    videoCodec: videoStream.codec_name ?? 'unknown',
    audioCodec: audioStream?.codec_name ?? null,
    hasAudio: Boolean(audioStream),
    bitrateKbps,
    createdAt: new Date().toISOString(),
  };
}

export async function probeDurationSeconds(filePath: string): Promise<number> {
  try {
    const ffprobeBin = getFfprobePath();
    const { stdout } = await runProcess(ffprobeBin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      filePath,
    ]);
    const dur = Number(stdout.trim());
    return Number.isFinite(dur) && dur > 0 ? dur : 0;
  } catch {
    return 0;
  }
}

/**
 * Checks whether an MP4/M4V file already has its moov atom before mdat so browsers can start playback immediately.
 */
export async function isMp4FaststartReady(filePath: string): Promise<boolean> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(64);
    let offset = 0;
    const stat = await handle.stat();
    const limit = Math.min(stat.size, 2 * 1024 * 1024);

    while (offset < limit) {
      const { bytesRead } = await handle.read(buf, 0, 16, offset);
      if (bytesRead < 8) break;
      const size32 = buf.readUInt32BE(0);
      const atomType = buf.toString('ascii', 4, 8);
      if (atomType === 'moov') return true;
      if (atomType === 'mdat') return false;

      let atomSize = size32;
      if (size32 === 1 && bytesRead >= 16) {
        atomSize = Number(buf.readBigUInt64BE(8));
      } else if (size32 === 0) {
        break;
      }
      if (!Number.isFinite(atomSize) || atomSize < 8) break;
      offset += atomSize;
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function isBrowserNativeMovie(movie: Pick<MovieMetadata, 'filePath' | 'videoCodec' | 'audioCodec'>): boolean {
  const ext = path.extname(movie.filePath).toLowerCase();
  const vCodec = (movie.videoCodec || '').toLowerCase();
  const aCodec = (movie.audioCodec || '').toLowerCase();

  const okContainer = ext === '.mp4' || ext === '.m4v' || ext === '.webm';
  if (!okContainer) return false;

  if (ext === '.webm') {
    const okWebmV = vCodec === 'vp8' || vCodec === 'vp9' || vCodec === 'av1';
    const okWebmA = !aCodec || aCodec === 'opus' || aCodec === 'vorbis';
    return okWebmV && okWebmA;
  }

  const okMp4V = vCodec === 'h264' || vCodec === 'av1' || vCodec === 'vp9';
  const okMp4A = !aCodec || aCodec === 'aac' || aCodec === 'mp3' || aCodec === 'opus';
  return okMp4V && okMp4A;
}

/**
 * Creates a faststart streamable copy at previewPath (pure stream copy, no re-encode)
 * so the original uploaded source movie file is never mutated in-place.
 */
export async function applyFaststartPreview(sourcePath: string, previewPath: string): Promise<void> {
  await fs.mkdir(path.dirname(previewPath), { recursive: true });
  const ffmpegBin = getFfmpegPath();
  const tmpPath = `${previewPath}.faststart.mp4`;
  try {
    await runProcess(ffmpegBin, [
      '-y',
      '-i', sourcePath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c', 'copy',
      '-movflags', '+faststart',
      tmpPath,
    ]);
    await fs.rename(tmpPath, previewPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

/**
 * Generates a lightweight browser-compatible H.264/AAC MP4 preview stream for MKV/AVI/MOV/HEVC uploads.
 * Original source file remains untouched for high-res clip rendering.
 */
export async function generateBrowserPreviewMp4(
  sourcePath: string,
  previewPath: string,
  hasAudio: boolean
): Promise<void> {
  await fs.mkdir(path.dirname(previewPath), { recursive: true });
  const ffmpegBin = getFfmpegPath();
  const tmpPath = `${previewPath}.tmp.mp4`;

  const args = [
    '-y',
    '-threads', '0',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-vf', "scale=-2:'min(540,ih)',scale=trunc(iw/2)*2:trunc(ih/2)*2",
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '28',
    '-pix_fmt', 'yuv420p',
    '-max_muxing_queue_size', '1024',
  ];

  if (hasAudio) {
    args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '96k', '-ac', '2');
  } else {
    args.push('-an');
  }

  args.push('-movflags', '+faststart', tmpPath);

  try {
    await runProcess(ffmpegBin, args);
    await fs.rename(tmpPath, previewPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

/**
 * Extracts a compact proxy MP4 chunk (240p @ 0.5fps + mono 16kHz audio) for Gemini multimodal analysis.
 * Seeking before -i makes extracting chunks from 2-3+ hour movies fast even near the end of the file.
 */
export async function extractAnalysisChunk(
  moviePath: string,
  chunkPath: string,
  startSeconds: number,
  durationSeconds: number,
  hasAudio: boolean
): Promise<void> {
  await fs.mkdir(path.dirname(chunkPath), { recursive: true });
  const ffmpegBin = getFfmpegPath();

  const args = [
    '-y',
    '-threads', '0',
    '-ss', startSeconds.toFixed(3),
    '-i', moviePath,
    '-t', durationSeconds.toFixed(3),
    '-map', '0:v:0',
    '-vf', 'scale=-2:240,fps=0.5,scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '35',
    '-pix_fmt', 'yuv420p',
    '-max_muxing_queue_size', '1024',
  ];

  if (hasAudio) {
    args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '32k', '-ac', '1', '-ar', '16000');
  } else {
    args.push('-an');
  }

  args.push('-movflags', '+faststart', chunkPath);
  await runProcess(ffmpegBin, args);
}

/**
 * Fast FFmpeg visual scene-cut detector within a specific chunk window.
 * Used as structural anchors and supplemental boundaries for ultra-high batch counts (500-1000+ clips).
 */
export async function detectSceneCutsInChunk(
  chunkPath: string,
  chunkStartOffset: number,
  threshold = 0.28
): Promise<number[]> {
  try {
    const ffmpegBin = getFfmpegPath();
    const { stderr } = await runProcess(ffmpegBin, [
      '-i', chunkPath,
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-f', 'null',
      '-',
    ]);

    const timestamps: number[] = [];
    const regex = /pts_time:([0-9.]+)/g;
    let match: RegExpExecArray | null = regex.exec(stderr);
    while (match !== null) {
      const rel = Number(match[1]);
      if (Number.isFinite(rel)) {
        timestamps.push(Math.round((chunkStartOffset + rel) * 100) / 100);
      }
      match = regex.exec(stderr);
    }
    return timestamps;
  } catch {
    return [];
  }
}

function toEven(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

function getTargetHeight(tier: QualityTier, sourceHeight: number): number {
  switch (tier) {
    case '720p':
      return Math.min(720, sourceHeight);
    case '1080p':
      return Math.min(1080, sourceHeight);
    case '2k':
      return Math.min(1440, sourceHeight);
    case '4k':
      return Math.min(2160, sourceHeight);
    case 'source':
    default:
      return sourceHeight;
  }
}

export function computeClipDimensions(params: {
  qualityTier: QualityTier;
  aspectRatio: AspectRatioPreset;
  sourceWidth: number;
  sourceHeight: number;
}): { actualWidth: number; actualHeight: number } {
  const { qualityTier, aspectRatio, sourceWidth, sourceHeight } = params;

  if (aspectRatio === 'source') {
    const targetH = getTargetHeight(qualityTier, sourceHeight);
    const aspectRatioVal = sourceWidth / Math.max(1, sourceHeight);
    const actualHeight = toEven(targetH);
    const actualWidth = toEven(actualHeight * aspectRatioVal);
    return { actualWidth, actualHeight };
  }

  let baseShort: number;
  switch (qualityTier) {
    case '720p':
      baseShort = 720;
      break;
    case '1080p':
      baseShort = 1080;
      break;
    case '2k':
      baseShort = 1440;
      break;
    case '4k':
      baseShort = 2160;
      break;
    case 'source':
    default:
      baseShort = Math.max(720, Math.min(sourceWidth, sourceHeight));
      break;
  }

  switch (aspectRatio) {
    case '9:16':
      return {
        actualWidth: toEven(baseShort),
        actualHeight: toEven((baseShort * 16) / 9),
      };
    case '16:9':
      return {
        actualWidth: toEven((baseShort * 16) / 9),
        actualHeight: toEven(baseShort),
      };
    case '1:1':
      return {
        actualWidth: toEven(baseShort),
        actualHeight: toEven(baseShort),
      };
    case '4:5':
      return {
        actualWidth: toEven(baseShort),
        actualHeight: toEven((baseShort * 5) / 4),
      };
    default:
      return {
        actualWidth: toEven(sourceWidth),
        actualHeight: toEven(sourceHeight),
      };
  }
}

function isDefaultPlacement(pl?: OverlayPlacement): boolean {
  if (!pl) return true;
  return (
    Math.abs(pl.xPct) < 0.1 &&
    Math.abs(pl.yPct) < 0.1 &&
    Math.abs(pl.widthPct - 100) < 0.1 &&
    Math.abs(pl.heightPct - 100) < 0.1 &&
    Boolean(pl.lockAspect)
  );
}

function buildPlacementChain(params: {
  inputLabel: string;
  outLabel: string;
  containerW: number;
  containerH: number;
  placement?: OverlayPlacement;
  fitMode: 'contain' | 'cover';
  withAlpha?: boolean;
}): { scaleFilter: string; coords: string } {
  const { inputLabel, outLabel, containerW, containerH, placement, fitMode, withAlpha } = params;
  const pl = placement ?? {
    xPct: 0,
    yPct: 0,
    widthPct: 100,
    heightPct: 100,
    lockAspect: true,
  };

  const wPct = Math.max(5, Math.min(250, Number(pl.widthPct) || 100));
  const hPct = Math.max(5, Math.min(250, Number(pl.heightPct) || 100));
  const xPct = Math.max(-150, Math.min(150, Number(pl.xPct) || 0));
  const yPct = Math.max(-150, Math.min(150, Number(pl.yPct) || 0));

  const boxW = Math.max(16, toEven(containerW * (wPct / 100)));
  const boxH = Math.max(16, toEven(containerH * (hPct / 100)));
  const posX = Math.round(containerW * (xPct / 100));
  const posY = Math.round(containerH * (yPct / 100));
  const alphaSuffix = withAlpha ? ',format=rgba' : '';

  if (!pl.lockAspect) {
    return {
      scaleFilter: `[${inputLabel}]scale=${boxW}:${boxH},setsar=1${alphaSuffix}[${outLabel}]`,
      coords: `${posX}:${posY}`,
    };
  }

  if (fitMode === 'cover') {
    return {
      scaleFilter: `[${inputLabel}]scale=${boxW}:${boxH}:force_original_aspect_ratio=increase,crop=${boxW}:${boxH},setsar=1${alphaSuffix}[${outLabel}]`,
      coords: `${posX}:${posY}`,
    };
  }

  return {
    scaleFilter: `[${inputLabel}]scale=${boxW}:${boxH}:force_original_aspect_ratio=decrease,setsar=1${alphaSuffix}[${outLabel}]`,
    coords: `${posX}+(${boxW}-w)/2:${posY}+(${boxH}-h)/2`,
  };
}

function buildBlurredBackdropChain(
  inLabel: string,
  outLabel: string,
  actualWidth: number,
  actualHeight: number
): string {
  const blurW = toEven(Math.min(160, Math.max(96, actualWidth / 8)));
  const blurH = toEven(Math.max(96, (blurW * actualHeight) / Math.max(1, actualWidth)));
  return (
    `[${inLabel}]scale=${blurW}:${blurH}:force_original_aspect_ratio=increase,` +
    `crop=${blurW}:${blurH},boxblur=3:1,eq=brightness=-0.12,` +
    `scale=${actualWidth}:${actualHeight}:flags=bilinear,setsar=1[${outLabel}]`
  );
}

async function extractClipThumbnail(
  ffmpegBin: string,
  clipPath: string,
  thumbnailPath: string,
  outputDurationSeconds: number
): Promise<void> {
  const thumbOffset = Math.min(
    Math.max(0.25, outputDurationSeconds * 0.35),
    Math.max(0.25, outputDurationSeconds - 0.25)
  );
  await runProcess(ffmpegBin, [
    '-y',
    '-ss', thumbOffset.toFixed(2),
    '-i', clipPath,
    '-frames:v', '1',
    '-vf', 'scale=480:-2',
    '-q:v', '4',
    thumbnailPath,
  ]).catch(() => {
    return runProcess(ffmpegBin, [
      '-y',
      '-i', clipPath,
      '-frames:v', '1',
      '-vf', 'scale=480:-2',
      '-q:v', '4',
      thumbnailPath,
    ]);
  });
}

export async function renderClipWithThumbnail(params: {
  moviePath: string;
  outputPath: string;
  thumbnailPath: string;
  startSeconds: number;
  durationSeconds: number;
  qualityTier: QualityTier;
  aspectRatio?: AspectRatioPreset;
  framingMode?: FramingMode;
  overlayImagePath?: string;
  overlayPlacement?: OverlayPlacement;
  videoPlacement?: OverlayPlacement;
  overlayBackdrop?: 'fit_blur' | 'crop_fill';
  videoSplitPercent?: number;
  splitMediaFit?: SplitMediaFit;
  playbackSpeed?: number;
  sourceWidth: number;
  sourceHeight: number;
  hasAudio: boolean;
  sourceVideoCodec?: string;
  sourceAudioCodec?: string | null;
  ffmpegThreads?: number;
}): Promise<{
  fileSizeBytes: number;
  actualWidth: number;
  actualHeight: number;
  outputDurationSeconds: number;
}> {
  const {
    moviePath,
    outputPath,
    thumbnailPath,
    startSeconds,
    durationSeconds,
    qualityTier,
    aspectRatio = 'source',
    framingMode = 'fit_blur',
    overlayImagePath,
    overlayPlacement,
    videoPlacement,
    overlayBackdrop = 'fit_blur',
    videoSplitPercent = 50,
    splitMediaFit = 'fit',
    playbackSpeed = 1,
    sourceWidth,
    sourceHeight,
    hasAudio,
    sourceVideoCodec,
    sourceAudioCodec,
    ffmpegThreads = 0,
  } = params;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });

  const ffmpegBin = getFfmpegPath();
  const safeSpeed = Math.max(0.5, Math.min(2.0, Number(playbackSpeed) || 1));
  const hasSpeedChange = Math.abs(safeSpeed - 1) >= 0.01;
  const setptsExpr = hasSpeedChange ? `,setpts=(PTS-STARTPTS)/${safeSpeed.toFixed(4)}` : '';
  const audioSpeedPrefix = hasSpeedChange ? `atempo=${safeSpeed.toFixed(4)},` : '';
  const outputDurationSeconds = Math.round((durationSeconds / safeSpeed) * 100) / 100;

  const { actualWidth, actualHeight } = computeClipDimensions({
    qualityTier,
    aspectRatio,
    sourceWidth,
    sourceHeight,
  });

  const hasOverlayFile = Boolean(overlayImagePath) && fsSync.existsSync(overlayImagePath!);
  const isSplitOverlay =
    (framingMode === 'video_top_image_bottom' || framingMode === 'image_top_video_bottom') &&
    hasOverlayFile;
  const isPictureOnVideoOverlay =
    framingMode === 'picture_overlay_on_video' && hasOverlayFile;
  const hasCustomVideo = !isDefaultPlacement(videoPlacement);

  // Fast Zero-Reencode Stream Copy Path for original ratio H.264/AAC MP4/M4V/MOV without overlays/speed changes
  const movieExt = path.extname(moviePath).toLowerCase();
  const vCodecLower = (sourceVideoCodec || '').toLowerCase();
  const aCodecLower = (sourceAudioCodec || '').toLowerCase();
  const isCopyEligible =
    aspectRatio === 'source' &&
    !isSplitOverlay &&
    !isPictureOnVideoOverlay &&
    !hasCustomVideo &&
    !hasSpeedChange &&
    (qualityTier === 'source' || sourceHeight <= actualHeight) &&
    (movieExt === '.mp4' || movieExt === '.m4v' || movieExt === '.mov') &&
    vCodecLower === 'h264' &&
    (!hasAudio || aCodecLower === '' || aCodecLower === 'aac' || aCodecLower === 'mp3');

  if (isCopyEligible) {
    try {
      const copyArgs = [
        '-y',
        '-ss', startSeconds.toFixed(3),
        '-i', moviePath,
        '-t', durationSeconds.toFixed(3),
        '-map', '0:v:0',
        ...(hasAudio ? ['-map', '0:a:0?'] : ['-an']),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        outputPath,
      ];
      await runProcess(ffmpegBin, copyArgs);
      const copyStat = await fs.stat(outputPath).catch(() => null);
      if (copyStat && copyStat.size > 1024) {
        const actualDur = await probeDurationSeconds(outputPath);
        const minAcceptableDur = Math.min(2, durationSeconds * 0.6);
        if (
          actualDur >= minAcceptableDur &&
          Math.abs(actualDur - durationSeconds) <= 3.5
        ) {
          await extractClipThumbnail(ffmpegBin, outputPath, thumbnailPath, actualDur);
          return {
            fileSizeBytes: copyStat.size,
            actualWidth: toEven(sourceWidth),
            actualHeight: toEven(sourceHeight),
            outputDurationSeconds: Math.round(actualDur * 100) / 100,
          };
        }
      }
      await fs.unlink(outputPath).catch(() => undefined);
    } catch {
      await fs.unlink(outputPath).catch(() => undefined);
    }
  }

  const threadsArg = String(ffmpegThreads > 0 ? ffmpegThreads : 0);
  const args: string[] = ['-y', '-threads', threadsArg];

  if (isSplitOverlay && overlayImagePath) {
    const splitPct = Math.max(30, Math.min(75, Math.round(videoSplitPercent)));
    const videoH = Math.max(120, toEven(actualHeight * (splitPct / 100)));
    const imageH = Math.max(120, actualHeight - videoH);
    const useFill = splitMediaFit === 'fill';

    let videoPanelChain: string;
    if (!hasCustomVideo) {
      const videoScale = useFill
        ? `scale=${actualWidth}:${videoH}:force_original_aspect_ratio=increase,crop=${actualWidth}:${videoH}`
        : `scale=${actualWidth}:${videoH}:force_original_aspect_ratio=decrease,pad=${actualWidth}:${videoH}:(ow-iw)/2:(oh-ih)/2:color=0x0B0E14`;
      videoPanelChain = `[0:v]${videoScale},setsar=1${setptsExpr},format=yuv420p[v_panel]`;
    } else {
      const vPlace = buildPlacementChain({
        inputLabel: 'v_fg_raw',
        outLabel: 'v_fg',
        containerW: actualWidth,
        containerH: videoH,
        placement: videoPlacement,
        fitMode: useFill ? 'cover' : 'contain',
      });
      videoPanelChain =
        `[0:v]split=2[v_bg_raw][v_fg_raw];` +
        `[v_bg_raw]scale=${actualWidth}:${videoH},drawbox=x=0:y=0:w=iw:h=ih:color=0x0B0E14:t=fill,setsar=1[v_bg];` +
        `${vPlace.scaleFilter};` +
        `[v_bg][v_fg]overlay=${vPlace.coords}${setptsExpr},format=yuv420p[v_panel]`;
    }

    const iPlace = buildPlacementChain({
      inputLabel: '1:v',
      outLabel: 'ovl',
      containerW: actualWidth,
      containerH: imageH,
      placement: overlayPlacement,
      fitMode: 'contain',
      withAlpha: true,
    });

    const stackOrder =
      framingMode === 'video_top_image_bottom' ? '[v_panel][i_panel]' : '[i_panel][v_panel]';

    const filterComplex =
      `${videoPanelChain};` +
      `color=c=0x0B0E14:s=${actualWidth}x${imageH}:r=24[panel_bg];` +
      `${iPlace.scaleFilter};` +
      `[panel_bg][ovl]overlay=${iPlace.coords}:eof_action=repeat,setsar=1,format=yuv420p[i_panel];` +
      `${stackOrder}vstack=inputs=2:shortest=1,format=yuv420p[vout]`;

    args.push(
      '-ss', startSeconds.toFixed(3),
      '-t', durationSeconds.toFixed(3),
      '-i', moviePath,
      '-i', overlayImagePath,
      '-filter_complex', filterComplex,
      '-map', '[vout]'
    );
  } else if (isPictureOnVideoOverlay && overlayImagePath) {
    let baseVideoChain: string;
    if (aspectRatio !== 'source' && overlayBackdrop === 'fit_blur') {
      const vPlace = buildPlacementChain({
        inputLabel: 'fg',
        outLabel: 'fg_fit',
        containerW: actualWidth,
        containerH: actualHeight,
        placement: videoPlacement,
        fitMode: 'contain',
      });
      baseVideoChain =
        `[0:v]split=2[bg][fg];` +
        `${buildBlurredBackdropChain('bg', 'bg_blur', actualWidth, actualHeight)};` +
        `${vPlace.scaleFilter};` +
        `[bg_blur][fg_fit]overlay=${vPlace.coords}${setptsExpr}[v_base]`;
    } else if (!hasCustomVideo) {
      if (aspectRatio === 'source') {
        const needsScale = actualHeight < sourceHeight;
        const baseScale = needsScale
          ? `scale=-2:${actualHeight}`
          : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
        baseVideoChain = `[0:v]${baseScale},setsar=1${setptsExpr}[v_base]`;
      } else {
        baseVideoChain = `[0:v]scale=${actualWidth}:${actualHeight}:force_original_aspect_ratio=increase,crop=${actualWidth}:${actualHeight},setsar=1${setptsExpr}[v_base]`;
      }
    } else {
      const vPlace = buildPlacementChain({
        inputLabel: 'v_fg_raw',
        outLabel: 'v_fg',
        containerW: actualWidth,
        containerH: actualHeight,
        placement: videoPlacement,
        fitMode: aspectRatio !== 'source' && overlayBackdrop === 'crop_fill' ? 'cover' : 'contain',
      });
      baseVideoChain =
        `[0:v]split=2[v_bg_raw][v_fg_raw];` +
        `[v_bg_raw]scale=${actualWidth}:${actualHeight},drawbox=x=0:y=0:w=iw:h=ih:color=0x0B0E14:t=fill,setsar=1[v_bg];` +
        `${vPlace.scaleFilter};` +
        `[v_bg][v_fg]overlay=${vPlace.coords}${setptsExpr}[v_base]`;
    }

    const iPlace = buildPlacementChain({
      inputLabel: '1:v',
      outLabel: 'ovl',
      containerW: actualWidth,
      containerH: actualHeight,
      placement: overlayPlacement ?? {
        xPct: 25,
        yPct: 5,
        widthPct: 50,
        heightPct: 25,
        lockAspect: true,
      },
      fitMode: 'contain',
      withAlpha: true,
    });

    const filterComplex =
      `${baseVideoChain};` +
      `${iPlace.scaleFilter};` +
      `[v_base][ovl]overlay=${iPlace.coords}:eof_action=repeat,format=yuv420p[vout]`;

    args.push(
      '-ss', startSeconds.toFixed(3),
      '-t', durationSeconds.toFixed(3),
      '-i', moviePath,
      '-i', overlayImagePath,
      '-filter_complex', filterComplex,
      '-map', '[vout]'
    );
  } else if (hasCustomVideo) {
    if (aspectRatio !== 'source' && framingMode === 'fit_blur') {
      const vPlace = buildPlacementChain({
        inputLabel: 'fg',
        outLabel: 'fg_fit',
        containerW: actualWidth,
        containerH: actualHeight,
        placement: videoPlacement,
        fitMode: 'contain',
      });
      const filterComplex =
        `[0:v]split=2[bg][fg];` +
        `${buildBlurredBackdropChain('bg', 'bg_blur', actualWidth, actualHeight)};` +
        `${vPlace.scaleFilter};` +
        `[bg_blur][fg_fit]overlay=${vPlace.coords}${setptsExpr},format=yuv420p[vout]`;
      args.push(
        '-ss', startSeconds.toFixed(3),
        '-i', moviePath,
        '-t', durationSeconds.toFixed(3),
        '-filter_complex', filterComplex,
        '-map', '[vout]'
      );
    } else {
      const vPlace = buildPlacementChain({
        inputLabel: 'v_fg_raw',
        outLabel: 'v_fg',
        containerW: actualWidth,
        containerH: actualHeight,
        placement: videoPlacement,
        fitMode: aspectRatio !== 'source' && framingMode === 'crop_fill' ? 'cover' : 'contain',
      });
      const filterComplex =
        `[0:v]split=2[v_bg_raw][v_fg_raw];` +
        `[v_bg_raw]scale=${actualWidth}:${actualHeight},drawbox=x=0:y=0:w=iw:h=ih:color=0x0B0E14:t=fill,setsar=1[v_bg];` +
        `${vPlace.scaleFilter};` +
        `[v_bg][v_fg]overlay=${vPlace.coords}${setptsExpr},format=yuv420p[vout]`;
      args.push(
        '-ss', startSeconds.toFixed(3),
        '-i', moviePath,
        '-t', durationSeconds.toFixed(3),
        '-filter_complex', filterComplex,
        '-map', '[vout]'
      );
    }
  } else if (aspectRatio !== 'source') {
    if (framingMode === 'crop_fill') {
      const vf = `scale=${actualWidth}:${actualHeight}:force_original_aspect_ratio=increase,crop=${actualWidth}:${actualHeight},setsar=1${setptsExpr}`;
      args.push(
        '-ss', startSeconds.toFixed(3),
        '-i', moviePath,
        '-t', durationSeconds.toFixed(3),
        '-map', '0:v:0',
        '-vf', vf
      );
    } else {
      const filterComplex =
        `[0:v]split=2[bg][fg];` +
        `${buildBlurredBackdropChain('bg', 'bg_blur', actualWidth, actualHeight)};` +
        `[fg]scale=${actualWidth}:${actualHeight}:force_original_aspect_ratio=decrease,setsar=1[fg_fit];` +
        `[bg_blur][fg_fit]overlay=(W-w)/2:(H-h)/2${setptsExpr},format=yuv420p[vout]`;

      args.push(
        '-ss', startSeconds.toFixed(3),
        '-i', moviePath,
        '-t', durationSeconds.toFixed(3),
        '-filter_complex', filterComplex,
        '-map', '[vout]'
      );
    }
  } else {
    const needsScale = actualHeight < sourceHeight;
    const baseScale = needsScale
      ? `scale=-2:${actualHeight}`
      : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    const vfFilter = `${baseScale}${setptsExpr}`;

    args.push(
      '-ss', startSeconds.toFixed(3),
      '-i', moviePath,
      '-t', durationSeconds.toFixed(3),
      '-map', '0:v:0',
      '-vf', vfFilter
    );
  }

  const isHighTier = qualityTier === '4k' || qualityTier === '2k';
  args.push(
    '-c:v', 'libx264',
    '-preset', isHighTier ? 'superfast' : 'ultrafast',
    '-crf', isHighTier ? '18' : '20',
    '-pix_fmt', 'yuv420p',
    '-avoid_negative_ts', 'make_zero',
    '-max_muxing_queue_size', '1024'
  );

  if (hasAudio) {
    args.push(
      '-map', '0:a:0?',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-af', `${audioSpeedPrefix}aresample=async=1:first_pts=0`
    );
  } else {
    args.push('-an');
  }

  args.push('-movflags', '+faststart', outputPath);

  await runProcess(ffmpegBin, args);

  // Extract poster frame from the newly rendered clip using outputDurationSeconds
  await extractClipThumbnail(ffmpegBin, outputPath, thumbnailPath, outputDurationSeconds);

  const stat = await fs.stat(outputPath);

  return {
    fileSizeBytes: stat.size,
    actualWidth,
    actualHeight,
    outputDurationSeconds,
  };
}

/**
 * Generates a real multi-scene test feature video using FFmpeg with distinct visual chapters,
 * smooth color palettes, animated motion bars, optional burned-in titles, and multi-tone synced audio.
 */
export async function generateSampleMultiSceneMovie(
  outputPath: string,
  durationSeconds = 180
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const ffmpegBin = getFfmpegPath();
  const hasDrawtext = supportsDrawtextFilter(ffmpegBin);

  // Build 12 distinct visual scenes across the requested duration using concat filter
  const sceneCount = 12;
  const sceneDur = Math.max(5, Math.floor(durationSeconds / sceneCount));
  const scenes = [
    { label: '01 OPENING HARBOR DAWN', bg: '0x162436', box: '0xF59E0B', freq: 220 },
    { label: '02 NEWSROOM CONVERSATION', bg: '0x1F2937', box: '0x38BDF8', freq: 261 },
    { label: '03 HIGHWAY CHASE SEQUENCE', bg: '0x3B1D1D', box: '0xEF4444', freq: 330 },
    { label: '04 QUIET ROOFTOP DIALOGUE', bg: '0x1A2E2B', box: '0x34D399', freq: 293 },
    { label: '05 COMEDY DINER BANTER', bg: '0x33291A', box: '0xFBBF24', freq: 349 },
    { label: '06 UNDERGROUND ARCHIVE REVEAL', bg: '0x231B36', box: '0xA78BFA', freq: 246 },
    { label: '07 STORM DOCK ACTION', bg: '0x132030', box: '0x60A5FA', freq: 392 },
    { label: '08 EMOTIONAL FAREWELL LETTER', bg: '0x2B1D28', box: '0xF472B6', freq: 277 },
    { label: '09 HEIST VAULT BREACH', bg: '0x2F1A1A', box: '0xFB7185', freq: 440 },
    { label: '10 COURTROOM CROSS EXAM', bg: '0x1C252C', box: '0x94A3B8', freq: 311 },
    { label: '11 FINAL STATION SHOWDOWN', bg: '0x291E14', box: '0xF97316', freq: 493 },
    { label: '12 EPILOGUE SUNRISE', bg: '0x17242A', box: '0x2DD4BF', freq: 261 },
  ];

  const filterInputs: string[] = [];
  const concatInputs: string[] = [];

  scenes.forEach((sc, idx) => {
    const baseVideo =
      `color=c=${sc.bg}:s=1280x720:r=24:d=${sceneDur},` +
      `drawbox=x='mod(t*220,1160)':y=520:w=120:h=16:color=${sc.box}@0.9:t=fill,` +
      `drawbox=x=60:y=60:w=1160:h=600:color=white@0.12:t=2`;

    if (hasDrawtext) {
      filterInputs.push(
        `${baseVideo},` +
        `drawtext=text='${sc.label}':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=290,` +
        `drawtext=text='CHAPTER ${idx + 1} OF ${sceneCount}':fontcolor=${sc.box}:fontsize=22:x=(w-text_w)/2:y=360[v${idx}]`
      );
    } else {
      filterInputs.push(
        `${baseVideo},` +
        `drawbox=x=240:y=250:w=800:h=150:color=${sc.box}@0.28:t=fill[v${idx}]`
      );
    }

    // Gentle pulsing harmonic audio tone per scene
    filterInputs.push(
      `sine=frequency=${sc.freq}:sample_rate=44100:duration=${sceneDur},volume=0.12[a${idx}]`
    );
    concatInputs.push(`[v${idx}][a${idx}]`);
  });

  const filterComplex = `${filterInputs.join(';')};${concatInputs.join('')}concat=n=${sceneCount}:v=1:a=1[vout][aout]`;

  await runProcess(ffmpegBin, [
    '-y',
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '24',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ]);
}

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type {
  ImportQualityTier,
  UrlImportJob,
  YoutubeCookiesStatus,
} from '../src/types/clipper.ts';
import { getFfmpegPath, probeVideo } from './ffmpeg.ts';
import { MOVIES_DIR, STORAGE_ROOT, prepareAndRegisterMovie } from './queue.ts';

const YOUTUBE_COOKIES_PATH = path.join(STORAGE_ROOT, 'youtube-cookies.txt');

const importEvents = new EventEmitter();
importEvents.setMaxListeners(50);

const importsMap = new Map<string, UrlImportJob>();
const activeControllers = new Map<string, { abort: () => void }>();

function emitImportUpdate(job: UrlImportJob): void {
  job.updatedAt = new Date().toISOString();
  importEvents.emit(`import:${job.id}`, job);
}

export function getImportJob(importId: string): UrlImportJob | undefined {
  return importsMap.get(importId);
}

export function subscribeToImport(
  importId: string,
  listener: (job: UrlImportJob) => void
): () => void {
  const evt = `import:${importId}`;
  importEvents.on(evt, listener);
  return () => {
    importEvents.off(evt, listener);
  };
}

export function cancelImportJob(importId: string): UrlImportJob | undefined {
  const job = importsMap.get(importId);
  if (!job) return undefined;
  activeControllers.get(importId)?.abort();
  job.status = 'cancelled';
  job.statusMessage = 'Video URL import cancelled.';
  emitImportUpdate(job);
  return job;
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local') || lower === '0.0.0.0') {
    return true;
  }
  const ipType = net.isIP(lower);
  if (ipType === 4) {
    const parts = lower.split('.').map(Number);
    if (parts[0] === 127 || parts[0] === 10 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  } else if (ipType === 6) {
    if (lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
      return true;
    }
  }
  return false;
}

export function validateVideoUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Please enter a valid http:// or https:// video link.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// video links are supported.');
  }
  if (isPrivateOrLocalHostname(parsed.hostname)) {
    throw new Error('Local or private network URLs are not permitted.');
  }
  return parsed;
}

function parseNetscapeCookieLines(rawText: string): Array<{ domain: string; line: string }> {
  const lines = rawText.split(/\r?\n/);
  const valid: Array<{ domain: string; line: string }> = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    // Allow #HttpOnly_ lines (standard Netscape extension)
    if (trimmed.startsWith('#') && !trimmed.startsWith('#HttpOnly_')) {
      continue;
    }
    const cleanLine = trimmed.startsWith('#HttpOnly_') ? trimmed.slice('#HttpOnly_'.length) : trimmed;
    const parts = cleanLine.split('\t');
    if (parts.length >= 7 && parts[0]?.trim() && parts[5]?.trim()) {
      valid.push({ domain: parts[0].trim(), line: trimmed });
    }
  }
  return valid;
}

export function hasYoutubeCookiesFile(): boolean {
  try {
    if (!fsSync.existsSync(YOUTUBE_COOKIES_PATH)) return false;
    const raw = fsSync.readFileSync(YOUTUBE_COOKIES_PATH, 'utf8');
    return parseNetscapeCookieLines(raw).length > 0;
  } catch {
    return false;
  }
}

export async function getYoutubeCookiesStatus(): Promise<YoutubeCookiesStatus> {
  try {
    const stat = await fs.stat(YOUTUBE_COOKIES_PATH);
    const raw = await fs.readFile(YOUTUBE_COOKIES_PATH, 'utf8');
    const parsed = parseNetscapeCookieLines(raw);
    const domainSet = new Set<string>();
    for (const item of parsed) {
      const cleanDomain = item.domain.replace(/^\./, '').toLowerCase();
      if (cleanDomain) domainSet.add(cleanDomain);
    }
    return {
      configured: parsed.length > 0,
      cookieCount: parsed.length,
      domains: Array.from(domainSet).slice(0, 6),
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return {
      configured: false,
      cookieCount: 0,
      domains: [],
    };
  }
}

export async function saveYoutubeCookies(rawText: string): Promise<YoutubeCookiesStatus> {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error('Cookies text is empty. Paste Netscape cookies.txt contents or upload a .txt file.');
  }
  const parsed = parseNetscapeCookieLines(trimmed);
  if (parsed.length === 0) {
    throw new Error(
      'Invalid cookies format. Export using a Netscape cookies.txt extension (7 tab-separated columns starting with # Netscape HTTP Cookie File).'
    );
  }

  await fs.mkdir(path.dirname(YOUTUBE_COOKIES_PATH), { recursive: true });
  const normalizedContent = trimmed.startsWith('# Netscape HTTP Cookie File')
    ? `${trimmed}\n`
    : `# Netscape HTTP Cookie File\n# https://curl.se/docs/http-cookies.html\n${trimmed}\n`;
  await fs.writeFile(YOUTUBE_COOKIES_PATH, normalizedContent, { encoding: 'utf8', mode: 0o600 });
  return getYoutubeCookiesStatus();
}

export async function deleteYoutubeCookies(): Promise<YoutubeCookiesStatus> {
  await fs.unlink(YOUTUBE_COOKIES_PATH).catch(() => undefined);
  return {
    configured: false,
    cookieCount: 0,
    domains: [],
  };
}

async function ensureYtDlpBinary(job?: UrlImportJob): Promise<string> {
  const tmpBinPath = path.join(os.tmpdir(), 'framesplit-bin', 'yt-dlp');
  const candidates = [
    path.resolve(process.cwd(), 'bin', 'yt-dlp'),
    tmpBinPath,
  ];

  for (const binPath of candidates) {
    if (fsSync.existsSync(binPath)) {
      try {
        fsSync.accessSync(binPath, fsSync.constants.X_OK);
      } catch {
        try {
          fsSync.chmodSync(binPath, 0o755);
        } catch {
          // Ignore chmod error
        }
      }
      return binPath;
    }
  }

  // Check if yt-dlp exists on PATH
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'yt-dlp');
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  // Lazily download standalone yt-dlp_linux into OS temp dir (kept outside workspace & production bundle)
  const targetPath = tmpBinPath;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (job) {
    job.statusMessage = 'Preparing video link extractor engine (first-time setup)...';
    emitImportUpdate(job);
  }
  const resp = await fetch(
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
    { redirect: 'follow' }
  );
  if (!resp.ok || !resp.body) {
    throw new Error(`Failed to fetch yt-dlp extractor (HTTP ${resp.status})`);
  }
  const tmpPath = `${targetPath}.tmp`;
  const fileStream = fsSync.createWriteStream(tmpPath);
  const bodyStream = Readable.fromWeb(resp.body as import('node:stream/web').ReadableStream);
  await new Promise<void>((resolve, reject) => {
    bodyStream.on('error', reject);
    fileStream.on('error', reject);
    fileStream.on('finish', resolve);
    bodyStream.pipe(fileStream);
  });
  await fs.chmod(tmpPath, 0o755);
  await fs.rename(tmpPath, targetPath);
  return targetPath;
}

function getYtDlpFormatSelector(quality: ImportQualityTier): string {
  switch (quality) {
    case '720p':
      return 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best';
    case '1080p':
      return 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
    case '2k':
      return 'bestvideo[height<=1440][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1440]+bestaudio/best[height<=1440]/best';
    case '4k':
      return 'bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best[height<=2160]/best';
    case 'best_hd':
    default:
      return 'bestvideo[height>=720][height<=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/bestvideo+bestaudio/best';
  }
}

function formatBytesText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function isDirectVideoPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return (
    lower.endsWith('.mp4') ||
    lower.endsWith('.mov') ||
    lower.endsWith('.mkv') ||
    lower.endsWith('.webm') ||
    lower.endsWith('.m4v') ||
    lower.endsWith('.avi')
  );
}

function isHlsOrDashPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return lower.endsWith('.m3u8') || lower.endsWith('.mpd');
}

function isKnownExtractorHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const extractorHosts = [
    'youtube.com',
    'youtu.be',
    'youtube-nocookie.com',
    'vimeo.com',
    'dailymotion.com',
    'dai.ly',
    'tiktok.com',
    'instagram.com',
    'facebook.com',
    'fb.watch',
    'x.com',
    'twitter.com',
    'twitch.tv',
    'rumble.com',
    'bilibili.com',
  ];
  return extractorHosts.some((d) => host === d || host.endsWith(`.${d}`));
}

function isLikelyDirectStreamEndpoint(parsedUrl: URL, hasExtraHeaders: boolean): boolean {
  if (isKnownExtractorHost(parsedUrl.hostname)) {
    return false;
  }
  if (hasExtraHeaders) {
    return true;
  }
  const lowerPath = parsedUrl.pathname.toLowerCase();
  return (
    lowerPath.includes('/api/download') ||
    lowerPath.includes('/api/proxy-media') ||
    lowerPath.includes('/api/videos/') ||
    lowerPath.endsWith('/download') ||
    lowerPath.endsWith('/stream')
  );
}

export async function startUrlImport(params: {
  url: string;
  preferredQuality: ImportQualityTier;
  customTitle?: string;
  extraHeaders?: Record<string, string>;
}): Promise<UrlImportJob> {
  const validated = validateVideoUrl(params.url);
  const importId = `imp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

  const job: UrlImportJob = {
    id: importId,
    url: validated.toString(),
    requestedTitle: params.customTitle?.trim() || undefined,
    preferredQuality: params.preferredQuality,
    status: 'queued',
    statusMessage: 'Preparing HD video link import...',
    progressPercent: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  importsMap.set(importId, job);
  emitImportUpdate(job);

  void executeImportJob(job, validated, params.extraHeaders);
  return job;
}

async function isDirectVideoContentType(
  urlStr: string,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let resp = await fetch(urlStr, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
          ...(extraHeaders ?? {}),
        },
      });
      await resp.body?.cancel().catch(() => undefined);
      if (resp.status === 405 || resp.status === 501) {
        resp = await fetch(urlStr, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            Range: 'bytes=0-0',
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
            ...(extraHeaders ?? {}),
          },
        });
        await resp.body?.cancel().catch(() => undefined);
      }
      if (!resp.ok) return false;
      const ctype = (resp.headers.get('content-type') || '').toLowerCase();
      const cdisp = (resp.headers.get('content-disposition') || '').toLowerCase();
      return (
        ctype.startsWith('video/') ||
        ctype.includes('application/octet-stream') ||
        (cdisp.includes('attachment') && /\.(mp4|mov|mkv|webm|m4v|avi)/i.test(cdisp))
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  } catch {
    return false;
  }
}

async function executeImportJob(
  job: UrlImportJob,
  parsedUrl: URL,
  extraHeaders?: Record<string, string>
): Promise<void> {
  await fs.mkdir(MOVIES_DIR, { recursive: true });
  const movieId = `mov_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const tempBase = path.join(MOVIES_DIR, `${movieId}_dl`);
  const directExt = isDirectVideoPath(parsedUrl.pathname)
    ? path.extname(parsedUrl.pathname).toLowerCase() || '.mp4'
    : '.mp4';
  const finalVideoPath = path.join(MOVIES_DIR, `${movieId}${directExt}`);

  let cancelled = false;
  let activeChild: ChildProcess | null = null;
  const fetchAbort = new AbortController();

  activeControllers.set(job.id, {
    abort: () => {
      cancelled = true;
      fetchAbort.abort();
      if (activeChild && !activeChild.killed) {
        activeChild.kill('SIGTERM');
      }
    },
  });

  try {
    job.status = 'resolving';
    job.statusMessage = 'Resolving HD video stream and metadata from link...';
    emitImportUpdate(job);

    if (
      isDirectVideoPath(parsedUrl.pathname) ||
      isLikelyDirectStreamEndpoint(parsedUrl, Boolean(extraHeaders && Object.keys(extraHeaders).length > 0))
    ) {
      await downloadDirectVideoUrl(job, parsedUrl, finalVideoPath, fetchAbort.signal, extraHeaders);
    } else if (isHlsOrDashPath(parsedUrl.pathname)) {
      await downloadHlsStreamWithFfmpeg(job, parsedUrl.toString(), finalVideoPath, (child) => {
        activeChild = child;
      });
    } else if (await isDirectVideoContentType(parsedUrl.toString(), extraHeaders, fetchAbort.signal)) {
      await downloadDirectVideoUrl(job, parsedUrl, finalVideoPath, fetchAbort.signal, extraHeaders);
    } else {
      await downloadWithYtDlp(job, parsedUrl.toString(), tempBase, finalVideoPath, (child) => {
        activeChild = child;
      });
    }

    if (cancelled) {
      await cleanupTempFiles(tempBase, finalVideoPath);
      return;
    }

    // Verify file exists and is non-empty
    const stat = await fs.stat(finalVideoPath).catch(() => null);
    if (!stat || stat.size < 1024) {
      throw new Error('Imported video file is empty or incomplete.');
    }

    job.status = 'probing';
    job.progressPercent = 96;
    job.statusMessage = 'Inspecting HD resolution, FPS, and audio sync via FFprobe...';
    emitImportUpdate(job);

    const fallbackTitle =
      job.requestedTitle ||
      job.resolvedTitle ||
      path.basename(parsedUrl.pathname).replace(/\.[^/.]+$/, '') ||
      `Imported HD Video (${parsedUrl.hostname})`;

    const movie = await probeVideo(
      finalVideoPath,
      movieId,
      path.basename(finalVideoPath),
      fallbackTitle.slice(0, 120)
    );
    movie.sourceUrl = job.url;

    const preparedMovie = await prepareAndRegisterMovie(movie);

    job.movie = preparedMovie;
    job.status = 'completed';
    job.progressPercent = 100;
    job.statusMessage = `Imported ${movie.width}×${movie.height} HD video ready for clipping.`;
    emitImportUpdate(job);
  } catch (err) {
    if (cancelled || job.status === 'cancelled') {
      await cleanupTempFiles(tempBase, finalVideoPath);
      return;
    }
    const msg = err instanceof Error ? err.message : 'Failed to import video from link.';
    job.status = 'failed';
    job.error = msg;
    job.statusMessage = `Import failed: ${msg}`;
    emitImportUpdate(job);
    await cleanupTempFiles(tempBase, finalVideoPath);
  } finally {
    activeControllers.delete(job.id);
  }
}

async function cleanupTempFiles(tempBase: string, finalPath: string): Promise<void> {
  const dir = path.dirname(tempBase);
  const prefix = path.basename(tempBase);
  const files = await fs.readdir(dir).catch(() => []);
  for (const f of files) {
    if (f.startsWith(prefix)) {
      await fs.unlink(path.join(dir, f)).catch(() => undefined);
    }
  }
  await fs.unlink(finalPath).catch(() => undefined);
}

async function downloadDirectVideoUrl(
  job: UrlImportJob,
  parsedUrl: URL,
  outputPath: string,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>
): Promise<void> {
  const headerTimeoutController = new AbortController();
  const headerTimer = setTimeout(() => headerTimeoutController.abort(), 45000);
  const combinedSignal = AbortSignal.any([signal, headerTimeoutController.signal]);
  let response: Response;
  try {
    response = await fetch(parsedUrl.toString(), {
      signal: combinedSignal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        ...(extraHeaders ?? {}),
      },
    });
  } catch (err) {
    clearTimeout(headerTimer);
    if (headerTimeoutController.signal.aborted && !signal.aborted) {
      throw new Error(`Stream endpoint timed out waiting for video headers (${parsedUrl.hostname}).`);
    }
    throw err;
  }
  clearTimeout(headerTimer);

  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Remote server returned HTTP ${response.status} ${response.statusText}`.trim());
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
    const snippet = (await response.text().catch(() => '')).slice(0, 600);
    if (snippet.includes('__cookie_check') || snippet.includes('aistudio')) {
      throw new Error(
        'External AI Studio preview URL requires browser session login. Use the Shared/Published URL or push via webhook.'
      );
    }
    throw new Error('Remote URL returned an HTML webpage instead of a downloadable video file.');
  }
  if (contentType.includes('application/json')) {
    const snippet = (await response.text().catch(() => '')).slice(0, 400);
    throw new Error(`Remote stream endpoint returned JSON instead of video: ${snippet}`);
  }

  const totalBytes = Number(response.headers.get('content-length') || 0);
  let receivedBytes = 0;
  const startTime = performance.now();

  job.status = 'downloading';
  job.statusMessage = 'Downloading HD video file from link...';
  emitImportUpdate(job);

  const fileStream = fsSync.createWriteStream(outputPath);
  const nodeReadable = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);

  let lastEmit = 0;
  await new Promise<void>((resolve, reject) => {
    nodeReadable.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 300) {
        lastEmit = now;
        const elapsed = Math.max(0.1, (performance.now() - startTime) / 1000);
        const speedBps = receivedBytes / elapsed;
        job.downloadedText = formatBytesText(receivedBytes);
        job.totalSizeText = totalBytes > 0 ? formatBytesText(totalBytes) : undefined;
        job.speedText = `${formatBytesText(speedBps)}/s`;
        if (totalBytes > 0) {
          job.progressPercent = Math.min(94, Math.round((receivedBytes / totalBytes) * 94));
        }
        emitImportUpdate(job);
      }
    });

    nodeReadable.on('error', (err) => {
      fileStream.destroy();
      reject(err);
    });
    fileStream.on('error', (err) => reject(err));
    fileStream.on('finish', () => resolve());
    nodeReadable.pipe(fileStream);
  });
}

async function downloadHlsStreamWithFfmpeg(
  job: UrlImportJob,
  streamUrl: string,
  outputPath: string,
  onSpawn: (child: ChildProcess) => void
): Promise<void> {
  job.status = 'downloading';
  job.statusMessage = 'Capturing HD stream segments via FFmpeg...';
  emitImportUpdate(job);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(getFfmpegPath(), [
      '-y',
      '-i', streamUrl,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      outputPath,
    ]);
    onSpawn(child);

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 16384) stderr = stderr.slice(-8192);
      const timeMatch = /time=(\d{2}:\d{2}:\d{2})/.exec(chunk.toString());
      if (timeMatch) {
        job.statusMessage = `Capturing HD stream (${timeMatch[1]} elapsed)...`;
        emitImportUpdate(job);
      }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg stream capture exited with code ${code}: ${stderr.slice(-400)}`));
    });
  });
}

async function downloadWithYtDlp(
  job: UrlImportJob,
  url: string,
  tempBase: string,
  finalMp4Path: string,
  onSpawn: (child: ChildProcess) => void
): Promise<void> {
  const ytdlp = await ensureYtDlpBinary(job);
  const formatSelector = getYtDlpFormatSelector(job.preferredQuality);
  const outputTemplate = `${tempBase}.%(ext)s`;
  const cookiesPresent = hasYoutubeCookiesFile();
  const baseAuthArgs = [
    '--no-playlist',
    '--force-ipv4',
    '--js-runtimes', 'node',
    ...(cookiesPresent ? ['--cookies', YOUTUBE_COOKIES_PATH] : []),
  ];

  // Fetch video title first (with 12s timeout so slow links don't stall download start)
  await new Promise<void>((resolve) => {
    const infoChild = spawn(ytdlp, [
      ...baseAuthArgs,
      '--skip-download',
      '--print', '%(title)s',
      url,
    ]);
    let out = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (!infoChild.killed) infoChild.kill('SIGTERM');
      done();
    }, 12000);
    infoChild.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    infoChild.on('close', (code) => {
      if (code === 0 && out.trim()) {
        job.resolvedTitle = out.trim().split('\n')[0]?.trim();
        emitImportUpdate(job);
      }
      done();
    });
    infoChild.on('error', () => done());
  });

  job.status = 'downloading';
  job.statusMessage = `Downloading HD video (${job.preferredQuality.toUpperCase().replace('_', ' ')})...`;
  emitImportUpdate(job);

  await new Promise<void>((resolve, reject) => {
    const args = [
      ...baseAuthArgs,
      '--newline',
      '--progress',
      '--ffmpeg-location', getFfmpegPath(),
      '-f', formatSelector,
      '--merge-output-format', 'mp4',
      '-o', outputTemplate,
      url,
    ];

    const child = spawn(ytdlp, args);
    onSpawn(child);

    let stderr = '';
    let stdoutBuf = '';

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Parse yt-dlp progress: [download]  42.3% of ~ 154.20MiB at   5.40MiB/s ETA 00:16
      const progMatch = /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([^\s]+)(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?/i.exec(trimmed);
      if (progMatch) {
        const pct = Number(progMatch[1]);
        if (Number.isFinite(pct)) {
          job.progressPercent = Math.min(92, Math.round(pct * 0.92));
        }
        job.totalSizeText = progMatch[2];
        if (progMatch[3]) job.speedText = progMatch[3];
        if (progMatch[4]) job.etaText = progMatch[4];
        job.status = 'downloading';
        job.statusMessage = `Downloading HD stream (${Math.round(pct)}%)...`;
        emitImportUpdate(job);
        return;
      }

      if (trimmed.includes('[Merger]') || trimmed.includes('[Fixup')) {
        job.status = 'merging';
        job.progressPercent = 94;
        job.statusMessage = 'Merging HD video and audio tracks via FFmpeg...';
        emitImportUpdate(job);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';
      for (const l of lines) handleLine(l);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 16384) stderr = stderr.slice(-8192);
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (stdoutBuf) handleLine(stdoutBuf);
      if (code === 0) {
        resolve();
      } else {
        const rawErr =
          stderr
            .split('\n')
            .filter((l) => l.includes('ERROR:'))
            .slice(-2)
            .join(' ') || stderr.slice(-400);
        if (/sign in to confirm.*not a bot|cookies/i.test(rawErr)) {
          reject(
            new Error(
              cookiesPresent
                ? 'YouTube rejected the saved cookies.txt session (expired or blocked). Export fresh YouTube cookies.txt and re-upload it, or use the external tool stream URL.'
                : 'YouTube blocked direct cloud download ("Sign in to confirm you’re not a bot"). Upload/paste YouTube cookies.txt in Source Movie → Import Video Link (or Auto-Sync) to enable direct YouTube links.'
            )
          );
          return;
        }
        reject(new Error(rawErr || `Video extractor exited with code ${code}`));
      }
    });
  });

  // Locate output file produced by yt-dlp (expected `${tempBase}.mp4`, or fallback if another ext)
  const expectedMp4 = `${tempBase}.mp4`;
  if (fsSync.existsSync(expectedMp4)) {
    await fs.rename(expectedMp4, finalMp4Path);
    return;
  }

  const dir = path.dirname(tempBase);
  const prefix = path.basename(tempBase);
  const candidates = await fs.readdir(dir);
  const matched = candidates.find((f) => f.startsWith(prefix) && !f.endsWith('.part'));
  if (!matched) {
    throw new Error('Downloaded HD video file was not found after extraction.');
  }

  const matchedPath = path.join(dir, matched);
  if (matched.endsWith('.mp4')) {
    await fs.rename(matchedPath, finalMp4Path);
  } else {
    // Remux into clean MP4 with FFmpeg
    job.status = 'merging';
    job.statusMessage = 'Remuxing HD stream into MP4 container...';
    emitImportUpdate(job);
    await new Promise<void>((resolve, reject) => {
      const remux = spawn(getFfmpegPath(), [
        '-y',
        '-i', matchedPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        finalMp4Path,
      ]);
      remux.on('error', reject);
      remux.on('close', (c) => (c === 0 ? resolve() : reject(new Error('Failed to remux HD file to MP4.'))));
    });
    await fs.unlink(matchedPath).catch(() => undefined);
  }
}

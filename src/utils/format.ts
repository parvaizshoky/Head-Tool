import type { AspectRatioPreset, MomentCategory, QualityTier } from '../types/clipper';

export function formatTimecode(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function formatDurationLabel(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM === 0 ? `${h}h` : `${h}h ${remM}m`;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, idx);
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[idx]}`;
}

export const CATEGORY_LABELS: Record<MomentCategory, string> = {
  scene: 'Scene',
  dialogue: 'Dialogue',
  action: 'Action',
  emotional: 'Emotional',
  comedy: 'Comedy',
  memorable_quote: 'Memorable Quote',
  story_milestone: 'Story Milestone',
  highlight: 'Highlight',
};

export const QUALITY_TIER_INFO: Array<{
  tier: QualityTier;
  label: string;
  height: number | null;
  detail: string;
}> = [
  { tier: 'source', label: 'Source Original', height: null, detail: 'Matches native movie height' },
  { tier: '720p', label: '720p HD', height: 720, detail: '1280×720 standard HD' },
  { tier: '1080p', label: '1080p Full HD', height: 1080, detail: '1920×1080 crisp HD' },
  { tier: '2k', label: '2K QHD', height: 1440, detail: '2560×1440 cinema QHD' },
  { tier: '4k', label: '4K UHD', height: 2160, detail: '3840×2160 ultra HD' },
];

export const ASPECT_RATIO_INFO: Array<{
  ratio: AspectRatioPreset;
  label: string;
  platforms: string;
}> = [
  { ratio: 'source', label: 'Original', platforms: 'Keep source framing' },
  { ratio: '9:16', label: '9:16 Vertical', platforms: 'TikTok · Reels · YT Shorts' },
  { ratio: '16:9', label: '16:9 Wide', platforms: 'YouTube · Facebook Video' },
  { ratio: '1:1', label: '1:1 Square', platforms: 'Facebook · IG Feed' },
  { ratio: '4:5', label: '4:5 Portrait', platforms: 'IG & Facebook Portrait' },
];

export const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];


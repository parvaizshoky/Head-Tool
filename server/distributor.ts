import {
  MAX_CLIPS_PER_MOVIE,
  computeMaxNonOverlappingClips,
} from '../src/types/clipper.ts';
import type {
  BatchConfig,
  DetectedMoment,
  GeneratedClip,
  MomentCategory,
} from '../src/types/clipper.ts';

interface Interval {
  start: number;
  end: number;
}

interface SelectedClipDraft {
  interval: Interval;
  chunkIndex: number;
  title: string;
  category: MomentCategory;
  summary: string;
  transcriptSnippet?: string;
  score: number;
}

function overlapDuration(a: Interval, b: Interval): number {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

function overlapsExisting(
  candidate: Interval,
  chosen: Interval[],
  maxAllowedOverlap = 0.02
): boolean {
  for (const item of chosen) {
    if (overlapDuration(candidate, item) > maxAllowedOverlap) {
      return true;
    }
  }
  return false;
}

function clampWindow(
  centerOrStart: number,
  clipDuration: number,
  totalDuration: number,
  anchorAtStart = false
): Interval {
  const effectiveDur = Math.min(clipDuration, totalDuration);
  const rawStart = anchorAtStart ? centerOrStart : centerOrStart - effectiveDur / 2;
  const clampedStart = Math.max(0, Math.min(totalDuration - effectiveDur, rawStart));
  const start = Math.round(clampedStart * 100) / 100;
  const end = Math.min(totalDuration, Math.round((start + effectiveDur) * 100) / 100);
  return { start, end };
}

function formatFilenameTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}h${mm}m${ss}s`;
}

function sanitizeFileSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 42) || 'clip'
  );
}

function findBestMomentInWindow(
  scoredMoments: Array<{ moment: DetectedMoment; weightedScore: number }>,
  winStart: number,
  winEnd: number,
  usedMomentIds: Set<string>
): DetectedMoment | undefined {
  let bestInside: DetectedMoment | undefined;
  let bestScore = -Infinity;

  for (const { moment, weightedScore } of scoredMoments) {
    if (usedMomentIds.has(moment.id)) continue;
    if (moment.peakSeconds >= winStart && moment.peakSeconds <= winEnd) {
      if (weightedScore > bestScore) {
        bestScore = weightedScore;
        bestInside = moment;
      }
    }
  }

  if (bestInside) return bestInside;

  const center = (winStart + winEnd) / 2;
  let nearest: DetectedMoment | undefined;
  let bestDist = Infinity;
  for (const { moment } of scoredMoments) {
    const dist = Math.abs(moment.peakSeconds - center);
    if (dist < bestDist) {
      bestDist = dist;
      nearest = moment;
    }
  }
  return nearest;
}

/**
 * Distributes clips evenly across the entire movie timeline (0% -> 100%),
 * prioritizing Gemini-detected moments in every temporal stratum, strictly
 * matching requested clip count & exact clip duration without boundary gaps
 * or greedy fragmentation losses.
 */
export function distributeClipsAcrossMovie(params: {
  totalDurationSeconds: number;
  movieTitle?: string;
  moments: DetectedMoment[];
  sceneCutTimestamps: number[];
  chunkCount: number;
  config: BatchConfig;
}): GeneratedClip[] {
  const { totalDurationSeconds, movieTitle, moments, sceneCutTimestamps, chunkCount, config } = params;

  const clipDuration =
    totalDurationSeconds <= 2
      ? Math.max(0.5, totalDurationSeconds)
      : Math.max(2, Math.min(config.clipDurationSeconds, totalDurationSeconds));

  const maxNonOverlapping = computeMaxNonOverlappingClips(totalDurationSeconds, clipDuration);

  let targetCount =
    config.quantityMode === 'max'
      ? maxNonOverlapping
      : Math.min(MAX_CLIPS_PER_MOVIE, Math.max(1, Math.floor(config.requestedClipCount)));

  if (config.preventOverlap && !config.allowOverlapWhenExceeding && targetCount > maxNonOverlapping) {
    targetCount = maxNonOverlapping;
  }

  const focusSet = new Set<MomentCategory>(config.focusCategories);
  const scoredMoments = moments
    .map((m) => {
      const focusBonus = focusSet.size === 0 || focusSet.has(m.category) ? 15 : 0;
      return { moment: m, weightedScore: m.score + focusBonus };
    })
    .sort((a, b) => b.weightedScore - a.weightedScore);

  const chosenIntervals: Interval[] = [];
  const selectedItems: SelectedClipDraft[] = [];

  // Divide full timeline into equal strata so clips span start to end
  const strataCount = Math.min(targetCount, Math.max(chunkCount, Math.min(targetCount, 64)));
  const stratumLength = totalDurationSeconds / strataCount;
  const quotaPerStratum = Math.ceil(targetCount / strataCount);

  // If total slack across the movie is >= clipDuration (or overlap is allowed),
  // run AI-moment-centered selection first. Otherwise go straight to ordered zone partitioning
  // so tight packs like 3 × 15s on 45s never fragment.
  const totalSlack = totalDurationSeconds - targetCount * clipDuration;
  const allowGreedyAiCentering = !config.preventOverlap || totalSlack >= clipDuration * 0.5;

  if (allowGreedyAiCentering) {
    // Pass 1: Pick highest-ranked non-overlapping AI moments evenly inside every temporal stratum
    for (let s = 0; s < strataCount && selectedItems.length < targetCount; s += 1) {
      const sStart = s * stratumLength;
      const sEnd = (s + 1) * stratumLength;

      const stratumCandidates = scoredMoments.filter(
        (item) => item.moment.peakSeconds >= sStart && item.moment.peakSeconds <= sEnd
      );

      let addedInStratum = 0;
      for (const candidate of stratumCandidates) {
        if (addedInStratum >= quotaPerStratum || selectedItems.length >= targetCount) break;
        const win = clampWindow(candidate.moment.peakSeconds, clipDuration, totalDurationSeconds, false);
        if (!config.preventOverlap || !overlapsExisting(win, chosenIntervals)) {
          chosenIntervals.push(win);
          selectedItems.push({
            interval: win,
            chunkIndex: candidate.moment.chunkIndex,
            title: candidate.moment.title,
            category: candidate.moment.category,
            summary: candidate.moment.summary,
            transcriptSnippet: candidate.moment.transcriptSnippet,
            score: candidate.moment.score,
          });
          addedInStratum += 1;
        }
      }
    }

    // Pass 2: Fill remaining slots from any unused AI moments anywhere in the movie
    if (selectedItems.length < targetCount) {
      for (const candidate of scoredMoments) {
        if (selectedItems.length >= targetCount) break;
        const win = clampWindow(candidate.moment.peakSeconds, clipDuration, totalDurationSeconds, false);
        if (!config.preventOverlap || !overlapsExisting(win, chosenIntervals)) {
          chosenIntervals.push(win);
          selectedItems.push({
            interval: win,
            chunkIndex: candidate.moment.chunkIndex,
            title: candidate.moment.title,
            category: candidate.moment.category,
            summary: candidate.moment.summary,
            transcriptSnippet: candidate.moment.transcriptSnippet,
            score: candidate.moment.score,
          });
        }
      }
    }

    // Pass 3: Anchor additional non-overlapping clips to FFmpeg scene cuts across the full timeline
    if (selectedItems.length < targetCount) {
      const uniqueCuts = Array.from(new Set(sceneCutTimestamps)).sort((a, b) => a - b);
      for (const cutTs of uniqueCuts) {
        if (selectedItems.length >= targetCount) break;
        const win = clampWindow(cutTs, clipDuration, totalDurationSeconds, true);
        if (!config.preventOverlap || !overlapsExisting(win, chosenIntervals)) {
          const nearestMoment = findNearestMoment(moments, win.start + clipDuration / 2);
          const cIdx = Math.min(
            chunkCount - 1,
            Math.floor((win.start / Math.max(1, totalDurationSeconds)) * chunkCount)
          );
          chosenIntervals.push(win);
          selectedItems.push({
            interval: win,
            chunkIndex: cIdx,
            title: nearestMoment ? `${nearestMoment.title} (Cut)` : `Scene Cut ${formatFilenameTimestamp(win.start)}`,
            category: nearestMoment?.category ?? 'scene',
            summary: nearestMoment
              ? `Continuous sequence near: ${nearestMoment.summary}`
              : `Visual scene transition detected at ${formatFilenameTimestamp(win.start)}.`,
            score: nearestMoment ? Math.max(40, nearestMoment.score - 12) : 55,
          });
        }
      }
    }

    // Pass 4: Exact free-gap packing across uncovered timeline segments (supports back-to-back clips)
    if (selectedItems.length < targetCount && config.preventOverlap) {
      const sortedChosen = [...chosenIntervals].sort((a, b) => a.start - b.start);
      const gaps: Interval[] = [];
      let prevEnd = 0;
      for (const iv of sortedChosen) {
        if (iv.start - prevEnd >= clipDuration - 0.02) {
          gaps.push({ start: prevEnd, end: iv.start });
        }
        prevEnd = Math.max(prevEnd, iv.end);
      }
      if (totalDurationSeconds - prevEnd >= clipDuration - 0.02) {
        gaps.push({ start: prevEnd, end: totalDurationSeconds });
      }

      for (const gap of gaps) {
        let cursor = gap.start;
        while (selectedItems.length < targetCount && cursor + clipDuration <= gap.end + 0.02) {
          const safeStart = Math.min(cursor, Math.max(0, gap.end - clipDuration));
          const win = clampWindow(safeStart, clipDuration, totalDurationSeconds, true);
          if (!overlapsExisting(win, chosenIntervals, 0.02)) {
            const nearestMoment = findNearestMoment(moments, win.start + clipDuration / 2);
            const cIdx = Math.min(
              chunkCount - 1,
              Math.floor((win.start / Math.max(1, totalDurationSeconds)) * chunkCount)
            );
            chosenIntervals.push(win);
            selectedItems.push({
              interval: win,
              chunkIndex: cIdx,
              title: nearestMoment
                ? `${nearestMoment.title} — Part`
                : `Segment ${formatFilenameTimestamp(win.start)}`,
              category: nearestMoment?.category ?? 'scene',
              summary: nearestMoment
                ? `Extended film segment around ${nearestMoment.title}.`
                : `Timeline segment spanning ${formatFilenameTimestamp(win.start)} to ${formatFilenameTimestamp(win.end)}.`,
              score: nearestMoment ? Math.max(35, nearestMoment.score - 18) : 50,
            });
          }
          cursor += clipDuration;
        }
      }
    }
  }

  // Pass 4b: Anti-fragmentation ordered zone partitioning.
  // Guarantees exact targetCount non-overlapping (or tolerance-fitted) clips with exact clipDuration
  // even when tight durations (e.g., 3 × 15s on 45s) or greedy AI placement would leave fragments.
  if (selectedItems.length < targetCount && config.preventOverlap && targetCount <= maxNonOverlapping) {
    selectedItems.length = 0;
    chosenIntervals.length = 0;
    const usedMomentIds = new Set<string>();
    const maxStart = Math.max(0, totalDurationSeconds - clipDuration);

    if (targetCount === 1) {
      const topMoment = scoredMoments[0]?.moment;
      const win = clampWindow(
        topMoment ? topMoment.peakSeconds : totalDurationSeconds / 2,
        clipDuration,
        totalDurationSeconds,
        false
      );
      const matched = findBestMomentInWindow(scoredMoments, win.start, win.end, usedMomentIds);
      if (matched) usedMomentIds.add(matched.id);
      const cIdx = Math.min(
        chunkCount - 1,
        Math.floor((win.start / Math.max(1, totalDurationSeconds)) * chunkCount)
      );
      chosenIntervals.push(win);
      selectedItems.push({
        interval: win,
        chunkIndex: matched?.chunkIndex ?? cIdx,
        title: matched?.title ?? `Highlight ${formatFilenameTimestamp(win.start)}`,
        category: matched?.category ?? 'highlight',
        summary:
          matched?.summary ??
          `Timeline segment spanning ${formatFilenameTimestamp(win.start)} to ${formatFilenameTimestamp(win.end)}.`,
        transcriptSnippet: matched?.transcriptSnippet,
        score: matched?.score ?? 75,
      });
    } else if (targetCount * clipDuration <= totalDurationSeconds + 0.02) {
      // Exact non-overlapping placement inside ordered zones
      let prevEnd = 0;
      for (let i = 0; i < targetCount; i += 1) {
        const minStart = prevEnd;
        const maxZoneStart = Math.max(
          minStart,
          totalDurationSeconds - (targetCount - i) * clipDuration
        );
        const evenlySpaced =
          targetCount === 1 ? 0 : (i / (targetCount - 1)) * maxStart;
        let chosenStart = Math.max(minStart, Math.min(maxZoneStart, evenlySpaced));

        if (maxZoneStart - minStart > 0.5) {
          const zoneMoment = scoredMoments.find(
            (item) =>
              !usedMomentIds.has(item.moment.id) &&
              item.moment.peakSeconds >= minStart &&
              item.moment.peakSeconds <= maxZoneStart + clipDuration
          )?.moment;
          if (zoneMoment) {
            const centered = zoneMoment.peakSeconds - clipDuration / 2;
            chosenStart = Math.max(minStart, Math.min(maxZoneStart, centered));
          }
        }

        const win = clampWindow(chosenStart, clipDuration, totalDurationSeconds, true);
        const matched = findBestMomentInWindow(scoredMoments, win.start, win.end, usedMomentIds);
        if (matched) usedMomentIds.add(matched.id);
        const cIdx = Math.min(
          chunkCount - 1,
          Math.floor((win.start / Math.max(1, totalDurationSeconds)) * chunkCount)
        );
        chosenIntervals.push(win);
        selectedItems.push({
          interval: win,
          chunkIndex: matched?.chunkIndex ?? cIdx,
          title: matched?.title ?? `Segment ${i + 1} (${formatFilenameTimestamp(win.start)})`,
          category: matched?.category ?? 'scene',
          summary:
            matched?.summary ??
            `Timeline segment spanning ${formatFilenameTimestamp(win.start)} to ${formatFilenameTimestamp(win.end)}.`,
          transcriptSnippet: matched?.transcriptSnippet,
          score: matched?.score ?? 70,
        });
        prevEnd = win.end;
      }
    } else {
      // Minor metadata rounding tolerance (e.g., 44.6s file for 3 × 15s clips):
      // stagger evenly across [0, maxStart] so every clip still gets full clipDuration
      for (let i = 0; i < targetCount; i += 1) {
        const ratio = i / (targetCount - 1);
        const win = clampWindow(ratio * maxStart, clipDuration, totalDurationSeconds, true);
        const matched = findBestMomentInWindow(scoredMoments, win.start, win.end, usedMomentIds);
        if (matched) usedMomentIds.add(matched.id);
        const cIdx = Math.min(
          chunkCount - 1,
          Math.floor((win.start / Math.max(1, totalDurationSeconds)) * chunkCount)
        );
        chosenIntervals.push(win);
        selectedItems.push({
          interval: win,
          chunkIndex: matched?.chunkIndex ?? cIdx,
          title: matched?.title ?? `Segment ${i + 1} (${formatFilenameTimestamp(win.start)})`,
          category: matched?.category ?? 'scene',
          summary:
            matched?.summary ??
            `Timeline segment spanning ${formatFilenameTimestamp(win.start)} to ${formatFilenameTimestamp(win.end)}.`,
          transcriptSnippet: matched?.transcriptSnippet,
          score: matched?.score ?? 70,
        });
      }
    }
  }

  // Pass 5: If user explicitly requested MORE clips than fit non-overlapping and enabled allowOverlapWhenExceeding (or disabled preventOverlap)
  if (
    selectedItems.length < targetCount &&
    (!config.preventOverlap || config.allowOverlapWhenExceeding)
  ) {
    const remainingNeeded = targetCount - selectedItems.length;
    const maxStart = Math.max(0, totalDurationSeconds - clipDuration);

    // First distribute evenly across the full timeline (0% -> 100%)
    const evenSlots = remainingNeeded;
    for (let i = 0; i < evenSlots && selectedItems.length < targetCount; i += 1) {
      const ratio = evenSlots === 1 ? 0.5 : i / (evenSlots - 1);
      const start = Math.round(ratio * maxStart * 100) / 100;
      const win = clampWindow(start, clipDuration, totalDurationSeconds, true);
      if (selectedItems.some((s) => Math.abs(s.interval.start - win.start) < 0.25)) {
        continue;
      }
      const nearestMoment = findNearestMoment(moments, win.start + clipDuration / 2);
      const cIdx = Math.min(
        chunkCount - 1,
        Math.floor((win.start / Math.max(1, totalDurationSeconds)) * chunkCount)
      );
      selectedItems.push({
        interval: win,
        chunkIndex: cIdx,
        title: nearestMoment
          ? `${nearestMoment.title} (Window ${selectedItems.length + 1})`
          : `Window ${formatFilenameTimestamp(win.start)}`,
        category: nearestMoment?.category ?? 'highlight',
        summary: nearestMoment
          ? nearestMoment.summary
          : `Staggered highlight window at ${formatFilenameTimestamp(win.start)}.`,
        score: nearestMoment?.score ?? 50,
      });
    }

    // If any slots collided with already-selected starts, fill with staggered midpoints across the full timeline
    if (selectedItems.length < targetCount) {
      const stillNeeded = targetCount - selectedItems.length;
      const gridSize = targetCount * 2;
      for (let g = 1; selectedItems.length < targetCount && g < gridSize; g += 2) {
        const ratio = g / gridSize;
        const win = clampWindow(ratio * maxStart, clipDuration, totalDurationSeconds, true);
        if (selectedItems.some((s) => Math.abs(s.interval.start - win.start) < 0.25)) {
          continue;
        }
        const nearestMoment = findNearestMoment(moments, win.start + clipDuration / 2);
        const cIdx = Math.min(
          chunkCount - 1,
          Math.floor((win.start / Math.max(1, totalDurationSeconds)) * chunkCount)
        );
        selectedItems.push({
          interval: win,
          chunkIndex: cIdx,
          title: nearestMoment
            ? `${nearestMoment.title} (Window ${selectedItems.length + 1})`
            : `Window ${formatFilenameTimestamp(win.start)}`,
          category: nearestMoment?.category ?? 'highlight',
          summary: nearestMoment
            ? nearestMoment.summary
            : `Staggered highlight window at ${formatFilenameTimestamp(win.start)}.`,
          score: nearestMoment?.score ?? 50,
        });
      }

      // Final fallback if ultra-short video has maxStart near 0
      while (selectedItems.length < targetCount) {
        const idxOffset = selectedItems.length - (targetCount - stillNeeded);
        const ratio = stillNeeded <= 1 ? 0.5 : idxOffset / Math.max(1, stillNeeded);
        const win = clampWindow(ratio * maxStart, clipDuration, totalDurationSeconds, true);
        const nearestMoment = findNearestMoment(moments, win.start + clipDuration / 2);
        const cIdx = Math.min(
          chunkCount - 1,
          Math.floor((win.start / Math.max(1, totalDurationSeconds)) * chunkCount)
        );
        selectedItems.push({
          interval: win,
          chunkIndex: cIdx,
          title: nearestMoment
            ? `${nearestMoment.title} (Alt)`
            : `Window ${formatFilenameTimestamp(win.start)}`,
          category: nearestMoment?.category ?? 'highlight',
          summary: nearestMoment
            ? nearestMoment.summary
            : `Staggered highlight window at ${formatFilenameTimestamp(win.start)}.`,
          score: nearestMoment?.score ?? 50,
        });
      }
    }
  }

  // Sort chronologically across the entire movie so clip #1 -> clip #N flow from beginning to end
  selectedItems.sort((a, b) => a.interval.start - b.interval.start);

  return selectedItems.map((item, idx) => {
    const partNumber = idx + 1;
    const num = String(partNumber).padStart(4, '0');
    const cleanTitle = item.title.trim();
    const hasPartWord = /\bpart\s*\d+\b/i.test(cleanTitle);
    const isGenericTitle = /^(segment\s+\d+|window\s+|highlight\s+)/i.test(cleanTitle);
    const tsTag = formatFilenameTimestamp(item.interval.start);
    const numberedTitle = hasPartWord
      ? cleanTitle
      : isGenericTitle
        ? movieTitle
          ? `${movieTitle} — Part ${partNumber}`
          : `Part ${partNumber} (${tsTag})`
        : `Part ${partNumber} — ${cleanTitle}`;

    const slug = sanitizeFileSlug(numberedTitle);
    return {
      id: `clip-${partNumber}`,
      index: partNumber,
      chunkIndex: item.chunkIndex,
      title: numberedTitle,
      category: item.category,
      summary: item.summary,
      transcriptSnippet: item.transcriptSnippet,
      score: item.score,
      startSeconds: item.interval.start,
      endSeconds: item.interval.end,
      durationSeconds: Math.round((item.interval.end - item.interval.start) * 100) / 100,
      status: 'queued',
      attempts: 0,
      outputFilename: `clip_${num}_part_${String(partNumber).padStart(2, '0')}_${tsTag}_${slug}.mp4`,
    };
  });
}

function findNearestMoment(moments: DetectedMoment[], timestamp: number): DetectedMoment | undefined {
  let best: DetectedMoment | undefined;
  let bestDist = Infinity;
  for (const m of moments) {
    const dist = Math.abs(m.peakSeconds - timestamp);
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
  }
  return best;
}

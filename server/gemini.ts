import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import fs from 'node:fs/promises';
import type { DetectedMoment, MomentCategory } from '../src/types/clipper.ts';

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in server environment.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function formatHms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RawGeminiMoment {
  relativeStartSeconds: number;
  relativeEndSeconds: number;
  title: string;
  category: string;
  summary: string;
  transcriptSnippet?: string;
  score: number;
}

const ALLOWED_CATEGORIES: MomentCategory[] = [
  'scene',
  'dialogue',
  'action',
  'emotional',
  'comedy',
  'memorable_quote',
  'story_milestone',
  'highlight',
];

function normalizeCategory(raw: string): MomentCategory {
  const lower = (raw || '').toLowerCase().trim() as MomentCategory;
  return ALLOWED_CATEGORIES.includes(lower) ? lower : 'highlight';
}

export async function analyzeMovieChunkWithGemini(params: {
  chunkPath: string;
  chunkIndex: number;
  totalChunks: number;
  chunkStartSeconds: number;
  chunkDurationSeconds: number;
  totalMovieDurationSeconds: number;
  targetMomentsPerChunk: number;
  focusCategories: MomentCategory[];
}): Promise<DetectedMoment[]> {
  const {
    chunkPath,
    chunkIndex,
    totalChunks,
    chunkStartSeconds,
    chunkDurationSeconds,
    totalMovieDurationSeconds,
    targetMomentsPerChunk,
    focusCategories,
  } = params;

  const ai = getAiClient();
  const stat = await fs.stat(chunkPath);

  let uploadedFileName: string | null = null;

  try {
    let mediaPart:
      | { fileData: { fileUri: string; mimeType: string } }
      | { inlineData: { data: string; mimeType: string } };

    // Use inlineData up to 14MB to avoid extra Files API upload/polling round-trips for compact 360p proxy chunks
    if (stat.size <= 14 * 1024 * 1024) {
      const buffer = await fs.readFile(chunkPath);
      mediaPart = {
        inlineData: {
          mimeType: 'video/mp4',
          data: buffer.toString('base64'),
        },
      };
    } else {
      const uploadResult = await ai.files.upload({
        file: chunkPath,
        config: { mimeType: 'video/mp4' },
      });

      if (!uploadResult.name || !uploadResult.uri) {
        throw new Error('Gemini File API upload did not return a file URI.');
      }
      uploadedFileName = uploadResult.name;

      let fileState = uploadResult.state;
      let fileUri = uploadResult.uri;
      let waitChecks = 0;

      while (fileState === 'PROCESSING' && waitChecks < 45) {
        await sleep(2000);
        const info = await ai.files.get({ name: uploadedFileName });
        fileState = info.state;
        if (info.uri) fileUri = info.uri;
        waitChecks += 1;
      }

      if (fileState === 'FAILED') {
        throw new Error('Gemini File API failed while processing video chunk.');
      }

      mediaPart = {
        fileData: {
          fileUri,
          mimeType: 'video/mp4',
        },
      };
    }

    const focusDesc =
      focusCategories.length > 0
        ? focusCategories.join(', ')
        : 'scene, dialogue, action, emotional, comedy, memorable_quote, story_milestone, highlight';

    const desiredCount = Math.max(4, Math.min(30, targetMomentsPerChunk));

    const prompt = `You are a master film editor analyzing Segment ${chunkIndex + 1} of ${totalChunks} of a complete feature film.
This video chunk spans from ${formatHms(chunkStartSeconds)} to ${formatHms(chunkStartSeconds + chunkDurationSeconds)} out of a total runtime of ${formatHms(totalMovieDurationSeconds)}.
Chunk local duration is ${chunkDurationSeconds.toFixed(1)} seconds (local timestamps 0 to ${chunkDurationSeconds.toFixed(1)}).

Inspect the ENTIRE chunk from 0s to ${chunkDurationSeconds.toFixed(1)}s — both visuals and audio/dialogue.
Identify up to ${desiredCount} distinct scenes and standout moments spread across the entire chunk, prioritizing: ${focusDesc}.
Look for:
- Scene transitions & visual set pieces (scene)
- Compelling conversations & exchanges (dialogue)
- High-energy action sequences (action)
- Emotional or dramatic turning points (emotional)
- Funny or comedic moments (comedy)
- Memorable lines or quotes (memorable_quote)
- Key plot reveals & story milestones (story_milestone)
- Best overall highlights (highlight)

Rules:
- Report relativeStartSeconds and relativeEndSeconds strictly in LOCAL chunk seconds between 0 and ${chunkDurationSeconds.toFixed(1)}.
- Ensure moments cover early, middle, and late portions of this chunk without clustering everything at the start.
- Give each moment a crisp, natural editorial title (3–7 words), accurate category, 1-sentence summary, optional short dialogue quote, and a salience score (1–100).`;

    const generatePromise = ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: { parts: [mediaPart, { text: prompt }] },
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              relativeStartSeconds: {
                type: Type.NUMBER,
                description: 'Start time in seconds within this chunk (0 to chunk duration).',
              },
              relativeEndSeconds: {
                type: Type.NUMBER,
                description: 'End time in seconds within this chunk.',
              },
              title: {
                type: Type.STRING,
                description: 'Short editorial clip title.',
              },
              category: {
                type: Type.STRING,
                description: 'One of: scene, dialogue, action, emotional, comedy, memorable_quote, story_milestone, highlight.',
              },
              summary: {
                type: Type.STRING,
                description: 'Concise 1-sentence description of what happens in this moment.',
              },
              transcriptSnippet: {
                type: Type.STRING,
                description: 'Notable spoken line or dialogue snippet if audible.',
              },
              score: {
                type: Type.NUMBER,
                description: 'Importance and engagement score from 1 to 100.',
              },
            },
            required: ['relativeStartSeconds', 'relativeEndSeconds', 'title', 'category', 'summary', 'score'],
          },
        },
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Gemini chunk analysis timed out after 150s')), 150000);
    });

    const response = await Promise.race([generatePromise, timeoutPromise]);

    const rawText = (response.text ?? '[]')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');
    let parsed: RawGeminiMoment[] = [];
    try {
      parsed = JSON.parse(rawText) as RawGeminiMoment[];
    } catch {
      parsed = [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    const moments: DetectedMoment[] = [];
    for (let i = 0; i < parsed.length; i += 1) {
      const item = parsed[i];
      const relStart = Math.max(0, Math.min(chunkDurationSeconds - 1, Number(item.relativeStartSeconds) || 0));
      const relEnd = Math.max(relStart + 1, Math.min(chunkDurationSeconds, Number(item.relativeEndSeconds) || relStart + 10));
      const absStart = Math.round((chunkStartSeconds + relStart) * 100) / 100;
      const absEnd = Math.round((chunkStartSeconds + relEnd) * 100) / 100;
      const peak = Math.round(((absStart + absEnd) / 2) * 100) / 100;

      moments.push({
        id: `m-${chunkIndex}-${i}-${Math.round(absStart)}`,
        chunkIndex,
        startSeconds: absStart,
        endSeconds: absEnd,
        peakSeconds: peak,
        title: (item.title || `Scene ${chunkIndex + 1}.${i + 1}`).slice(0, 90),
        category: normalizeCategory(item.category),
        summary: (item.summary || 'Detected film moment').slice(0, 260),
        transcriptSnippet: item.transcriptSnippet ? item.transcriptSnippet.slice(0, 180) : undefined,
        score: Math.max(1, Math.min(100, Math.round(Number(item.score) || 70))),
        source: 'gemini',
      });
    }

    return moments;
  } finally {
    if (uploadedFileName) {
      await ai.files.delete({ name: uploadedFileName }).catch(() => undefined);
    }
  }
}

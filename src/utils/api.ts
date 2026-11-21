const ENV_API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim().replace(/\/+$/, '') || '';

let detectedSubpathBase = computeInitialSubpathBase();
let healthPromise: Promise<BackendHealthResult> | null = null;

export interface BackendHealthResult {
  ok: boolean;
  status?: number;
  detail?: string;
}

function computeInitialSubpathBase(): string {
  if (ENV_API_BASE) return '';
  if (typeof window === 'undefined') return '';
  const pathname = window.location.pathname || '/';
  const cleaned = pathname.replace(/\/index\.html$/i, '').replace(/\/+$/, '');
  // Only treat as mount prefix when not at root
  return cleaned && cleaned !== '/' ? cleaned : '';
}

export function apiUrl(apiPath: string): string {
  const normalized = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  if (ENV_API_BASE) {
    return `${ENV_API_BASE}${normalized}`;
  }
  return `${detectedSubpathBase}${normalized}`;
}

async function probeHealthEndpoint(url: string): Promise<BackendHealthResult> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    if (!ct.toLowerCase().includes('application/json')) {
      return {
        ok: false,
        status: 404,
        detail: 'Server returned HTML instead of API JSON (static-only hosting detected).',
      };
    }
    const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (!json || json.ok !== true) {
      return { ok: false, status: res.status };
    }
    return { ok: true, status: 200 };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : 'Unable to reach backend API.',
    };
  }
}

export async function checkBackendHealth(force = false): Promise<BackendHealthResult> {
  if (healthPromise && !force) {
    return healthPromise;
  }

  healthPromise = (async () => {
    if (ENV_API_BASE) {
      return probeHealthEndpoint(`${ENV_API_BASE}/api/health`);
    }

    const candidatePrefix = computeInitialSubpathBase();
    if (candidatePrefix) {
      const subRes = await probeHealthEndpoint(`${candidatePrefix}/api/health`);
      if (subRes.ok) {
        detectedSubpathBase = candidatePrefix;
        return subRes;
      }
    }

    const rootRes = await probeHealthEndpoint('/api/health');
    if (rootRes.ok) {
      detectedSubpathBase = '';
      return rootRes;
    }

    return candidatePrefix ? await probeHealthEndpoint(`${candidatePrefix}/api/health`) : rootRes;
  })();

  return healthPromise;
}

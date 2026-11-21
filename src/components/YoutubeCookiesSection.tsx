import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, KeyRound, Trash2, Upload } from 'lucide-react';
import type { YoutubeCookiesStatus } from '../types/clipper';
import { apiUrl } from '../utils/api';

interface YoutubeCookiesSectionProps {
  defaultExpanded?: boolean;
  onStatusChange?: (status: YoutubeCookiesStatus) => void;
}

export const YoutubeCookiesSection: React.FC<YoutubeCookiesSectionProps> = ({
  defaultExpanded = false,
  onStatusChange,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [status, setStatus] = useState<YoutubeCookiesStatus | null>(null);
  const [cookiesText, setCookiesText] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/settings/youtube-cookies'));
      if (!res.ok) return;
      const data = (await res.json()) as { cookies?: YoutubeCookiesStatus };
      if (data.cookies) {
        setStatus(data.cookies);
        onStatusChange?.(data.cookies);
      }
    } catch {
      // Ignore transient error
    }
  }, [onStatusChange]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleSave = async (rawText?: string) => {
    const payload = (rawText ?? cookiesText).trim();
    if (!payload) {
      setError('Paste Netscape cookies.txt text or choose a .txt file first.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(apiUrl('/api/settings/youtube-cookies'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookiesText: payload }),
      });
      const data = (await res.json()) as { cookies?: YoutubeCookiesStatus; error?: string };
      if (!res.ok || !data.cookies) {
        throw new Error(data.error || 'Failed to save YouTube cookies.');
      }
      setStatus(data.cookies);
      onStatusChange?.(data.cookies);
      setCookiesText('');
      setNotice(`Saved ${data.cookies.cookieCount} cookies for direct YouTube downloads.`);
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save cookies');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(apiUrl('/api/settings/youtube-cookies'), { method: 'DELETE' });
      const data = (await res.json()) as { cookies?: YoutubeCookiesStatus; error?: string };
      if (!res.ok || !data.cookies) {
        throw new Error(data.error || 'Failed to clear cookies.');
      }
      setStatus(data.cookies);
      onStatusChange?.(data.cookies);
      setNotice('Saved YouTube cookies cleared.');
      setTimeout(() => setNotice(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear cookies');
    } finally {
      setClearing(false);
    }
  };

  const handleFileSelect = async (file: File) => {
    const text = await file.text();
    setCookiesText(text);
    await handleSave(text);
  };

  return (
    <div className="pt-4 border-t border-slate-800/80 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <KeyRound className="h-4 w-4 text-amber-400 shrink-0" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-200">
              <span>YouTube Direct-Link Authentication (cookies.txt)</span>
              <span aria-hidden="true" className="text-slate-600">
                ·
              </span>
              {status?.configured ? (
                <span className="inline-flex items-center gap-1 text-emerald-400 tabular-nums">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>Active ({status.cookieCount} cookies)</span>
                </span>
              ) : (
                <span className="text-slate-400">Optional (needed only for direct youtube.com links)</span>
              )}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 border border-slate-700 bg-[#0B0E14] rounded-lg hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          <span>{expanded ? 'Hide Cookies Setup' : status?.configured ? 'Manage Cookies' : 'Add YouTube Cookies'}</span>
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      {expanded && (
        <div className="space-y-3 pt-1">
          <p className="text-xs text-slate-400 leading-relaxed">
            Cloud server IPs sometimes trigger YouTube’s bot check on direct{' '}
            <code className="font-mono text-slate-300">youtube.com</code> links. Note: videos pulled
            from your external tool already use its stream proxy automatically when available. For
            direct YouTube links, export Netscape <code className="font-mono text-slate-300">cookies.txt</code>{' '}
            from a logged-in browser (e.g. "Get cookies.txt LOCALLY") and upload or paste it below.
            Cookies stay private on the server and are never sent back to the browser.
          </p>

          {error && (
            <div className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          {notice && (
            <div className="rounded-lg border border-emerald-800/70 bg-emerald-950/25 px-3 py-2 text-xs text-emerald-200">
              {notice}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                void handleFileSelect(f);
                e.target.value = '';
              }
            }}
          />

          <textarea
            rows={4}
            value={cookiesText}
            onChange={(e) => setCookiesText(e.target.value)}
            placeholder={'# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t...\tSID\t...'}
            className="w-full rounded-lg border border-slate-700 bg-[#0B0E14] px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-500"
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 border border-slate-700 bg-[#0B0E14] rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <Upload className="h-3.5 w-3.5 text-amber-400" />
                <span>Upload cookies.txt File</span>
              </button>

              {status?.configured && (
                <button
                  type="button"
                  disabled={clearing}
                  onClick={() => void handleClear()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-300 border border-red-900/60 bg-red-950/20 rounded-lg hover:bg-red-950/40 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{clearing ? 'Clearing...' : 'Remove Saved Cookies'}</span>
                </button>
              )}
            </div>

            <button
              type="button"
              disabled={saving || !cookiesText.trim()}
              onClick={() => void handleSave()}
              className="px-4 py-1.5 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              {saving ? 'Saving...' : 'Save YouTube Cookies'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

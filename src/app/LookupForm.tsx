'use client';

import { useState, useEffect, useRef, type FormEvent } from 'react';
import { brand } from '@/lib/brand';

const CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;

export default function LookupForm() {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoMode, setAutoMode] = useState(false);
  const autoTriedRef = useRef(false);

  async function lookup(rawCode: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const res = await fetch('/api/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: rawCode.trim() }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
    if (!res.ok || !data.ok || !data.url) {
      return {
        ok: false,
        error: data.error ?? "We couldn't find that reservation. Double-check the code and try again.",
      };
    }
    return { ok: true, url: data.url };
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await lookup(code);
      if (!result.ok) {
        setError(result.error);
        setLoading(false);
        return;
      }
      window.location.href = result.url;
    } catch {
      setError("We couldn't reach the server. Check your connection and try again.");
      setLoading(false);
    }
  }

  // Auto-redirect when ?code= is present in the URL.
  useEffect(() => {
    if (autoTriedRef.current) return;
    autoTriedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const urlCode = params.get('code')?.trim() ?? '';
    if (!urlCode || !CODE_RE.test(urlCode)) return;

    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCode(urlCode);
     
    setAutoMode(true);
     
    setLoading(true);

    lookup(urlCode)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setError(result.error);
          setLoading(false);
          setAutoMode(false);
          return;
        }
        window.location.href = result.url;
      })
      .catch(() => {
        if (cancelled) return;
        setError("We couldn't reach the server. Check your connection and try again.");
        setLoading(false);
        setAutoMode(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const disabled = loading || code.trim().length === 0;

  if (autoMode && loading) {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <svg className="h-8 w-8 animate-spin text-accent" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
          <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <p className="text-base text-ink">Opening your trip…</p>
        <p className="text-xs text-ink-muted">One moment while we find your reservation.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <label
        htmlFor="code"
        className="group block rounded-2xl border border-border bg-surface px-5 py-3 transition-colors hover:border-border-strong focus-within:border-ink focus-within:ring-1 focus-within:ring-ink"
      >
        <span className="block text-[11px] font-semibold tracking-wider uppercase text-ink-muted">
          {brand.inputLabel}
        </span>
        <input
          id="code"
          name="code"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={brand.inputPlaceholder}
          className="mt-1 w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-muted/60 uppercase tracking-wider"
        />
      </label>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={disabled}
        className="group relative w-full rounded-xl bg-accent py-3.5 text-base font-semibold text-accent-ink shadow-[var(--shadow-button)] transition-all hover:bg-accent-hover hover:shadow-md active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-border-strong disabled:shadow-none"
      >
        <span className="inline-flex items-center justify-center gap-2">
          {loading && (
            <svg
              className="h-4 w-4 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
              <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
          {loading ? brand.submitLoadingLabel : brand.submitLabel}
        </span>
      </button>

      <p className="text-center text-xs text-ink-muted">{brand.helperText}</p>
    </form>
  );
}

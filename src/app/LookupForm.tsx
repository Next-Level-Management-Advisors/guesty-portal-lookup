'use client';

import { useState, type FormEvent } from 'react';

export default function LookupForm() {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = (await res.json()) as { ok: boolean; url?: string; error?: string };
      if (!res.ok || !data.ok || !data.url) {
        setError(data.error ?? 'Could not find your reservation.');
        setLoading(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError('Something went wrong. Please try again.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <label htmlFor="code" className="block">
        <span className="text-xs uppercase tracking-wider font-medium text-ink-muted">
          Confirmation code
        </span>
        <div className="mt-1.5 border border-border rounded-xl px-4 py-3 hover:border-border-strong focus-within:border-accent transition-colors">
          <input
            id="code"
            name="code"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. HMABCD12345"
            className="w-full bg-transparent text-base outline-none placeholder:text-ink-muted/60 uppercase tracking-wider"
          />
        </div>
      </label>
      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={loading || code.trim().length < 4}
        className="w-full rounded-xl bg-accent text-white py-3 text-sm font-medium hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-border-strong transition-colors"
      >
        {loading ? 'Looking up…' : 'Find my reservation'}
      </button>
      <p className="text-xs text-ink-muted text-center">
        Can&rsquo;t find your code? Check the booking confirmation from your host.
      </p>
    </form>
  );
}

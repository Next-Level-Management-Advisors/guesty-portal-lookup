import LookupForm from './LookupForm';
import { brand } from '@/lib/brand';

function CheckIcon() {
  return (
    <svg
      className="mt-0.5 h-4 w-4 flex-none text-accent"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 10.5l3.5 3.5L16 5.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Page() {
  return (
    <section className="w-full max-w-xl px-6 py-12 sm:py-20">
      <div className="text-center sm:text-left">
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-ink leading-[1.1]">
          {brand.headline}
        </h1>
        <p className="mt-4 text-base sm:text-lg text-ink-muted leading-relaxed max-w-md sm:max-w-none mx-auto">
          {brand.subhead}
        </p>
      </div>

      <div className="mt-10 rounded-3xl border border-border bg-surface p-6 sm:p-8 shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-card-hover)] transition-shadow">
        <LookupForm />
      </div>

      <ul className="mt-10 space-y-2.5 text-sm text-ink-muted">
        <li className="flex items-start gap-3">
          <CheckIcon />
          <span>Works with any booking — Airbnb, Vrbo, Booking.com, or direct.</span>
        </li>
        <li className="flex items-start gap-3">
          <CheckIcon />
          <span>Your code stays on your device. We don&rsquo;t store it.</span>
        </li>
        <li className="flex items-start gap-3">
          <CheckIcon />
          <span>One click takes you to the same portal your host links to.</span>
        </li>
      </ul>
    </section>
  );
}

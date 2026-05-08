import LookupForm from './LookupForm';

const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME ?? 'Guest Portal';

export default function Page() {
  return (
    <article className="w-full max-w-md px-4 sm:px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Find your trip</h1>
      <p className="mt-3 text-ink-muted leading-relaxed">
        Enter the confirmation code from your booking. We&rsquo;ll send you straight to your guest
        portal — check-in details, messaging, and trip info.
      </p>

      <div className="mt-8 rounded-2xl border border-border bg-surface p-6">
        <LookupForm />
      </div>

      <p className="mt-8 text-xs text-ink-muted text-center">
        {SITE_NAME}
      </p>
    </article>
  );
}

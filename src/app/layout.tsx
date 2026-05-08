import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { brand } from '@/lib/brand';
import './globals.css';

const inter = Inter({ variable: '--font-sans', subsets: ['latin'], display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL(brand.siteUrl),
  title: { default: `${brand.siteName} — ${brand.headline}`, template: `%s · ${brand.siteName}` },
  description: 'Look up your reservation by confirmation code to access your guest portal.',
  robots: { index: false, follow: false },
  icons: { icon: brand.faviconUrl },
};

const brandThemeCss = `:root{--color-accent:${brand.accentColor};--color-accent-hover:${brand.accentHoverColor};--color-accent-ink:${brand.accentInk};}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: brandThemeCss }} />
      </head>
      <body className="min-h-full flex flex-col bg-ambient text-ink font-sans">
        <header className="w-full border-b border-border bg-surface/80 backdrop-blur supports-[backdrop-filter]:bg-surface/60 sticky top-0 z-10">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
            <a href={brand.supportUrl ?? '/'} className="flex items-center gap-2">
              {brand.logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={brand.logoUrl} alt={brand.siteName} className="h-8 w-auto" />
              )}
              <span className="sr-only">{brand.siteName}</span>
            </a>
            <span className="text-sm text-ink-muted hidden sm:inline">{brand.siteName}</span>
          </div>
        </header>
        <main className="flex-1 flex items-start sm:items-center justify-center">{children}</main>
        <footer className="w-full border-t border-border bg-surface">
          <div className="max-w-6xl mx-auto px-6 py-5 text-xs text-ink-muted flex items-center justify-between">
            <span>© {new Date().getFullYear()} {brand.siteName}</span>
            {brand.supportUrl && (
              <a href={brand.supportUrl} className="hover:text-ink transition-colors">
                Need help?
              </a>
            )}
          </div>
        </footer>
      </body>
    </html>
  );
}

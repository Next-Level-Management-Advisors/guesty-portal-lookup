import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ variable: '--font-sans', subsets: ['latin'], display: 'swap' });

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://portal.fidumcompany.com';
const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME ?? 'Guest Portal';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${SITE_NAME} — Find your trip`, template: `%s · ${SITE_NAME}` },
  description: 'Look up your reservation by confirmation code to access your guest portal.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-bg text-ink font-sans">
        <main className="flex-1 flex items-center justify-center">{children}</main>
      </body>
    </html>
  );
}

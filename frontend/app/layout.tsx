import "./globals.css";
import { THEME_BOOT_SCRIPT } from "@/lib/use-theme";
export const metadata = {
  title: "Truex · Agent workspace",
  description: "A workspace for conversations with your agents",
};
// Fonts load through the spec's own link (Appendix → Font loading) rather than
// next/font, which renames families and would break the spec's --font-* tokens.
const FONTS =
  "https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=Newsreader:ital,opsz,wght@1,6..72,400..500&family=JetBrains+Mono:wght@400;500&family=Caveat:wght@600;700&display=swap";
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body>{children}</body>
    </html>
  );
}

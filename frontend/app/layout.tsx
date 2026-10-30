import "./globals.css";
import { IconSprite } from "@/components/tx/icon";
import { SharedLiveRegion } from "@/components/tx/live";
import { SharedToastHost } from "@/components/tx/toast";
import { THEME_BOOT_SCRIPT } from "@/lib/theme-boot";
export const metadata = {
  title: "Truex · Agent workspace",
  description: "A workspace for conversations with your agents",
};
// Fonts load through the spec's own link (system/DESIGN-SPEC.md 2.1) rather than
// next/font, which renames families and would break the --f-* tokens.
const FONTS =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,300..800&family=Instrument+Serif:ital@0;1&family=Geist+Mono:wght@400;500;600&display=swap";
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
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
      {/* Browser extensions (ColorZilla's cz-shortcut-listen, Grammarly) add
          attributes to <body> before React hydrates; this ignores attribute
          differences on <body> only, not in the tree below it. */}
      <body suppressHydrationWarning>
        <IconSprite />
        {children}
        <SharedLiveRegion />
        <SharedToastHost />
      </body>
    </html>
  );
}

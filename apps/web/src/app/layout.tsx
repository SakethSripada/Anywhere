import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Providers } from "@/components/app/providers";
import { Shell } from "@/components/app/shell";
import { cn } from "@/lib/utils";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Anywhere", template: "%s · Anywhere" },
  description: "Describe what you want to do. Anywhere provisions and operates the computer for you.",
};

// Every screen renders from the browser's live SpacetimeDB connection, which
// cannot exist at prerender time; the static shell is the "Connecting" state.
// Opt the app out of instant-navigation / static-shell validation accordingly.
export const instant = false;

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f5f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0b0e" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={cn("h-full", GeistSans.variable, GeistMono.variable)}>
      <body className="h-full overflow-hidden font-sans">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}

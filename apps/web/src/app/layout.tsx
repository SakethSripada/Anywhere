import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Providers } from "@/components/app/providers";
import { Shell } from "@/components/app/shell";
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
  themeColor: "#121316",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full`}>
      <body className="h-full overflow-hidden">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}

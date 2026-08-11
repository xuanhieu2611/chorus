import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Chorus",
  description: "One podcast, one objective, a multi-platform campaign built by agents.",
  openGraph: {
    title: "Chorus",
    description: "Seven agents turn one podcast into a multi-platform campaign, live.",
    type: "website",
  },
};

/**
 * The theme is locked dark rather than following the system. The dashboard is
 * built to be watched and recorded while a run is in flight, and the state
 * colours on the agent graph are tuned for a dark canvas.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

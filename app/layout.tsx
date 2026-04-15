import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Search, Activity } from "lucide-react";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Research Compare",
  description: "Three-way deep research dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} dark h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-[var(--background)] text-[var(--foreground)] font-sans">
        {/* ── Application header ──────────────────────────────── */}
        <header className="sticky top-0 z-50 flex items-center justify-between px-6 py-3 bg-[#1a2744] text-white shadow-md">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-[#c8a951]" />
            <span className="text-lg font-semibold tracking-tight">
              Research Compare
            </span>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/50" />
              <input
                type="text"
                placeholder="Search runs…"
                className="h-8 w-56 rounded-md border border-white/20 bg-white/10 pl-8 pr-3 text-sm placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-[#c8a951]"
              />
            </div>
          </div>
        </header>

        {/* ── Main content ────────────────────────────────────── */}
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import { Activity } from "lucide-react";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Dynamic AI Research",
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
          <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition">
            <Activity className="h-5 w-5 text-[#c8a951]" />
            <span className="text-lg font-semibold tracking-tight">
              Dynamic AI Research
            </span>
          </Link>
        </header>

        {/* ── Main content ────────────────────────────────────── */}
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}

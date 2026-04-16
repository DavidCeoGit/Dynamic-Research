import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import { Activity, Plus } from "lucide-react";
import { ToastProvider } from "@/components/ToastProvider";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Dynamic AI Research",
  description: "Manage and monitor AI-powered research pipelines.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} dark h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-[var(--background)] text-[var(--foreground)] font-sans">
        <ToastProvider>
          {/* ── Application header ──────────────────────────────── */}
          <header className="sticky top-0 z-50 flex items-center justify-between px-4 sm:px-6 py-3 bg-[#1a2744] text-white shadow-md">
            <Link href="/" className="flex items-center gap-2 sm:gap-3 hover:opacity-80 transition">
              <Activity className="h-5 w-5 text-[#c8a951]" />
              <span className="text-lg font-semibold tracking-tight truncate">
                Dynamic AI Research
              </span>
            </Link>
            <Link href="/new" className="flex items-center gap-2 rounded-md bg-[#c8a951] px-3 py-1.5 text-sm font-medium text-[#1a2744] hover:bg-[#d4b85e] transition">
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New Research</span>
              <span className="sm:hidden">New</span>
            </Link>
          </header>

          {/* ── Main content ────────────────────────────────────── */}
          <main className="flex-1">{children}</main>
        </ToastProvider>
      </body>
    </html>
  );
}

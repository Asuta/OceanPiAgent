import type { Metadata } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { WorkspaceProvider } from "@/components/workspace-provider";
import { WorkspaceShell } from "@/components/workspace-shell";
import { getThemeInitScript } from "@/lib/theme";
import "./globals.css";

const sans = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "OceanKing",
  description: "A room-first AI workspace built with Next.js and TypeScript.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: getThemeInitScript() }} />
      </head>
      <body className={`${sans.variable} ${mono.variable}`}>
        <ThemeProvider>
          <WorkspaceProvider>
            <WorkspaceShell>{children}</WorkspaceShell>
          </WorkspaceProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { Pixelify_Sans, Press_Start_2P, Silkscreen } from "next/font/google";
import "./globals.css";
import WorldColonyBackdrop from "@/three/WorldColonyBackdrop";

const pixelify = Pixelify_Sans({ weight: ["400", "500", "600", "700"], subsets: ["latin"], variable: "--font-pixelify" });
const pressStart = Press_Start_2P({ weight: "400", subsets: ["latin"], variable: "--font-press" });
const silkscreen = Silkscreen({ weight: ["400", "700"], subsets: ["latin"], variable: "--font-silk" });

export const metadata: Metadata = {
  title: "Age of Colony",
  description: "Command your colony. Predict the match. Rule the lobby.",
};

export const viewport: Viewport = {
  themeColor: "#08090C",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${pixelify.variable} ${pressStart.variable} ${silkscreen.variable}`}>
      <body>
        <WorldColonyBackdrop />
        <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-[480px] flex-col gap-3 px-4 pb-24 pt-4">
          {children}
        </div>
      </body>
    </html>
  );
}

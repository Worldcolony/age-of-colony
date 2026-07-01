import type { Metadata, Viewport } from "next";
import { Inter, Chakra_Petch, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import WorldColonyBackdrop from "@/three/WorldColonyBackdrop";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const chakra = Chakra_Petch({ weight: ["500", "600", "700"], subsets: ["latin"], variable: "--font-chakra" });
const jetbrains = JetBrains_Mono({ weight: ["400", "500", "700"], subsets: ["latin"], variable: "--font-jetbrains" });

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
    <html lang="en" className={`${inter.variable} ${chakra.variable} ${jetbrains.variable}`}>
      <body>
        <WorldColonyBackdrop />
        <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-[480px] flex-col gap-3 px-4 pb-24 pt-4">
          {children}
        </div>
      </body>
    </html>
  );
}

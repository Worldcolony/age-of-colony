"use client";

import { useEffect, useRef } from "react";
import { Pixelify_Sans, Silkscreen } from "next/font/google";

const pixelify = Pixelify_Sans({ subsets: ["latin"], weight: ["500", "600", "700"] });
const silkscreen = Silkscreen({ subsets: ["latin"], weight: ["400"] });

declare global {
  interface Window {
    mountScrollWorld?: (container: HTMLElement, config: unknown) => void;
  }
}

const CONFIG = {
  brand: { name: "World Colony", href: "/" },
  cta: { label: "Play", href: "/lobby" },
  hint: "scroll to enter the village",
  diveScroll: 1.3,
  crossfade: 0.08,
  sections: [
    {
      id: "gates",
      label: "The Gates",
      still: "/intro/gates.webp",
      clip: "/intro/vid/gates.mp4",
      clipMobile: "/intro/vid/gates-m.mp4?v=intra1",
      accent: "#B07E1C",
      scroll: 1.7,
      linger: 0.45,
      eyebrow: "Welcome to World Colony",
      title: "Command your colony.",
      body: "Every match, a living village of AI ants wakes up to predict it. Step through the gates.",
      tags: ["AI agents", "Free to play"],
    },
    {
      id: "board",
      label: "The Fixture Board",
      still: "/intro/board.webp",
      clip: "/intro/vid/board.mp4",
      clipMobile: "/intro/vid/board-m.mp4?v=intra1",
      accent: "#456F25",
      scroll: 1.3,
      eyebrow: "01 — Pick a fixture",
      title: "The board is up.",
      body: "Upcoming matches are pinned in the square. Choose one and join its room — one tap, no wallet.",
      tags: ["Walletless", "One tap"],
    },
    {
      id: "council",
      label: "The War Council",
      still: "/intro/council.webp",
      clip: "/intro/vid/council.mp4",
      clipMobile: "/intro/vid/council-m.mp4?v=intra1",
      accent: "#A9462F",
      scroll: 1.4,
      linger: 0.35,
      eyebrow: "02 — Set your strategy",
      title: "The war council sits.",
      body: "Tell your colony how to play it: bold or careful, follow the crowd or trust the stats. The queen listens.",
      tags: ["Strategy", "Team talk"],
    },
    {
      id: "loom",
      label: "The Prediction Loom",
      still: "/intro/loom.webp",
      clip: "/intro/vid/loom.mp4",
      clipMobile: "/intro/vid/loom-m.mp4?v=intra1",
      accent: "#B07E1C",
      scroll: 1.5,
      linger: 0.4,
      eyebrow: "03 — The colony decides",
      title: "Trails become truth.",
      body: "Thousands of tiny scouts explore the data and weave their findings into one glowing answer — the colony's prediction.",
      tags: ["Swarm intelligence", "Live prediction"],
    },
    {
      id: "victory",
      label: "Full Time",
      still: "/intro/victory.webp",
      clip: "/intro/vid/victory.mp4",
      clipMobile: "/intro/vid/victory-m.mp4?v=intra1",
      accent: "#B07E1C",
      scroll: 1.7,
      linger: 0.5,
      eyebrow: "Full time",
      title: "Claim the acorn.",
      body: "Right calls climb the leaderboard. The village celebrates its champions at dusk.",
      tags: [],
      cta: {
        primary: { label: "Enter the Lobby →", href: "/lobby" },
        secondary: { label: "How it works", href: "#board" },
      },
    },
  ],
  // Architecture A: one continuous forward take — the legs are the journey.
  connectors: [],
  connectorsMobile: [],
};

export default function IntroWorld() {
  const worldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = worldRef.current;
    if (!container) return;
    let cancelled = false;
    // globals.css pins html/body to height:100% + overflow-x:hidden, which turns the
    // body into its own scroll container — the engine scrubs off window.scrollY, so
    // document scrolling must be restored while the intro is mounted.
    document.documentElement.classList.add("intro-mode");

    const mount = () => {
      if (!cancelled && container.childElementCount === 0) {
        window.mountScrollWorld?.(container, CONFIG);
      }
    };

    if (window.mountScrollWorld) {
      mount();
    } else {
      const script = document.createElement("script");
      script.src = "/intro/scrub-engine.js?v=intra1";
      script.onload = mount;
      document.body.appendChild(script);
    }

    return () => {
      cancelled = true;
      document.documentElement.classList.remove("intro-mode");
      // the engine has no unmount API — drop its DOM so a remount starts clean
      container.replaceChildren();
    };
  }, []);

  return (
    <div className="aoc-intro">
      <style>{`
        .aoc-intro .sw-root, .aoc-intro {
          --sw-bg: #F3EBD3;
          --sw-ink: #2C2820;
          --sw-ink-soft: #5E5440;
          --sw-accent: #B07E1C;
          --sw-font-display: ${pixelify.style.fontFamily}, "Trebuchet MS", sans-serif;
          --sw-font-body: ${pixelify.style.fontFamily}, system-ui, sans-serif;
          --sw-font-mono: ${silkscreen.style.fontFamily}, monospace;
        }
        .aoc-intro { background: #F3EBD3; }
        /* restore document scrolling (engine reads window.scrollY) */
        html.intro-mode, html.intro-mode body { height: auto; overflow: visible; }
        /* hide the game shell chrome while the intro is up */
        html.intro-mode .tabbar,
        html.intro-mode .wallet-hud,
        html.intro-mode .scrim,
        html.intro-mode iframe[data-world] { display: none; }
        html.intro-mode .app-shell { max-width: none; padding: 0; gap: 0; }
      `}</style>
      <div ref={worldRef} />
    </div>
  );
}

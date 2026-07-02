"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStore } from "@/store/game";

// Thumb-reach navigation. Room/Cockpit/Ranks light up once a game exists.
export function BottomNav() {
  const pathname = usePathname();
  const game = useStore((s) => s.game);
  if (pathname === "/") return null; // title screen stays clean

  const code = game?.roomCode;
  const id = game?.gameId;
  const tabs = [
    { href: "/lobby", ic: "🏟️", label: "Play", active: pathname === "/lobby" || pathname === "/admin", disabled: false },
    { href: code ? `/room/${code}` : "/lobby", ic: "🎟️", label: "Room", active: pathname.startsWith("/room"), disabled: !code },
    { href: id ? `/cockpit/${id}` : "/setup", ic: "🐜", label: "Colony", active: pathname.startsWith("/cockpit") || pathname === "/setup", disabled: false },
    { href: id ? `/results/${id}` : "/lobby", ic: "🏆", label: "Ranks", active: pathname.startsWith("/results"), disabled: !id },
    { href: "/queen", ic: "👑", label: "Queen", active: pathname === "/queen", disabled: false },
  ];

  return (
    <nav className="tabbar" aria-label="Main">
      {tabs.map((t) => (
        <Link key={t.label} href={t.href} data-active={t.active} data-disabled={t.disabled}>
          <span className="ic">{t.ic}</span>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

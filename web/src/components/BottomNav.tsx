"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useStore } from "@/store/game";

// Thumb-reach navigation. Room/Cockpit/Ranks light up once a game exists.
export function BottomNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const game = useStore((s) => s.game);
  if (pathname === "/" || pathname === "/admin") return null; // title/admin screens use their own navigation hierarchy

  const code = game?.roomCode;
  const id = game?.gameId;
  const adminRoute = pathname.match(/^\/(?:cockpit|results)\/([^/]+)$/);
  const routeGameId = adminRoute?.[1];
  const navGameId = routeGameId ?? id;
  const routeGame = game?.gameId === routeGameId ? game : null;
  const adminContext = Boolean(adminRoute)
    && (routeGame
      ? routeGame.roomKind === "admin"
      : searchParams.get("from") === "admin");
  const playerTabs = [
    { href: "/lobby", ic: "🏟️", label: "Play", active: pathname === "/lobby" || pathname === "/admin", disabled: false },
    { href: code ? `/room/${code}` : "/lobby", ic: "🎟️", label: "Room", active: pathname.startsWith("/room"), disabled: !code },
    { href: id ? `/cockpit/${id}` : "/setup", ic: "🐜", label: "Colony", active: pathname.startsWith("/cockpit") || pathname === "/setup", disabled: false },
    { href: id ? `/results/${id}` : "/lobby", ic: "🏆", label: "Ranks", active: pathname.startsWith("/results"), disabled: !id },
    { href: "/queen", ic: "👑", label: "Queen", active: pathname === "/queen", disabled: false },
  ];
  const tabs = adminContext ? [
    { href: "/admin", ic: "👑", label: "Admin", active: false, disabled: false },
    { href: `/cockpit/${navGameId}?from=admin`, ic: "🐜", label: "Control", active: pathname.startsWith("/cockpit"), disabled: false },
    { href: `/results/${navGameId}?from=admin`, ic: "🏆", label: "Ranks", active: pathname.startsWith("/results"), disabled: false },
  ] : playerTabs;

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

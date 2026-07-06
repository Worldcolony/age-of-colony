"use client";
import { useEffect, type ReactNode } from "react";
import { worldLink } from "@/three/worldLink";

// Mobile-game shell: the living 3D world is the screen. This floats the HUD
// over it — identity chip (top-left), resource pills (top-right), a bottom
// dock of round buttons around one big CTA, and a slide-up parchment sheet
// for the page's content. While the sheet is down, touches go to the world.

export interface DockButton {
  icon: string;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}

export interface ResourcePill {
  icon: string;
  value: ReactNode;
  title?: string;
}

export function GameShell({
  chip,
  resources = [],
  nav = [],
  cta,
  sheetTitle,
  open,
  onOpenChange,
  hint,
  children,
}: {
  chip?: ReactNode;
  resources?: ResourcePill[];
  nav?: DockButton[];
  cta?: ReactNode;
  sheetTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hint?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    document.body.classList.add("game-mode");
    return () => {
      document.body.classList.remove("game-mode", "sheet-open");
      worldLink.setInteractive(false);
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle("sheet-open", open);
    worldLink.setInteractive(!open);
  }, [open]);

  return (
    <>
      {chip && <div className="g-chip">{chip}</div>}

      {resources.length > 0 && (
        <div className="g-res">
          {resources.map((r, i) => (
            <span key={i} className="res-pill" title={r.title}>
              <span className="ic">{r.icon}</span>
              <span className="v">{r.value}</span>
            </span>
          ))}
        </div>
      )}

      {!open && hint && <span className="g-hint">{hint}</span>}

      <div className="g-dock">
        {nav.map((b) => (
          <button
            key={b.label}
            type="button"
            className="g-dock-btn"
            data-active={Boolean(b.active)}
            disabled={b.disabled}
            style={b.disabled ? { opacity: 0.45, pointerEvents: "none" } : undefined}
            onClick={b.onClick}
          >
            <span className="ic">{b.icon}</span>
            <span className="lb">{b.label}</span>
          </button>
        ))}
        {cta}
      </div>

      <div className="g-sheet" role="dialog" aria-label={sheetTitle}>
        <div className="g-sheet-head relative" onClick={() => onOpenChange(!open)}>
          <span className="g-sheet-title">{sheetTitle}</span>
          <span className="g-sheet-close">{open ? "▼ close" : "▲ open"}</span>
        </div>
        <div className="g-sheet-body">{children}</div>
      </div>
    </>
  );
}

export function GameChip({ emblem, title, sub }: { emblem: string; title: string; sub?: string }) {
  return (
    <>
      <span className="emblem">{emblem}</span>
      <span className="min-w-0">
        <span className="t block truncate">{title}</span>
        {sub && <span className="s block truncate">{sub}</span>}
      </span>
    </>
  );
}

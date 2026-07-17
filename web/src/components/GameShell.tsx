"use client";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { worldLink } from "@/three/worldLink";

// Mobile-game shell: the living 3D world is the screen. This floats the HUD
// over it — identity chip (top-left), resource pills (top-right), a bottom
// dock of round buttons around one big CTA, and a slide-up parchment sheet
// for the page's content. While the sheet is down, touches go to the world.

export interface DockButton {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}

export interface ResourcePill {
  icon: ReactNode;
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
    // Scroll restoration can leave a fixed game screen offset after navigation.
    window.scrollTo(0, 0);
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

  // --- drag-to-dismiss on the sheet head: pointer down + track vertical
  // drag with a live transform; release past ~90px closes, else springs
  // back (the spring is just the sheet's own CSS transition, which is
  // itself disabled under prefers-reduced-motion). ---
  const dragRef = useRef<{ startY: number; pointerId: number; dragging: boolean } | null>(null);
  const draggedRef = useRef(false);
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const handleHeadPointerDown = useCallback((e: ReactPointerEvent) => {
    if (!open) return; // only closed by dragging while it's open
    dragRef.current = { startY: e.clientY, pointerId: e.pointerId, dragging: false };
  }, [open]);

  const handleHeadPointerMove = useCallback((e: ReactPointerEvent) => {
    const st = dragRef.current;
    if (!st || !open) return;
    const delta = e.clientY - st.startY;
    if (!st.dragging) {
      if (Math.abs(delta) < 6) return;
      st.dragging = true;
      draggedRef.current = true;
      setIsDragging(true);
      try {
        e.currentTarget.setPointerCapture(st.pointerId);
      } catch {
        /* pointer capture is best-effort */
      }
    }
    setDragY(Math.max(0, delta));
  }, [open]);

  const handleHeadPointerEnd = useCallback(() => {
    const st = dragRef.current;
    dragRef.current = null;
    if (!st?.dragging) return;
    setIsDragging(false);
    setDragY((y) => {
      if (y > 90) onOpenChange(false);
      return 0;
    });
  }, [onOpenChange]);

  const handleHeadClick = useCallback(() => {
    if (draggedRef.current) {
      draggedRef.current = false; // this click was the tail end of a drag, not a tap
      return;
    }
    onOpenChange(!open);
  }, [open, onOpenChange]);

  return (
    <>
      {chip && <div className="g-chip">{chip}</div>}

      {resources.length > 0 && (
        <div className="g-res">
          {resources.map((r, i) => (
            <ResPill key={i} pill={r} />
          ))}
        </div>
      )}

      {!open && hint && <span className="g-hint">{hint}</span>}

      {/* dims the world while the sheet is open; tapping it closes the sheet.
          Sits below the dock (z-60) and sheet (z-58) so the CTA never gets buried. */}
      <div className="g-backdrop" aria-hidden="true" onClick={() => onOpenChange(false)} />

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

      <div
        className={`g-sheet${isDragging ? " dragging" : ""}`}
        role="dialog"
        aria-label={sheetTitle}
        style={isDragging ? { transform: `translate(-50%, ${dragY}px)` } : undefined}
      >
        <div
          className="g-sheet-head relative"
          onClick={handleHeadClick}
          onPointerDown={handleHeadPointerDown}
          onPointerMove={handleHeadPointerMove}
          onPointerUp={handleHeadPointerEnd}
          onPointerCancel={handleHeadPointerEnd}
        >
          <span className="g-sheet-title">{sheetTitle}</span>
          <span className="g-sheet-close">{open ? "▼ close" : "▲ open"}</span>
        </div>
        <div className="g-sheet-body">{children}</div>
      </div>
    </>
  );
}

// resource pill: flashes (scale bump + gold text) whenever its value changes,
// so Sugar swings are legible without staring at the HUD.
function ResPill({ pill }: { pill: ResourcePill }) {
  const prev = useRef(pill.value);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (prev.current === pill.value) return;
    prev.current = pill.value;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 400);
    return () => window.clearTimeout(t);
  }, [pill.value]);

  return (
    <span className="res-pill" data-flash={flash} title={pill.title}>
      <span className="ic">{pill.icon}</span>
      <span className="v">{pill.value}</span>
    </span>
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

// ---- toasts: game events surfacing over the world ("+12 Sugar to Maya") ----

export interface GameToast {
  id: number;
  text: string;
  tone?: "gain" | "loss" | "market" | "info";
}

export function useGameToasts(max = 3) {
  const [toasts, setToasts] = useState<GameToast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, tone: GameToast["tone"] = "info") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-(max - 1)), { id, text, tone }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4600);
  }, [max]);
  return { toasts, push };
}

export function GameToasts({ toasts }: { toasts: GameToast[] }) {
  if (!toasts.length) return null;
  return (
    <div className="g-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="g-toast" data-tone={t.tone || "info"}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

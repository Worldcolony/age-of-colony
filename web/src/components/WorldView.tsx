"use client";
import { useEffect, useState } from "react";
import { worldLink } from "@/three/worldLink";

// Fullscreen 3D toggle: hides the parchment HUD so the living WorldColony map
// takes the whole screen (drag to orbit, pinch to zoom, tap a mound to visit).
export function WorldViewButton({ focusColonyId }: { focusColonyId?: string | null }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.body.classList.toggle("world-view", open);
    worldLink.setInteractive(open);
    if (open && focusColonyId) worldLink.focusColony(focusColonyId);
    return () => {
      document.body.classList.remove("world-view");
      worldLink.setInteractive(false);
    };
  }, [open, focusColonyId]);

  return (
    <>
      <button type="button" className="world-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "⬒ Back to HUD" : "⛰ World"}
      </button>
      {open && (
        <span className="world-hint" aria-hidden>
          drag to orbit · pinch to zoom · tap a mound
        </span>
      )}
    </>
  );
}

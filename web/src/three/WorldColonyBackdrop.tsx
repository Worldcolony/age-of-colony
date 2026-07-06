"use client";

// The real WorldColony Three.js world (terrain, voxel ants, flora, biomes,
// day/night, underground) runs isolated in an iframe as a living backdrop.
// HUD hidden via /world.html; camera auto-orbits on boot. Non-interactive.
export default function WorldColonyBackdrop() {
  return (
    <iframe
      data-world
      title="Living colony world"
      src="/world.html"
      loading="eager"
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100dvh",
        border: 0,
        zIndex: 0,
        pointerEvents: "none",
      }}
    />
  );
}

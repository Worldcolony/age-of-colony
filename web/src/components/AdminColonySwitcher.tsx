"use client";

import { useId } from "react";
import { colonySugar } from "@/lib/sugar";
import type { Colony } from "@/lib/types";

export function AdminColonySwitcher({
  colonies,
  colonyId,
  onSelect,
  compact = false,
  dense = false,
  onManage,
}: {
  colonies: Colony[];
  colonyId?: string | null;
  onSelect: (colonyId: string) => void;
  compact?: boolean;
  dense?: boolean;
  onManage?: () => void;
}) {
  const selectId = useId();
  if (!colonies.length) return null;

  const selectedIndex = Math.max(0, colonies.findIndex((colony) => colony.colonyId === colonyId));
  const selected = colonies[selectedIndex];

  function moveSelection(offset: number) {
    const nextIndex = (selectedIndex + offset + colonies.length) % colonies.length;
    onSelect(colonies[nextIndex].colonyId);
  }

  return (
    <section
      className={`admin-colony-switcher glass relative overflow-hidden ${compact ? "p-3" : "p-4"} ${dense ? "is-dense" : ""}`}
      aria-labelledby={`${selectId}-title`}
    >
      <div className={`grid min-w-0 items-center gap-3 ${compact ? "grid-cols-[auto_1fr]" : "lg:grid-cols-[auto_minmax(190px,0.72fr)_minmax(300px,1.28fr)_auto]"}`}>
        <div className="admin-control-seal" aria-hidden="true">
          <span className="text-xl">👑</span>
          <span>Admin</span>
        </div>

        <div className="min-w-0">
          <p className="eyebrow">Admin control</p>
          <h2 id={`${selectId}-title`} className="text-base font-bold text-ink">Controlled colony</h2>
          <p className="admin-colony-copy mt-1 text-xs leading-relaxed text-ink-faint">
            Orders below affect only the selected colony.
          </p>
        </div>

        <div className={`${compact ? "col-span-2" : ""} grid min-w-0 grid-cols-[44px_minmax(0,1fr)_44px] items-stretch gap-2`}>
          <button
            type="button"
            className="admin-colony-step"
            aria-label="Control previous colony"
            onClick={() => moveSelection(-1)}
          >
            ←
          </button>
          <label className="min-w-0" htmlFor={selectId}>
            <span className="sr-only">Controlled admin colony</span>
            <select
              id={selectId}
              className="admin-colony-select"
              value={selected.colonyId}
              onChange={(event) => onSelect(event.target.value)}
            >
              {colonies.map((colony, index) => (
                <option key={colony.colonyId} value={colony.colonyId}>
                  {`#${index + 1} ${colony.name} · ${colonySugar(colony)} Sugar`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="admin-colony-step"
            aria-label="Control next colony"
            onClick={() => moveSelection(1)}
          >
            →
          </button>
        </div>

        <div className={`${compact ? "col-span-2" : ""} flex items-center justify-between gap-3 lg:grid lg:justify-items-end`}>
          <span className="status-pill !border-green/50 !text-green">
            <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-green" aria-hidden="true" />
            In control
          </span>
          {onManage ? (
            <button
              type="button"
              className="admin-colony-manage-button"
              aria-label={`Manage orders for ${selected.name}`}
              onClick={onManage}
            >
              <span>Manage orders</span>
              <span aria-hidden="true">→</span>
            </button>
          ) : (
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-gold-deep">
              {String(selectedIndex + 1).padStart(2, "0")} / {String(colonies.length).padStart(2, "0")}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

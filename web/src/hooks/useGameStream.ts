// Age of Colony — subscribe to a game's SSE stream (game_event + game_state).
"use client";
import { useEffect, useRef } from "react";
import { sseUrl } from "@/lib/api";
import type { GameEvent, GameState } from "@/lib/types";

interface Handlers {
  onOpen?: () => void;
  onEvent?: (e: GameEvent) => void;
  onState?: (g: GameState) => void;
  onError?: () => void;
}

export function useGameStream(gameId: string | null, handlers: Handlers, enabled = true) {
  const ref = useRef(handlers);

  useEffect(() => {
    ref.current = handlers;
  }, [handlers]);

  useEffect(() => {
    if (!gameId || !enabled) return;
    const es = new EventSource(sseUrl(gameId));
    es.onopen = () => ref.current.onOpen?.();
    es.addEventListener("game_event", (e) => {
      try { ref.current.onEvent?.(JSON.parse((e as MessageEvent).data)); } catch { /* */ }
    });
    es.addEventListener("game_state", (e) => {
      try { ref.current.onState?.(JSON.parse((e as MessageEvent).data)); } catch { /* */ }
    });
    es.onerror = () => ref.current.onError?.();
    return () => es.close();
  }, [gameId, enabled]);
}

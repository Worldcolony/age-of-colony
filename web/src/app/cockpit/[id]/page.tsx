"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { useGameStream } from "@/hooks/useGameStream";
import { findIdentityColony, usePlayerIdentity } from "@/lib/playerIdentity";
import { flag, teamName, fmtScore, kindIcon, isMatchEvent } from "@/lib/format";
import type { GameEvent, Colony, GameState, Opportunity } from "@/lib/types";
import { worldLink } from "@/three/worldLink";
import { GameShell, GameToasts, useGameToasts } from "@/components/GameShell";
import { AdminColonySwitcher } from "@/components/AdminColonySwitcher";
import { ColonyCommandPanel } from "@/components/ColonyCommandPanel";
import { ColonyResourceCard } from "@/components/ColonyResourceCard";
import { ColonyRaceChart } from "@/components/ColonyRaceChart";
import { SmoothMatchClock } from "@/components/SmoothMatchClock";
import { colonySugar, optionRewardSugar, optionRiskSugar } from "@/lib/sugar";
import { discardColonyCommandDrafts } from "@/lib/commandDrafts";

const RUNNING = new Set(["running_replay", "running_live"]);
const PULSE: Record<string, number> = { opportunity: 3, vote: 1.4, ant_agent_vote: 1.4, settlement: 2.4, game_started: 3 };
const MARKET_MEMORY_KINDS = new Set([
  "opportunity",
  "ant_agent_start",
  "ant_agent_vote",
  "vote",
  "prediction",
  "observe",
  "settlement",
  "void",
  "market_closed",
  "markets_closed",
]);
const KIND_EDGE: Record<string, string> = {
  opportunity: "#b07e1c", market_closed: "#b07e1c", markets_closed: "#b07e1c",
  settlement: "#4e7e2a", info_result: "#4e7e2a",
  vote: "#c25a3a", ant_agent_vote: "#c25a3a", prediction: "#c25a3a",
  observe: "#8c7e60",
  game_error: "#c25a3a", void: "#c25a3a",
};

interface PublicVote {
  activeCount?: number;
  neutralCount?: number;
  agentDecisionCount?: number;
  aliveCount?: number;
  engagedCount?: number;
  voteCounts?: Record<string, number>;
  voteLabels?: Record<string, string>;
  predictions?: Record<string, { count?: number; weight?: number } | number>;
}

interface MarketModel {
  id: string;
  label: string;
  minute?: number;
  opportunity?: Opportunity;
  status: "open" | "settled" | "void" | "closed";
  starts: GameEvent[];
  votes: GameEvent[];
  predictions: GameEvent[];
  observations: GameEvent[];
  settlements: GameEvent[];
  voids: GameEvent[];
  closures: GameEvent[];
  lastIndex: number;
}

type CockpitTab = "live" | "settled" | "feed";

// A row in the aggregated event stream — consecutive events of the same kind
// and colony are folded together so the live feed stays legible.
interface FeedRow {
  key: string;
  kind: string;
  colonyId: string | null;
  colonyName: string | null;
  message: string;
  detail: string | null;
  delta: { value: number; unit: string } | null;
  count: number;
  firstIndex: number;
  lastIndex: number;
}

interface ColonyMarketActivity {
  colony?: Colony;
  stake: ReturnType<typeof colonyStake>;
  voteEvent?: GameEvent;
  predictionEvent?: GameEvent;
  observeEvent?: GameEvent;
  settlementEvent?: GameEvent;
  voidEvent?: GameEvent;
  distribution: ReturnType<typeof aggregateVotes>;
  topVote?: ReturnType<typeof aggregateVotes>["rows"][number];
}

interface MarketOutcome {
  label: string;
  detail: string;
  badge: string;
  tone: "green" | "gold" | "rust" | "muted";
}

interface EventSpotlight {
  key: string;
  tone: "goal" | "penalty" | "card" | "substitution" | "market" | "resolved" | "danger";
  glyph: "ball" | "penalty" | "yellow-card" | "red-card" | "substitution" | "market" | "resolved";
  kicker: string;
  title: string;
  detail: string;
  duration: number;
}

export default function CockpitPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Suspense fallback={<div className="grid min-h-[70dvh] place-items-center text-sm font-bold text-ink-faint">Loading cockpit...</div>}>
      <CockpitRun key={id} id={id} />
    </Suspense>
  );
}

function CockpitRun({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const storedGame = useStore((s) => s.game);
  const game = storedGame?.gameId === id ? storedGame : null;
  const setGame = useStore((s) => s.setGame);
  const myColonyId = useStore((s) => s.myColonyId);
  const setMyColonyId = useStore((s) => s.setMyColonyId);
  const mf = useStore((s) => s.matchFixture);
  const identity = usePlayerIdentity();

  const [events, setEvents] = useState<GameEvent[]>([]);
  const [streamState, setStreamState] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<CockpitTab>("live");
  const [sheetOpen, setSheetOpen] = useState(false); // map first — this is the game screen
  const [mobileSheetView, setMobileSheetView] = useState<"board" | "colony">("board");
  const [cockpitLoading, setCockpitLoading] = useState(true);
  const [cockpitError, setCockpitError] = useState("");
  const [selectedMarketId, setSelectedMarketId] = useState<string | null>(null);
  const [selectedSettledId, setSelectedSettledId] = useState<string | null>(null);
  const [watchedColonyId, setWatchedColonyId] = useState<string | null>(null);
  const [mobileAdminCommandDirty, setMobileAdminCommandDirty] = useState(false);
  const [desktopAdminCommandDirty, setDesktopAdminCommandDirty] = useState(false);
  const defaultAdminColonyIdRef = useRef<string | null>(null);
  const seen = useRef<Set<number>>(new Set());
  const snapshotRequestSequence = useRef(0);
  const snapshotReadyRef = useRef(false);
  const pendingStreamEventsRef = useRef<GameEvent[]>([]);
  const { toasts, push } = useGameToasts();
  const mineIdRef = useRef<string | null>(null);
  const liveRef = useRef(false); // suppress fx/toasts while loading history
  // announceEvent runs outside render (called from addEvents) — it needs the
  // latest ranking to announce a winner on game_finished without becoming a
  // dependency of the event pipeline, so it's mirrored into a ref.
  const sortedRef = useRef<Colony[]>([]);
  const [spotlight, setSpotlight] = useState<EventSpotlight | null>(null);
  const spotlightQueueRef = useRef<EventSpotlight[]>([]);
  const spotlightActiveRef = useRef(false);
  const spotlightTimerRef = useRef<number | null>(null);

  function showNextSpotlight() {
    const next = spotlightQueueRef.current.shift();
    if (!next) {
      spotlightActiveRef.current = false;
      setSpotlight(null);
      return;
    }
    spotlightActiveRef.current = true;
    setSpotlight(next);
    spotlightTimerRef.current = window.setTimeout(() => {
      spotlightTimerRef.current = null;
      spotlightActiveRef.current = false;
      setSpotlight(null);
      window.setTimeout(showNextSpotlight, 140);
    }, next.duration);
  }

  function queueSpotlight(next: EventSpotlight) {
    if (spotlightQueueRef.current.some((item) => item.key === next.key) || spotlight?.key === next.key) return;
    spotlightQueueRef.current.push(next);
    if (!spotlightActiveRef.current) showNextSpotlight();
  }

  function addEvent(e: GameEvent) {
    addEvents([e]);
  }

  // The mechanism, made visible: every meaningful engine event lands in the
  // 3D world (combat text over the mound that earned/lost it) and, when it's
  // about YOUR colony, as a toast over the HUD.
  function announceEvent(event: GameEvent) {
    const eventSpotlight = spotlightFromEvent(event);
    if (eventSpotlight) queueSpotlight(eventSpotlight);
    const colonyId = typeof event.data?.colonyId === "string" ? event.data.colonyId : null;
    const isMine = Boolean(colonyId && colonyId === mineIdRef.current);
    if (event.kind === "settlement") {
      const sugar = Number(event.data?.sugar ?? event.data?.resourceDelta ?? event.data?.food ?? 0);
      const win = Boolean(event.data?.win);
      const sugarText = sugar > 0 ? `+${sugar} Sugar` : sugar < 0 ? `${sugar} Sugar` : win ? "correct call" : "missed call";
      worldLink.fx(colonyId, win ? "gain" : "loss", sugarText);
      if (isMine) {
        const label = (event.data?.option as { label?: string } | undefined)?.label ?? "market";
        push(`${win ? "🍬" : "✕"} ${sugarText} — ${label}`, win ? "gain" : "loss");
      }
    } else if (event.kind === "opportunity") {
      const label = (event.data?.opportunity as Opportunity | undefined)?.label ?? event.message ?? "New market";
      worldLink.fx(null, "market", "🎯 market open");
      push(`🎯 ${cleanMarketLabel(String(label))} — ants are voting`, "market");
    } else if (event.kind === "game_finished") {
      push("🏁 Full time! Tap Ranks for the podium", "info");
      const winner = sortedRef.current[0];
      if (winner) {
        worldLink.fx(winner.colonyId, "victory", `🏆 ${winner.name}`);
        worldLink.focusColony(winner.colonyId);
        push(`🏆 ${winner.name} takes the match!`, "gain");
      }
    }
  }

  function addEvents(incoming: GameEvent[], { historical = false }: { historical?: boolean } = {}) {
    const fresh: GameEvent[] = [];
    for (const event of incoming) {
      if (seen.current.has(event.index)) continue;
      seen.current.add(event.index);
      if (PULSE[event.kind]) worldLink.pulse(PULSE[event.kind]);
      if (!historical && liveRef.current) announceEvent(event);
      fresh.push(event);
    }
    if (!fresh.length) {
      if (historical) liveRef.current = true;
      return;
    }
    setEvents((prev) => [...fresh, ...prev]
      .sort((a, b) => b.index - a.index)
      .filter((event, index) => index < 700 || MARKET_MEMORY_KINDS.has(event.kind)));
    // history is loaded — anything after this batch is live and worth announcing
    liveRef.current = true;
  }

  useEffect(() => {
    let cancelled = false;
    let snapshotInterval: number | null = null;
    const resetTimer = window.setTimeout(() => {
      if (cancelled) return;
      setCockpitLoading(true);
      setCockpitError("");
    }, 0);

    async function loadSnapshot() {
      const requestId = ++snapshotRequestSequence.current;
      try {
        const replay = await api.getReplay(id);
        if (cancelled || requestId !== snapshotRequestSequence.current) return;
        setGame(replay.game);
        if (replay.game.status === "created") setSheetOpen(true);
        const ownColony = findIdentityColony(replay.game, identity.snapshot);
        if (ownColony) setMyColonyId(ownColony.colonyId);
        addEvents(replay.events ?? [], { historical: true });
        snapshotReadyRef.current = true;
        const pendingStreamEvents = pendingStreamEventsRef.current.splice(0);
        addEvents(pendingStreamEvents);
        setLastSyncAt(Date.now());
        setCockpitLoading(false);
        setCockpitError("");
      } catch {
        if (cancelled || requestId !== snapshotRequestSequence.current) return;
        try {
          const g = await api.getGame(id);
          if (cancelled || requestId !== snapshotRequestSequence.current) return;
          setGame(g);
          if (g.status === "created") setSheetOpen(true);
          const ownColony = findIdentityColony(g, identity.snapshot);
          if (ownColony) setMyColonyId(ownColony.colonyId);
          snapshotReadyRef.current = true;
          const pendingStreamEvents = pendingStreamEventsRef.current.splice(0);
          addEvents(pendingStreamEvents, { historical: true });
          liveRef.current = true;
          setLastSyncAt(Date.now());
          setCockpitLoading(false);
          setCockpitError("");
        } catch (error) {
          if (cancelled) return;
          setCockpitLoading(false);
          setCockpitError(error instanceof Error ? error.message : "This simulation could not be loaded.");
          if (snapshotInterval !== null) {
            window.clearInterval(snapshotInterval);
            snapshotInterval = null;
          }
        }
      }
    }

    loadSnapshot();
    snapshotInterval = window.setInterval(loadSnapshot, 5000);
    return () => {
      cancelled = true;
      window.clearTimeout(resetTimer);
      if (snapshotInterval !== null) window.clearInterval(snapshotInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => () => {
    if (spotlightTimerRef.current !== null) window.clearTimeout(spotlightTimerRef.current);
    spotlightQueueRef.current = [];
  }, []);

  useGameStream(id, {
    onOpen: () => setStreamState("live"),
    onError: () => setStreamState("reconnecting"),
    onEvent: (e) => {
      setStreamState("live");
      if (!snapshotReadyRef.current) {
        pendingStreamEventsRef.current.push(e);
        return;
      }
      addEvent(e);
    },
    onState: (g) => {
      setStreamState("live");
      snapshotRequestSequence.current += 1;
      setGame(g);
      if (!snapshotReadyRef.current) {
        snapshotReadyRef.current = true;
        const pendingStreamEvents = pendingStreamEventsRef.current.splice(0);
        addEvents(pendingStreamEvents, { historical: true });
      }
      setCockpitLoading(false);
      setCockpitError("");
      if (g.status === "created") setSheetOpen(true);
      setLastSyncAt(Date.now());
    },
  }, !cockpitError);

  const sorted = useMemo(() => [...(game?.colonies ?? [])].sort((a, b) => colonySugar(b) - colonySugar(a)), [game?.colonies]);
  useEffect(() => {
    sortedRef.current = sorted;
  }, [sorted]);
  const ownColony = useMemo(() => findIdentityColony(game, identity.snapshot), [game, identity.snapshot]);
  const adminRoom = game?.roomKind === "admin";
  const adminContext = game ? adminRoom : searchParams.get("from") === "admin";
  const cockpitExitHref = adminContext
    ? "/admin"
    : game
      ? game.roomScope === "private" && game.roomCode
        ? `/room/${game.roomCode}`
        : `/room/${game.gameId}`
      : "/lobby";
  const resultsHref = adminContext ? `/results/${id}?from=admin` : `/results/${id}`;
  if (adminRoom && !defaultAdminColonyIdRef.current && sorted[0]) {
    // Pin the initial choice: ranking changes must never silently switch which
    // colony receives the admin's next command.
    defaultAdminColonyIdRef.current = sorted[0].colonyId;
  }
  const selectedAdminColonyId = watchedColonyId ?? defaultAdminColonyIdRef.current;
  const selectedAdminColony = adminRoom
    ? sorted.find((colony) => colony.colonyId === selectedAdminColonyId) ?? sorted[0]
    : undefined;
  // Admin selection and player ownership are deliberately separate. A player
  // can never use watchedColonyId to replace the colony linked to their wallet.
  const mine = adminRoom ? selectedAdminColony : ownColony;
  const colonyFocusLabel = adminRoom ? "Admin colony" : ownColony ? "Your colony" : "Watched colony";
  const myIdx = mine ? sorted.findIndex((c) => c.colonyId === mine.colonyId) : -1;
  const rank = myIdx >= 0 ? myIdx + 1 : 0;
  const p1 = teamName(game?.participant1 ?? mf?.participant1);
  const p2 = teamName(game?.participant2 ?? mf?.participant2);
  const status = game?.status ?? "";
  const txlineProof = game?.txlineValidation;
  const txlineWaiting = isTxlineWaiting(game);
  const txlineStateLabel = matchStateLabel(game);
  const markets = useMemo(() => buildMarkets(game?.activeOpportunities ?? [], events), [game?.activeOpportunities, events]);
  const openMarkets = markets.filter((market) => market.status === "open");
  const settledMarkets = markets.filter((market) => market.status !== "open" && (
    market.settlements.length
    || market.voids.length
    || market.observations.length
    || market.closures.length
  ));
  const selectedMarket = openMarkets.find((market) => market.id === selectedMarketId) ?? openMarkets[0];
  const selectedSettled = settledMarkets.find((market) => market.id === selectedSettledId) ?? settledMarkets[0];
  const effectiveSelectedMarketId = selectedMarket?.id ?? null;
  const effectiveSelectedSettledId = selectedSettled?.id ?? null;
  const openSummary = useMemo(() => summarizeOpenMarkets(openMarkets), [openMarkets]);
  const usefulEvents = events.filter((e) => isUsefulLiveEvent(e));
  const colonyNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const colony of game?.colonies ?? []) map[colony.colonyId] = colony.name;
    return map;
  }, [game?.colonies]);
  const aggregatedFeed = useMemo(() => aggregateFeed(usefulEvents, colonyNames), [usefulEvents, colonyNames]);
  const feedRows = aggregatedFeed.slice(0, activeTab === "feed" ? 18 : 5);

  useEffect(() => {
    const nextColonyId = ownColony?.colonyId ?? null;
    if (myColonyId !== nextColonyId) {
      setMyColonyId(nextColonyId);
    }
  }, [myColonyId, ownColony?.colonyId, setMyColonyId]);

  // Keep the 3D world's mounds in lockstep with the live game — founds any
  // colony that isn't in the world yet and feeds it live Sugar/rank data.
  useEffect(() => {
    if (game?.colonies?.length) worldLink.syncColonies(game.colonies, mine?.colonyId ?? null);
  }, [game?.colonies, mine?.colonyId]);

  useEffect(() => {
    mineIdRef.current = mine?.colonyId ?? null;
  }, [mine?.colonyId]);

  // Arrival shot: fly the camera to your mound once, so you always know
  // where "you" are on the map before the markets start moving.
  const introFlown = useRef(false);
  useEffect(() => {
    if (introFlown.current || !mine?.colonyId) return;
    introFlown.current = true;
    const t = window.setTimeout(() => worldLink.focusColony(mine.colonyId), 900);
    return () => window.clearTimeout(t);
  }, [mine?.colonyId]);

  if (!game || lastSyncAt === null) {
    return (
      <CockpitLoadState
        loading={cockpitLoading || !cockpitError}
        error={cockpitError}
        backLabel={adminContext ? "Back to admin" : "Back to lobby"}
        onBack={() => router.push(cockpitExitHref)}
        onRetry={() => window.location.reload()}
      />
    );
  }

  function selectAdminColony(colonyId: string): boolean {
    if (!adminRoom || !game.colonies.some((colony) => colony.colonyId === colonyId)) return false;
    if (colonyId === mine?.colonyId) {
      worldLink.focusColony(colonyId);
      return true;
    }
    if ((mobileAdminCommandDirty || desktopAdminCommandDirty)
      && !window.confirm("Discard unsaved colony orders and control another colony?")) return false;
    if (mine?.colonyId) discardColonyCommandDrafts(id, mine.colonyId);
    setMobileAdminCommandDirty(false);
    setDesktopAdminCommandDirty(false);
    setWatchedColonyId(colonyId);
    worldLink.focusColony(colonyId);
    return true;
  }

  const colonyRail = sorted.length > 0 && (
    <div className="colony-rail" aria-label="Colonies on the map">
      {sorted.map((colony, index) => (
        <button
          key={colony.colonyId}
          type="button"
          data-mine={colony.colonyId === mine?.colonyId}
          onClick={() => {
            if (adminRoom) {
              if (!selectAdminColony(colony.colonyId)) return;
            } else {
              worldLink.focusColony(colony.colonyId);
            }
            setSheetOpen(false); // drop the sheet so you see the flight
          }}
        >
          <span className="rk">#{index + 1}</span>
          <span className="truncate">{colony.name}</span>
          <span className="text-xs text-ink-faint">🍬{colonySugar(colony)}</span>
        </button>
      ))}
    </div>
  );

  const mobileTabs = (
    <>
      <CockpitTabs
        active={activeTab}
        counts={{ live: openMarkets.length, settled: settledMarkets.length, feed: usefulEvents.length }}
        onChange={setActiveTab}
      />
      {activeTab === "live" && (
        <LiveTab
          openMarkets={openMarkets}
          openSummary={openSummary}
          selectedMarket={selectedMarket}
          selectedMarketId={effectiveSelectedMarketId}
          settledMarkets={settledMarkets}
          colony={mine}
          colonyLabel={colonyFocusLabel}
          waitingForKickoff={txlineWaiting}
          matchStateLabel={txlineStateLabel}
          onSelectMarket={setSelectedMarketId}
          onSelectSettled={(marketId) => {
            setSelectedSettledId(marketId);
            setActiveTab("settled");
          }}
        />
      )}
      {activeTab === "settled" && (
        <SettledTab
          settledMarkets={settledMarkets}
          selectedSettled={selectedSettled}
          selectedSettledId={effectiveSelectedSettledId}
          colony={mine}
          colonyLabel={colonyFocusLabel}
          onSelectSettled={setSelectedSettledId}
        />
      )}
      {activeTab === "feed" && <FeedTab feedRows={feedRows} onOpenRanks={() => router.push(resultsHref)} />}
    </>
  );

  const mobileShell = (
    <div className="xl:hidden">
      <GameShell
        chip={
          <>
            <span className="emblem">{flag(p1)}</span>
            <span className="mobile-match-chip min-w-0">
              <span className="mobile-match-chip-teams block truncate">{p1} {fmtScore(game?.match?.score)} {p2}</span>
              <span className="mobile-match-chip-row">
                <SmoothMatchClock
                  match={game?.match}
                  status={status}
                  mode={game?.mode}
                  replayTimeScale={game?.replayTimeScale}
                  showLiveDot
                />
                <span className="mobile-match-chip-state truncate">
                  {streamState === "reconnecting" ? "reconnecting" : game?.match?.possessionLabel || txlineStateLabel}
                </span>
              </span>
            </span>
          </>
        }
        resources={[
          { icon: "🏆", value: rank ? `#${rank}` : "—", title: "Rank" },
          { icon: "🐜", value: mine?.size ?? 20, title: "Fixed ant voters" },
          { icon: "🍬", value: mine ? colonySugar(mine) : "—", title: "Sugar" },
        ]}
        nav={[
          { icon: adminRoom ? "👑" : "🏟️", label: adminRoom ? "Admin" : "Room", onClick: () => router.push(cockpitExitHref) },
          { icon: "🏆", label: "Ranks", onClick: () => router.push(resultsHref) },
          {
            icon: adminRoom ? "👑" : "🍬",
            label: adminRoom ? "Control" : "Colony",
            active: sheetOpen && mobileSheetView === "colony",
            disabled: !mine || (!ownColony && !adminRoom),
            onClick: () => {
              setMobileSheetView("colony");
              setSheetOpen(true);
            },
          },
        ]}
        cta={
          <button
            type="button"
            className={`g-cta ${openMarkets.length ? "rust" : ""}`}
            onClick={() => {
              if (mobileSheetView === "colony") {
                setMobileSheetView("board");
                setSheetOpen(true);
                return;
              }
              setSheetOpen((value) => !value);
            }}
          >
            {mobileSheetView === "colony"
              ? openMarkets.length ? `🎯 Markets · ${openMarkets.length}` : "📊 Decision board"
              : sheetOpen ? "⛰️ View the map" : openMarkets.length ? `🎯 Markets · ${openMarkets.length} live` : "📊 Decision board"}
          </button>
        }
        sheetTitle={mobileSheetView === "colony" ? (adminRoom ? "Admin colony control" : "Your colony") : "Decision board"}
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open);
          if (!open) setMobileSheetView("board");
        }}
        hint={selectedMarket ? undefined : RUNNING.has(status) ? "colony rings flash as your ants vote" : "drag to orbit · tap a mound"}
      >
        {mobileSheetView === "colony" && mine && (ownColony || adminRoom) ? (
          <div className="grid min-w-0 gap-3">
            {adminRoom && (
              <AdminColonySwitcher
                compact
                colonies={sorted}
                colonyId={mine.colonyId}
                onSelect={selectAdminColony}
              />
            )}
            <ColonyCommandPanel
              gameId={id}
              status={status}
              colony={mine}
              anonymousId={identity.anonymousId}
              controlMode={adminRoom ? "admin" : "player"}
              compactLayout
              initialScope={adminRoom ? "colony" : "ants"}
              expandedByDefault
              onDirtyChange={adminRoom ? setMobileAdminCommandDirty : undefined}
              onGameChange={setGame}
            />
            <ColonyResourceCard colony={mine} rank={rank} spectator={adminRoom} />
          </div>
        ) : status === "created" ? (
          <div className="flex flex-col gap-3 text-center">
            <p className="text-lg font-bold">{adminRoom ? "Simulation is not live yet" : "Room is not live yet"}</p>
            <p className="text-sm text-ink-soft">
              {adminRoom ? "Return to admin setup to launch this simulation." : "Start the match from the room once every player has a colony."}
            </p>
            <button className="btn btn-primary" onClick={() => router.push(cockpitExitHref)}>
              {adminRoom ? "Back to admin" : "Back to room"}
            </button>
          </div>
        ) : (
          <>
            <p className="loop-strip">🐜 ants vote → 🤝 consensus enters → 🍬 results change Sugar → 🏆 most Sugar wins</p>
            {colonyRail}
            {mobileTabs}
          </>
        )}
      </GameShell>
      {!sheetOpen && selectedMarket && (
        <button type="button" className="market-banner" onClick={() => {
          setMobileSheetView("board");
          setSheetOpen(true);
        }}>
          <span className="live-dot" />
          <span className="min-w-0 flex-1 truncate text-left">{cleanMarketLabel(selectedMarket.label)}</span>
          <span className="shrink-0 font-mono text-[10px] uppercase text-gold-deep">vote →</span>
        </button>
      )}
      <GameToasts toasts={toasts} />
    </div>
  );

  return (
    <>
    {mobileShell}
    <div className="flex min-h-[calc(100dvh-36px)] w-full flex-col gap-4 pb-6 max-xl:hidden xl:relative xl:left-1/2 xl:w-[min(1500px,calc(100vw-32px))] xl:-translate-x-1/2">
      <header className="page-top xl:grid xl:grid-cols-[auto_1fr_auto]">
        <button className="icon-btn" aria-label={adminRoom ? "Back to admin" : "Back"} onClick={() => router.push(cockpitExitHref)}>←</button>
        <div className="text-center">
          <h1 className="hud-title text-[13px]">Live cockpit</h1>
          <p className="text-xs text-ink-faint">{lastSyncAt ? `Synced ${formatClock(lastSyncAt)}` : "Syncing..."}</p>
        </div>
        <span className={`status-pill ${RUNNING.has(status) ? "!border-rust/50 !text-rust" : ""}`} aria-live="polite">
          {RUNNING.has(status) && <span className="live-dot" />}
          {streamState === "reconnecting" ? "reconnect" : status === "created" ? "not started" : status.replace("_", " ") || "live"}
        </span>
      </header>

      {adminRoom && mine && (
        <AdminColonySwitcher
          colonies={sorted}
          colonyId={mine.colonyId}
          onSelect={selectAdminColony}
        />
      )}

      <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(320px,0.82fr)_minmax(520px,1.2fr)_minmax(360px,0.95fr)] 2xl:grid-cols-[360px_minmax(580px,1fr)_430px]">
        <aside className="grid min-w-0 content-start gap-4">
          <section className="glass match-card-media flex min-w-0 flex-col gap-3 p-4">
            {txlineProof && (
              <div
                className={`flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2 ${
                  txlineProof.verified
                    ? "border-lime/40 bg-lime/10"
                    : txlineProof.status === "pending"
                      ? "border-gold/40 bg-gold/10"
                      : "border-red-500/40 bg-red-500/10"
                }`}
                title={txlineProof.dailyScoresPda || txlineProof.reason || undefined}
              >
                <span className={`text-xs font-bold ${
                  txlineProof.verified
                    ? "text-lime"
                    : txlineProof.status === "pending" ? "text-gold-deep" : "text-red-700"
                }`}>
                  {txlineProof.verified
                    ? "✓ TxLINE final score verified"
                    : txlineProof.status === "pending"
                      ? "⏳ TxLINE proof pending"
                      : "⚠ TxLINE verification unavailable"}
                </span>
                <span className="truncate font-mono text-[9px] uppercase tracking-wide text-ink-faint">
                  {txlineProof.verified ? `seq ${txlineProof.seq ?? "—"} · ${txlineProof.network}` : txlineProof.network}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <span className="plate grid h-10 w-12 place-items-center text-xl">{flag(p1)}</span>
              <div className="min-w-0 flex-1 text-center">
                <p className="truncate text-sm font-bold text-ink-soft">{p1} vs {p2}</p>
                <p className="font-mono text-4xl font-bold text-gold">{fmtScore(game?.match?.score)}</p>
                <div className="match-clock-panel">
                  <SmoothMatchClock
                    match={game?.match}
                    status={status}
                    mode={game?.mode}
                    replayTimeScale={game?.replayTimeScale}
                    showLiveDot
                  />
                  <p className="truncate">{game?.match?.possessionLabel || txlineStateLabel}</p>
                </div>
              </div>
              <span className="plate grid h-10 w-12 place-items-center text-xl">{flag(p2)}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <PulseMetric label="Open" value={openMarkets.length} tone="gold" />
              <PulseMetric label="Settled" value={settledMarkets.length} tone="green" />
              <PulseMetric label="Events" value={game?.eventIndex ?? events[0]?.index ?? 0} />
            </div>
          </section>

          <ColonyResourceCard colony={mine} rank={rank} spectator={adminRoom} />
          <RunStatusCard gameId={id} status={status} streamState={streamState} lastSyncAt={lastSyncAt} />
        </aside>

        <main className="grid min-w-0 content-start gap-4">
          {status === "created" ? (
            <section className="glass flex min-w-0 flex-col gap-3 p-5 text-center xl:min-h-[360px] xl:justify-center">
              <p className="eyebrow">Simulation dashboard</p>
              <h2 className="text-2xl font-bold">{adminRoom ? "Simulation is not live yet" : "Room is not live yet"}</h2>
              <p className="mx-auto max-w-md text-sm text-ink-soft">
                {adminRoom ? "Return to admin setup to launch this simulation." : "Start the match from the room once every player has a colony."}
              </p>
              <button className="btn btn-primary mx-auto !w-auto px-8" onClick={() => router.push(cockpitExitHref)}>
                {adminRoom ? "Back to admin" : "Back to room"}
              </button>
            </section>
          ) : (
            <section className="glass flex min-h-[420px] min-w-0 flex-col gap-3 p-4 xl:min-h-[calc(100dvh-132px)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="eyebrow">Simulation dashboard</p>
                  <h2 className="text-2xl font-bold">Decision board</h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className="status-pill">{openMarkets.length} live</span>
                  <span className="status-pill !border-green/50 !text-green">{settledMarkets.length} settled</span>
                </div>
              </div>

              <CockpitTabs
                active={activeTab}
                counts={{ live: openMarkets.length, settled: settledMarkets.length, feed: usefulEvents.length }}
                onChange={setActiveTab}
              />

              {activeTab === "live" && (
                <LiveTab
                  openMarkets={openMarkets}
                  openSummary={openSummary}
                  selectedMarket={selectedMarket}
                  selectedMarketId={effectiveSelectedMarketId}
                  settledMarkets={settledMarkets}
                  colony={mine}
                  colonyLabel={colonyFocusLabel}
                  waitingForKickoff={txlineWaiting}
                  matchStateLabel={txlineStateLabel}
                  onSelectMarket={setSelectedMarketId}
                  onSelectSettled={(marketId) => {
                    setSelectedSettledId(marketId);
                    setActiveTab("settled");
                  }}
                />
              )}

              {activeTab === "settled" && (
                <SettledTab
                  settledMarkets={settledMarkets}
                  selectedSettled={selectedSettled}
                  selectedSettledId={effectiveSelectedSettledId}
                  colony={mine}
                  colonyLabel={colonyFocusLabel}
                  onSelectSettled={setSelectedSettledId}
                />
              )}

              {activeTab === "feed" && (
                <FeedTab feedRows={feedRows} onOpenRanks={() => router.push(resultsHref)} />
              )}

            </section>
          )}
        </main>

        <aside className="grid min-w-0 content-start gap-4">
          {mine && (ownColony || adminRoom) && (
            <ColonyCommandPanel
              gameId={id}
              status={status}
              colony={mine}
              anonymousId={identity.anonymousId}
              controlMode={adminRoom ? "admin" : "player"}
              compactLayout
              onDirtyChange={adminRoom ? setDesktopAdminCommandDirty : undefined}
              onGameChange={setGame}
              initialScope={adminRoom ? "colony" : "ants"}
            />
          )}
          <ColonyRoster
            colonies={sorted}
            events={events}
            activeColonyId={mine?.colonyId}
            onOpenRanks={() => router.push(resultsHref)}
            onSelectColony={adminRoom ? selectAdminColony : undefined}
          />
          <EventStreamCard feedRows={aggregatedFeed.slice(0, 7)} onOpenFeed={() => setActiveTab("feed")} />
        </aside>
      </div>

      <footer className="flex items-center justify-between px-1 pb-2 text-xs font-bold text-ink-faint">
        <span>
          {status === "finished"
            ? "Match finished"
            : status === "stopped" || status === "error"
              ? "Match interrupted"
              : streamState === "reconnecting" ? "Reconnecting stream..." : "Watching live"}
        </span>
        <button className="quiet-link" onClick={() => router.push(resultsHref)}>
          {status === "finished" ? "View final results" : "Ranks"}
        </button>
      </footer>
    </div>

    {spotlight && <MatchEventSpotlight spotlight={spotlight} />}

    </>
  );
}

function RunStatusCard({
  gameId,
  status,
  streamState,
  lastSyncAt,
}: {
  gameId: string;
  status: string;
  streamState: "connecting" | "live" | "reconnecting";
  lastSyncAt: number | null;
}) {
  const runLabel = status ? status.replace(/_/g, " ") : "live";
  const streamLabel = streamState === "reconnecting" ? "reconnect" : streamState;
  const shortId = gameId.length > 8 ? `${gameId.slice(0, 4)}...${gameId.slice(-4)}` : gameId;
  return (
    <section className="glass flex min-w-0 flex-col gap-3 p-3">
      <div>
        <p className="eyebrow">Run state</p>
        <h2 className="text-base font-bold">Replay control</h2>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <MiniStat label="Mode" value={runLabel} tone={RUNNING.has(status) ? "gold" : undefined} />
        <MiniStat label="Stream" value={streamLabel} tone={streamState === "live" ? "green" : undefined} />
        <MiniStat label="Game" value={shortId} />
        <MiniStat label="Sync" value={lastSyncAt ? formatClock(lastSyncAt) : "..."} />
      </div>
    </section>
  );
}

function EventStreamCard({ feedRows, onOpenFeed }: { feedRows: FeedRow[]; onOpenFeed: () => void }) {
  return (
    <section className="glass flex min-w-0 flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="eyebrow">Signals</p>
          <h2 className="text-base font-bold">Event stream</h2>
        </div>
        <button className="quiet-link text-sm" onClick={onOpenFeed}>Open feed</button>
      </div>

      <div className="well grid max-h-[300px] gap-0 overflow-y-auto px-3">
        {feedRows.length === 0 ? (
          <span className="block py-5 text-center text-sm text-ink-faint">Waiting for live signals...</span>
        ) : (
          feedRows.map((row) => <FeedRowLine key={row.key} row={row} />)
        )}
      </div>
    </section>
  );
}

// A single aggregated feed row: color edge by kind, bold colony name, a
// colored delta (green gain / rust loss), muted context, and a ×N badge when
// several consecutive same-kind-same-colony events were folded into one line.
function FeedRowLine({ row }: { row: FeedRow }) {
  return (
    <div className="grid grid-cols-[4px_1fr_auto] gap-3 border-b border-[color:var(--brd-soft)] py-2 last:border-b-0">
      <span className="rounded-full" style={{ background: KIND_EDGE[row.kind] ?? "rgba(74,58,30,0.25)" }} />
      <span className="min-w-0 text-sm leading-snug text-ink-soft">
        <span className="mr-1">{kindIcon(row.kind)}</span>
        {row.colonyName && (row.delta || row.detail) ? (
          <>
            <b className="text-ink">{row.colonyName}</b>{" "}
            {row.delta && (
              <span className={`font-mono font-bold ${row.delta.value < 0 ? "text-rust" : "text-green"}`}>
                {signedValue(row.delta.value)} {row.delta.unit}
              </span>
            )}
            {row.detail && <span className="text-ink-faint"> — {row.detail}</span>}
          </>
        ) : (
          <span>{row.message}</span>
        )}
        {row.count > 1 && <span className="ml-1 text-ink-faint">×{row.count}</span>}
      </span>
      <span className="font-mono text-[10px] text-ink-faint">#{row.lastIndex}</span>
    </div>
  );
}

function CockpitTabs({
  active,
  counts,
  onChange,
}: {
  active: CockpitTab;
  counts: Record<CockpitTab, number>;
  onChange: (tab: CockpitTab) => void;
}) {
  const tabs: { id: CockpitTab; label: string }[] = [
    { id: "live", label: "Live" },
    { id: "settled", label: "Settled" },
    { id: "feed", label: "Feed" },
  ];
  return (
    <div className="seg sticky top-2 z-20 bg-[rgba(228,218,193,0.95)] backdrop-blur-md" role="tablist" aria-label="Cockpit views">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          data-active={active === tab.id}
          onClick={() => onChange(tab.id)}
          className="!flex items-center justify-center gap-2"
        >
          <span>{tab.label}</span>
          <span className="font-mono text-[10px] opacity-75">{counts[tab.id]}</span>
        </button>
      ))}
    </div>
  );
}

function LiveTab({
  openMarkets,
  openSummary,
  selectedMarket,
  selectedMarketId,
  settledMarkets,
  colony,
  colonyLabel,
  waitingForKickoff,
  matchStateLabel,
  onSelectMarket,
  onSelectSettled,
}: {
  openMarkets: MarketModel[];
  openSummary: ReturnType<typeof summarizeOpenMarkets>;
  selectedMarket?: MarketModel;
  selectedMarketId: string | null;
  settledMarkets: MarketModel[];
  colony?: Colony;
  colonyLabel: string;
  waitingForKickoff: boolean;
  matchStateLabel: string;
  onSelectMarket: (marketId: string) => void;
  onSelectSettled: (marketId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <CompactStat label="Live markets" value={openSummary.markets} tone="gold" />
        <CompactStat label="Answers" value={openSummary.answers} tone="cyan" />
        <CompactStat label="Abstain" value={openSummary.abstain} />
      </div>

      {openMarkets.length ? (
        <>
          <MarketRail markets={openMarkets} selectedId={selectedMarketId} onSelect={onSelectMarket} />
          {selectedMarket && (
            <FocusedMarketPanel
              market={selectedMarket}
              colony={colony}
              colonyLabel={colonyLabel}
            />
          )}
        </>
      ) : (
        <EmptyState
          title={waitingForKickoff ? "Waiting for kickoff" : "Next market wave loading"}
          body={waitingForKickoff ? `TXLine reports ${matchStateLabel}. Markets open once the match is live.` : "Markets rotate automatically on the five-minute match cadence. Stay here — the next window will open by itself."}
        />
      )}

      {settledMarkets.length > 0 && (
        <div className="well p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold">Latest settled</p>
              <p className="text-xs text-ink-faint">Tap one to inspect.</p>
            </div>
            <span className="status-pill">{settledMarkets.length}</span>
          </div>
          <SettledRail
            markets={settledMarkets.slice(0, 8)}
            selectedId={null}
            onSelect={onSelectSettled}
            compact
          />
        </div>
      )}
    </div>
  );
}

function SettledTab({
  settledMarkets,
  selectedSettled,
  selectedSettledId,
  colony,
  colonyLabel,
  onSelectSettled,
}: {
  settledMarkets: MarketModel[];
  selectedSettled?: MarketModel;
  selectedSettledId: string | null;
  colony?: Colony;
  colonyLabel: string;
  onSelectSettled: (marketId: string) => void;
}) {
  if (!settledMarkets.length) {
    return <EmptyState title="No settled market yet" body="Results will appear here as markets expire or resolve." />;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Settled markets</h2>
          <p className="text-xs text-ink-faint">Select a result instead of scrolling the journal.</p>
        </div>
        <span className="status-pill">{settledMarkets.length}</span>
      </div>
      <SettledRail markets={settledMarkets} selectedId={selectedSettledId} onSelect={onSelectSettled} />
      {selectedSettled && <SettledDetailPanel market={selectedSettled} colony={colony} colonyLabel={colonyLabel} />}
    </div>
  );
}

function FeedTab({ feedRows, onOpenRanks }: { feedRows: FeedRow[]; onOpenRanks: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Feed</h2>
          <p className="text-xs text-ink-faint">Match signals and engine events.</p>
        </div>
        <button className="quiet-link text-sm" onClick={onOpenRanks}>Ranks</button>
      </div>
      <div className="well max-h-[52dvh] overflow-y-auto px-3">
        {feedRows.length === 0 ? (
          <span className="block py-5 text-center text-sm text-ink-faint">Waiting for live signals...</span>
        ) : (
          feedRows.map((row) => <FeedRowLine key={row.key} row={row} />)
        )}
      </div>
    </div>
  );
}

function isTxlineWaiting(game?: GameState | null) {
  const state = normalizeMatchState(game?.match?.gameState);
  const statusId = Number(game?.match?.statusId);
  return state === "scheduled" || state === "pre_match" || state === "prematch" || statusId === 1;
}

function matchStateLabel(game?: GameState | null) {
  const state = game?.match?.gameState;
  if (state !== undefined && state !== null && String(state).trim()) {
    return String(state).replace(/_/g, " ");
  }
  const statusId = game?.match?.statusId;
  if (statusId !== undefined && statusId !== null) return `TXLine status ${statusId}`;
  return "TXLine live";
}

function normalizeMatchState(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function CompactStat({ label, value, tone }: { label: string; value: number | string; tone?: "gold" | "cyan" }) {
  const color = tone === "gold" ? "text-gold" : tone === "cyan" ? "text-cyan" : "text-ink";
  return (
    <div className="plate px-2 py-2 text-center">
      <p className="truncate text-[10px] font-bold text-ink-faint">{label}</p>
      <p className={`font-mono text-lg font-bold ${color}`}>{value}</p>
    </div>
  );
}

function MarketRail({
  markets,
  selectedId,
  onSelect,
}: {
  markets: MarketModel[];
  selectedId: string | null;
  onSelect: (marketId: string) => void;
}) {
  return (
    <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="Active markets">
      {markets.map((market) => {
        const distribution = aggregateVotes(market.votes);
        const selected = selectedId === market.id;
        return (
          <button
            key={market.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(market.id)}
            className={`min-w-[124px] rounded-md border-2 p-3 text-left transition ${
              selected
                ? "border-[color:var(--color-gold)] bg-[rgba(249,243,226,0.96)] text-ink shadow-[2px_2px_0_rgba(90,70,30,0.4)]"
                : "border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.7)] text-ink-soft"
            }`}
          >
            <span className="block truncate font-mono text-[10px] uppercase text-gold-deep">{compactMarketName(market)}</span>
            <span className="mt-1 block truncate text-xs font-bold">{cleanMarketLabel(market.label)}</span>
            <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-[rgba(74,58,30,0.18)]">
              {distribution.rows.length ? distribution.rows.map((row) => (
                <span
                  key={row.key}
                  className="inline-block h-full"
                  style={{ width: `${Math.max(4, Math.round((row.count / Math.max(1, distribution.total)) * 100))}%`, background: row.color }}
                />
              )) : <span className="block h-full w-1/3 bg-gold/50" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SettledRail({
  markets,
  selectedId,
  onSelect,
  compact = false,
}: {
  markets: MarketModel[];
  selectedId: string | null;
  onSelect: (marketId: string) => void;
  compact?: boolean;
}) {
  return (
    <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="Settled markets">
      {markets.map((market) => {
        const summary = settlementSummary(market);
        const outcome = marketOutcomeSummary(market);
        const selected = selectedId === market.id;
        return (
          <button
            key={market.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(market.id)}
            className={`min-w-[132px] rounded-md border-2 p-3 text-left transition ${
              selected
                ? "border-[color:var(--color-gold)] bg-[rgba(249,243,226,0.96)] text-ink shadow-[2px_2px_0_rgba(90,70,30,0.4)]"
                : "border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.7)] text-ink-soft"
            }`}
          >
            <span className="block font-mono text-[10px] uppercase text-gold-deep">{compactMarketName(market)}</span>
            <span className="mt-1 block truncate text-xs font-bold">{cleanMarketLabel(market.label)}</span>
            {!compact && (
              <span className="mt-1 block truncate text-[11px] font-bold text-green">
                Outcome: {outcome.label}
              </span>
            )}
            {!compact && (
              <span className="mt-2 grid grid-cols-3 gap-1 text-center font-mono text-[10px]">
                <b className={`rounded bg-[rgba(74,58,30,0.1)] px-1 py-1 ${summary.resourceDelta < 0 ? "text-rust" : "text-green"}`}>
                  {signedValue(summary.resourceDelta)} 🍬
                </b>
                <b className="rounded bg-[rgba(74,58,30,0.1)] px-1 py-1 text-rust">{summary.losses}</b>
                <b className="rounded bg-[rgba(74,58,30,0.1)] px-1 py-1 text-ink">{summary.voided}</b>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function FocusedMarketPanel({
  market,
  colony,
  colonyLabel,
}: {
  market: MarketModel;
  colony?: Colony;
  colonyLabel: string;
}) {
  const distribution = aggregateVotes(market.votes);
  const activity = colonyMarketActivity(market, colony);
  const pending = pendingAntCount(market, distribution.total);
  return (
    <article className="rounded-md border-2 border-[color:var(--color-gold)] bg-[rgba(249,243,226,0.95)] p-3 shadow-[3px_3px_0_rgba(74,58,30,0.25)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Selected market</p>
          <h2 className="text-base font-bold leading-snug">{cleanMarketLabel(market.label)}</h2>
          <p className="mt-1 text-xs text-ink-faint">Aggregated across all colonies.</p>
          <p className="mt-1 font-mono text-[10px] uppercase text-gold-deep">{marketLabelPrefix(market)}</p>
        </div>
        <span className="rounded-full border-2 border-[color:var(--color-green)] px-2 py-1 font-mono text-[10px] uppercase text-green">open</span>
      </div>

      <ColonyDecisionPanel activity={activity} title={colonyLabel} mode="open" />

      <OptionPreview opportunity={market.opportunity} />
      {distribution.rows.length > 0 && <Distribution distribution={distribution} title="All colonies vote split" />}

      <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold text-ink-faint">
        <span className="rounded-full bg-[rgba(176,126,28,0.14)] px-2 py-1 text-gold-deep">
          {distribution.total ? `${distribution.total} total ant votes` : "Waiting for ants"}
        </span>
        <span className="rounded-full bg-[rgba(74,58,30,0.1)] px-2 py-1">
          {market.votes.length}/{Math.max(1, market.starts.length || market.votes.length)} colonies reported
        </span>
        {pending > 0 && <span className="rounded-full bg-[rgba(74,58,30,0.1)] px-2 py-1">{pending} calls pending</span>}
      </div>

    </article>
  );
}

// Derives the fixed position created when colony consensus clears its gate.
function colonyStake(market: MarketModel, colonyId?: string): { ants: number; antIds: string[]; optionId?: string; optionLabel: string } | null {
  if (!colonyId) return null;
  const predictionEvent = latestColonyEvent(market.predictions, colonyId);
  if (!predictionEvent) return null;
  const predictionData = eventData(predictionEvent);
  const fallbackAnts = Number(predictionData?.ants ?? 0);
  const initialAntIds = predictionEvent.data?.antIds;
  const antIds = Array.isArray(initialAntIds) ? initialAntIds.map(String) : [];
  const ants = antIds.length || fallbackAnts;
  const predictionOption = eventData(predictionEvent)?.option;
  const predictionOptionId = (predictionOption?.optionId ?? (predictionOption as { option_id?: string } | undefined)?.option_id) as string | undefined;
  return { ants, antIds, optionId: predictionOptionId, optionLabel: predictionOption?.label || predictionOptionId || "unknown" };
}

function SettledDetailPanel({ market, colony, colonyLabel }: { market: MarketModel; colony?: Colony; colonyLabel: string }) {
  const summary = settlementSummary(market);
  const distribution = aggregateVotes(market.votes);
  const activity = colonyMarketActivity(market, colony);
  const outcome = marketOutcomeSummary(market);
  return (
    <article className="rounded-md border-2 border-[color:var(--color-gold)] bg-[rgba(249,243,226,0.96)] p-3 shadow-[4px_4px_0_rgba(74,58,30,0.28)]">
      <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gold/40" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Settled market</p>
          <h2 className="text-base font-bold leading-snug">{cleanMarketLabel(market.label)}</h2>
          <p className="mt-1 font-mono text-[10px] uppercase text-ink-faint">{marketLabelPrefix(market)}</p>
        </div>
        <span className={`rounded-full border-2 px-2 py-1 font-mono text-[10px] uppercase ${summary.tone}`}>
          {summary.label}
        </span>
      </div>

      <MarketOutcomePanel outcome={outcome} />

      <ColonyDecisionPanel activity={activity} title={colonyLabel} mode="settled" />

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <PulseMetric
          label="All colonies Sugar"
          value={signedValue(summary.resourceDelta)}
          tone={summary.resourceDelta >= 0 ? "green" : undefined}
        />
        <PulseMetric label="Losses" value={summary.losses} />
        <PulseMetric label="Void" value={summary.voided} />
      </div>

      {distribution.rows.length > 0 && <Distribution distribution={distribution} title="All colonies vote split" />}

      <div className="mt-3 flex flex-col gap-1">
        {[...personalResultEvents(activity), ...market.settlements, ...market.voids, ...market.closures]
          .filter(uniqueEventByIndex)
          .slice(0, 4)
          .map((event) => (
          <p key={event.index} className="text-xs leading-snug text-ink-soft">{compactEventMessage(event)}</p>
        ))}
      </div>
    </article>
  );
}

function MarketOutcomePanel({ outcome }: { outcome: MarketOutcome }) {
  const tone = outcome.tone === "green"
    ? "border-[color:rgba(78,126,42,0.5)] bg-[rgba(78,126,42,0.1)] text-green"
    : outcome.tone === "rust"
      ? "border-[color:rgba(194,90,58,0.5)] bg-[rgba(194,90,58,0.08)] text-rust"
      : outcome.tone === "gold"
        ? "border-[color:rgba(176,126,28,0.5)] bg-[rgba(176,126,28,0.1)] text-gold-deep"
        : "border-[color:var(--brd-soft)] bg-[rgba(74,58,30,0.06)] text-ink-faint";
  return (
    <section className={`mt-3 rounded-md border-2 p-3 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Outcome</p>
          <h3 className="truncate text-lg font-bold text-ink">{outcome.label}</h3>
          <p className="mt-1 text-xs font-bold text-ink-faint">{outcome.detail}</p>
        </div>
        <span className="status-pill bg-[rgba(249,243,226,0.78)]">{outcome.badge}</span>
      </div>
    </section>
  );
}

function ColonyDecisionPanel({
  activity,
  title,
  mode,
}: {
  activity: ColonyMarketActivity;
  title: string;
  mode: "open" | "settled";
}) {
  if (!activity.colony) {
    return (
      <div className="well mt-3 p-3 text-sm text-ink-faint">
        No colony selected.
      </div>
    );
  }

  const decision = colonyDecisionSummary(activity);
  const commit = colonyCommitSummary(activity);
  const result = colonyResultSummary(activity, mode);
  return (
    <section className="mt-3 rounded-md border-2 border-[color:rgba(78,126,42,0.42)] bg-[rgba(78,126,42,0.08)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="eyebrow !text-green">{title}</p>
          <h3 className="truncate text-base font-bold text-ink">{activity.colony.name}</h3>
        </div>
        <span className={`status-pill ${result.tone}`}>{result.badge}</span>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        <DecisionCell label="Ant consensus" value={decision.value} detail={decision.detail} tone={decision.tone} />
        <DecisionCell label="Colony action" value={commit.value} detail={commit.detail} tone={commit.tone} />
        <DecisionCell label="Sugar result" value={result.value} detail={result.detail} tone={result.cellTone} />
      </div>

      {activity.distribution.rows.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between gap-3 text-xs font-bold text-ink-faint">
            <span>Colony vote split</span>
            <span>{activity.distribution.total} ants</span>
          </div>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-[rgba(74,58,30,0.18)]">
            {activity.distribution.rows.map((row) => (
              <span
                key={row.key}
                style={{
                  width: `${Math.max(4, Math.round((row.count / Math.max(1, activity.distribution.total)) * 100))}%`,
                  background: row.color,
                }}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function DecisionCell({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "green" | "gold" | "rust" | "muted";
}) {
  const color = tone === "green"
    ? "text-green"
    : tone === "gold"
      ? "text-gold"
      : tone === "rust"
        ? "text-rust"
        : "text-ink";
  return (
    <div className="well min-w-0 px-3 py-2">
      <p className="truncate text-[10px] font-bold text-ink-faint">{label}</p>
      <p className={`truncate text-sm font-bold ${color}`}>{value}</p>
      <p className="mt-1 truncate text-[11px] text-ink-faint">{detail}</p>
    </div>
  );
}

function CockpitLoadState({
  loading,
  error,
  backLabel,
  onBack,
  onRetry,
}: {
  loading: boolean;
  error: string;
  backLabel: string;
  onBack: () => void;
  onRetry: () => void;
}) {
  return (
    <main className="grid min-h-[70dvh] place-items-center p-4">
      <section className="glass grid w-full max-w-xl gap-4 p-6 text-center" role={error ? "alert" : "status"}>
        <span className="text-4xl" aria-hidden="true">{error ? "⚠️" : "🐜"}</span>
        <div>
          <p className="eyebrow">Live cockpit</p>
          <h1 className="mt-2 text-xl font-bold">{loading ? "Loading this simulation..." : "This simulation could not load"}</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-faint">
            {loading ? "Fetching the matching room and colony state." : error || "The room is unavailable."}
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <button type="button" className="btn btn-ghost" onClick={onBack}>{backLabel}</button>
          <button type="button" className="btn btn-primary" disabled={loading} onClick={onRetry}>Retry</button>
        </div>
      </section>
    </main>
  );
}

function PulseMetric({ label, value, tone }: { label: string; value: number | string; tone?: "gold" | "green" }) {
  const color = tone === "gold" ? "text-gold" : tone === "green" ? "text-green" : "text-ink";
  return (
    <div className="plate px-2 py-2">
      <p className="text-[11px] font-bold text-ink-faint">{label}</p>
      <p className={`font-mono text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function Distribution({ distribution, title }: { distribution: ReturnType<typeof aggregateVotes>; title?: string }) {
  return (
    <div className="mt-3">
      {title && <p className="mb-2 text-xs font-bold text-ink-faint">{title}</p>}
      <div className="flex h-3 overflow-hidden rounded-full bg-[rgba(74,58,30,0.18)]" aria-label={`Vote distribution, ${distribution.total} ants`}>
        {distribution.rows.map((row) => (
          <span
            key={row.key}
            style={{
              width: `${Math.max(4, Math.round((row.count / Math.max(1, distribution.total)) * 100))}%`,
              background: row.color,
            }}
          />
        ))}
      </div>
      <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(3, distribution.rows.length)}, minmax(0, 1fr))` }}>
        {distribution.rows.map((row) => (
          <div key={row.key} className="well px-2 py-2">
            <p className="truncate text-xs font-bold" style={{ color: row.color }}>{row.label}</p>
            <p className="font-mono text-xl font-bold">{row.count}</p>
            <p className="text-[11px] text-ink-faint">{Math.round((row.count / Math.max(1, distribution.total)) * 100)}%</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function OptionPreview({ opportunity }: { opportunity?: Opportunity }) {
  const options = opportunity?.options ?? [];
  if (!options.length) {
    return <p className="well mt-3 p-3 text-sm text-ink-faint">Waiting for ant decisions...</p>;
  }
  return (
    <div className="mt-3 grid gap-2">
      <p className="text-xs leading-relaxed text-ink-faint">
        Ant support decides whether the colony enters. It never changes the fixed Sugar stake.
      </p>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(3, options.length)}, minmax(0, 1fr))` }}>
      {options.slice(0, 3).map((option) => {
        const reward = optionRewardSugar(option);
        const risk = optionRiskSugar(option);
        return (
          <div key={option.optionId || option.label} className="well p-2 text-center text-xs font-bold text-ink-soft">
            <span className="block">{option.label || option.value}</span>
            {(reward != null || risk != null) && (
              <span className="mt-1 block font-mono text-[10px] text-ink-faint">
                Colony position: correct +{reward ?? 0} Sugar · miss −{risk ?? 0} Sugar
              </span>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}

function ColonyRoster({
  colonies,
  events,
  activeColonyId,
  onOpenRanks,
  onSelectColony,
}: {
  colonies: Colony[];
  events: GameEvent[];
  activeColonyId?: string;
  onOpenRanks: () => void;
  onSelectColony?: (colonyId: string) => void;
}) {
  if (!colonies.length) {
    return (
      <section className="glass min-w-0 p-4 text-center text-sm text-ink-faint">
        No colonies attached to this simulation yet.
      </section>
    );
  }

  return (
    <section className="glass flex min-w-0 flex-col gap-3 p-3 xl:min-h-[360px]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="eyebrow">Colonies</p>
          <h2 className="text-base font-bold">Simulation roster</h2>
        </div>
        <button className="quiet-link text-sm" onClick={onOpenRanks}>Open ranks</button>
      </div>

      <ColonyRaceChart colonies={colonies} events={events} compact />

      <div className="grid max-h-[300px] gap-2 overflow-y-auto pr-1 xl:max-h-[calc(100dvh-610px)]">
        {colonies.map((colony, index) => {
          const active = colony.colonyId === activeColonyId;
          return (
            <button
              type="button"
              key={colony.colonyId}
              aria-pressed={active}
              disabled={!onSelectColony}
              onClick={() => onSelectColony?.(colony.colonyId)}
              className={`w-full rounded-md border-2 p-3 text-left disabled:cursor-default disabled:opacity-100 ${
                active
                  ? "border-[color:var(--color-gold)] bg-[rgba(249,243,226,0.96)] shadow-[2px_2px_0_rgba(90,70,30,0.4)]"
                  : `border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.7)] ${onSelectColony ? "hover:border-gold/60" : ""}`
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-sm font-bold text-gold">#{index + 1}</span>
                    <h3 className="truncate text-sm font-bold text-ink">{colony.name}</h3>
                  </div>
                  <p className="mt-1 truncate text-xs text-ink-faint">{labelize(colony.style)} temperament · fixed voters</p>
                </div>
                {active && <span className="status-pill">{onSelectColony ? "controlled" : "active"}</span>}
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <MiniStat label="Rank" value={`#${index + 1}`} tone="gold" />
                <MiniStat label="Voters" value={colony.size || 20} />
                <MiniStat label="Sugar" value={colonySugar(colony)} tone="green" />
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function spotlightFromEvent(event: GameEvent): EventSpotlight | null {
  if (event.kind === "match_event") {
    const type = String(event.data?.visualType ?? "");
    const title = String(event.data?.title ?? event.message ?? "MATCH EVENT");
    const minute = event.data?.minute != null ? `${event.data.minute}'` : "LIVE";
    const score = event.data?.score as { participant1?: unknown; participant2?: unknown } | undefined;
    const scoreText = score && (score.participant1 != null || score.participant2 != null)
      ? ` · ${score.participant1 ?? 0}–${score.participant2 ?? 0}`
      : "";
    const base = {
      key: `match-${event.index}`,
      kicker: `${minute}${scoreText}`,
      title,
      detail: String(event.data?.detail ?? event.data?.description ?? "Match update"),
      duration: type === "goal" || type === "penalty_goal" ? 3000 : 2500,
    };
    if (type === "goal" || type === "penalty_goal") return { ...base, tone: "goal", glyph: "ball" };
    if (type === "penalty" || type === "penalty_missed") return { ...base, tone: "penalty", glyph: "penalty" };
    if (type === "yellow_card") return { ...base, tone: "card", glyph: "yellow-card" };
    if (type === "red_card") return { ...base, tone: "danger", glyph: "red-card" };
    if (type === "substitution") return { ...base, tone: "substitution", glyph: "substitution" };
    if (type === "goal_cancelled") return { ...base, tone: "danger", glyph: "ball" };
    return null;
  }

  if (event.kind === "opportunity") {
    const opportunity = event.data?.opportunity as Opportunity | undefined;
    if (!opportunity) return null;
    const minute = opportunity.minute != null ? `${opportunity.minute}'` : "NEW EVENT";
    return {
      key: `open-${event.index}`,
      tone: "market",
      glyph: "market",
      kicker: `${minute} · MARKET OPEN`,
      title: marketSpotlightTitle(opportunity.context),
      detail: cleanMarketLabel(String(opportunity.label ?? event.message ?? "Ants are voting")),
      duration: 1900,
    };
  }

  if (event.kind === "market_closed") {
    const market = event.data?.market as Opportunity | undefined;
    const outcome = event.data?.resolvedOutcome as { label?: unknown; detail?: unknown } | undefined;
    return {
      key: `closed-${event.index}`,
      tone: "resolved",
      glyph: "resolved",
      kicker: "MARKET FINISHED",
      title: String(outcome?.label ?? "EVENT RESOLVED"),
      detail: String(outcome?.detail ?? cleanMarketLabel(String(market?.label ?? event.message))),
      duration: 1900,
    };
  }

  return null;
}

function marketSpotlightTitle(context?: string): string {
  const labels: Record<string, string> = {
    penalties: "PENALTY CALL",
    next_goal_team: "NEXT GOAL",
    goal_next_10: "GOAL IN 10 MIN?",
    next_substitution: "NEXT SUB",
    next_card: "NEXT CARD",
  };
  return labels[String(context ?? "")] ?? "NEW MARKET";
}

function MatchEventSpotlight({ spotlight }: { spotlight: EventSpotlight }) {
  return (
    <div className="match-spotlight" data-tone={spotlight.tone} role="status" aria-live="assertive">
      <div className="match-spotlight-panel">
        <span className="match-spotlight-kicker">{spotlight.kicker}</span>
        <EventSpotlightGlyph glyph={spotlight.glyph} />
        <strong className="match-spotlight-title">{spotlight.title}</strong>
        <span className="match-spotlight-detail">{spotlight.detail}</span>
        <span className="match-spotlight-scan" aria-hidden="true" />
      </div>
    </div>
  );
}

function EventSpotlightGlyph({ glyph }: { glyph: EventSpotlight["glyph"] }) {
  if (glyph === "yellow-card" || glyph === "red-card") {
    return <span className={`match-spotlight-card ${glyph === "red-card" ? "red" : "yellow"}`} aria-hidden="true" />;
  }
  const labels: Record<Exclude<EventSpotlight["glyph"], "yellow-card" | "red-card">, string> = {
    ball: "⚽",
    penalty: "◎",
    substitution: "↔",
    market: "🎯",
    resolved: "✓",
  };
  return <span className="match-spotlight-glyph" aria-hidden="true">{labels[glyph]}</span>;
}

function MiniStat({ label, value, tone }: { label: string; value: number | string; tone?: "gold" | "green" }) {
  const color = tone === "gold" ? "text-gold" : tone === "green" ? "text-green" : "text-ink";
  return (
    <div className="well px-2 py-2">
      <p className="truncate text-[10px] font-bold text-ink-faint">{label}</p>
      <p className={`font-mono text-base font-bold ${color}`}>{value}</p>
    </div>
  );
}

function labelize(value: string | null | undefined): string {
  if (value === "cautious") return "Careful";
  if (value === "aggressive") return "Bold";
  if (value === "balanced") return "Steady";
  return String(value || "steady").replace(/_/g, " ");
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[color:var(--brd-soft)] p-4 text-center">
      <p className="font-bold">{title}</p>
      <p className="mt-1 text-sm text-ink-faint">{body}</p>
    </div>
  );
}

function buildMarkets(activeOpportunities: Opportunity[], events: GameEvent[]): MarketModel[] {
  const activeIds = new Set(activeOpportunities.map((opportunity) => opportunity.opportunityId).filter(Boolean));
  const map = new Map<string, MarketModel>();
  const sortedEvents = [...events].sort((a, b) => a.index - b.index);

  function ensure(id: string, label = "Market"): MarketModel {
    const existing = map.get(id);
    if (existing) return existing;
    const market: MarketModel = {
      id,
      label,
      status: "closed",
      starts: [],
      votes: [],
      predictions: [],
      observations: [],
      settlements: [],
      voids: [],
      closures: [],
      lastIndex: -1,
    };
    map.set(id, market);
    return market;
  }

  for (const opportunity of activeOpportunities) {
    if (!opportunity.opportunityId) continue;
    const market = ensure(opportunity.opportunityId, opportunity.label || opportunity.question || "Open market");
    market.opportunity = opportunity;
    market.label = opportunity.label || market.label;
    market.minute = minuteFromLabel(market.label);
  }

  for (const event of sortedEvents) {
    const opportunity = opportunityFromEvent(event);
    const opportunityId = opportunity?.opportunityId || eventOpportunityId(event);
    if (!opportunityId) continue;

    const market = ensure(opportunityId, opportunity?.label || event.message || "Market");
    market.lastIndex = Math.max(market.lastIndex, event.index);
    if (opportunity) {
      market.opportunity = opportunity;
      market.label = opportunity.label || market.label;
      market.minute = minuteFromLabel(market.label);
    }

    if (event.kind === "ant_agent_start") market.starts.push(event);
    if (event.kind === "ant_agent_vote" || event.kind === "vote") upsertVote(market.votes, event);
    if (event.kind === "prediction") market.predictions.push(event);
    if (event.kind === "observe") market.observations.push(event);
    if (event.kind === "settlement") market.settlements.push(event);
    if (event.kind === "void") market.voids.push(event);
    if (event.kind === "market_closed") market.closures.push(event);
  }

  return [...map.values()]
    .map((market) => {
      const marketStatus: MarketModel["status"] = market.settlements.length
        ? "settled"
        : market.voids.length
          ? "void"
          : market.closures.length
            ? "closed"
            : activeIds.has(market.id)
              ? "open"
              : "closed";
      return { ...market, status: marketStatus };
    })
    .sort((a, b) => b.lastIndex - a.lastIndex);
}

function upsertVote(votes: GameEvent[], event: GameEvent) {
  const colonyId = String(event.data?.colonyId ?? event.index);
  const index = votes.findIndex((vote) => String(vote.data?.colonyId ?? vote.index) === colonyId);
  if (index < 0) {
    votes.push(event);
    return;
  }
  if (event.kind === "vote" || votes[index].kind !== "vote") votes[index] = event;
}

function aggregateVotes(votes: GameEvent[]) {
  const counts: Record<string, number> = {};
  const labels: Record<string, string> = {};
  let voters = 0;

  for (const event of votes) {
    const vote = event.data?.vote as PublicVote | undefined;
    if (!vote) continue;
    voters += vote.agentDecisionCount ?? vote.activeCount ?? 0;
    Object.assign(labels, vote.voteLabels ?? {});
    for (const [key, value] of Object.entries(vote.voteCounts ?? {})) {
      counts[key] = (counts[key] ?? 0) + Number(value || 0);
    }
  }

  const order = ["yes", "no", "option_a", "option_b", "option_c", "option_d", "abstain"];
  const keys = [...order.filter((key) => key in counts), ...Object.keys(counts).filter((key) => !order.includes(key))];
  const rows = keys
    .filter((key) => counts[key] > 0)
    .map((key, index) => ({
      key,
      label: shortVoteLabel(labels[key] || key),
      count: counts[key],
      color: voteColor(key, index),
    }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return { rows, total, voters };
}

function summarizeOpenMarkets(markets: MarketModel[]) {
  return markets.reduce(
    (summary, market) => {
      const distribution = aggregateVotes(market.votes);
      const expected = market.starts.reduce((sum, event) => sum + Number(event.data?.activeCount ?? 0), 0);
      const abstain = distribution.rows.find((row) => row.key === "abstain")?.count ?? 0;
      return {
        markets: summary.markets + 1,
        answers: summary.answers + Math.max(distribution.total, expected),
        abstain: summary.abstain + abstain,
      };
    },
    { markets: 0, answers: 0, abstain: 0 },
  );
}

function pendingAntCount(market: MarketModel, answered: number) {
  const expected = market.starts.reduce((sum, event) => sum + Number(event.data?.activeCount ?? 0), 0);
  return Math.max(0, expected - answered);
}

function settlementSummary(market: MarketModel) {
  let resourceDelta = 0;
  let voided = 0;
  let wins = 0;
  let losses = 0;

  for (const event of market.settlements) {
    if (event.data?.win) wins += 1;
    else losses += 1;
    resourceDelta += Number(event.data?.sugar ?? event.data?.resourceDelta ?? event.data?.food ?? 0);
  }
  voided = market.voids.length;

  const label = wins && !losses && !voided ? "won" : voided && !wins && !losses ? "void" : wins || losses ? "mixed" : "closed";
  const tone = label === "won"
    ? "border-green/50 text-green"
    : label === "void"
      ? "border-ink-faint/50 text-ink-faint"
      : "border-gold/50 text-gold";
  return { resourceDelta, voided, wins, losses, label, tone };
}

function marketOutcomeSummary(market: MarketModel): MarketOutcome {
  const recordedOutcomes = recordedMarketOutcomes(market.settlements);
  if (recordedOutcomes.length === 1) {
    return {
      label: cleanOutcomeLabel(recordedOutcomes[0].label),
      detail: recordedOutcomes[0].detail || "Recorded from the match event that settled this market.",
      badge: "confirmed",
      tone: market.settlements.some((event) => Boolean(eventData(event)?.win)) ? "green" : "gold",
    };
  }
  if (recordedOutcomes.length > 1) {
    return {
      label: recordedOutcomes.map((outcome) => cleanOutcomeLabel(outcome.label)).join(" / "),
      detail: "Multiple recorded outcomes were found for this market.",
      badge: "review",
      tone: "gold",
    };
  }

  const winningLabels = uniqueNonEmpty(
    market.settlements
      .filter((event) => Boolean(eventData(event)?.win))
      .map(eventOptionLabel),
  );
  if (winningLabels.length === 1) {
    return {
      label: cleanOutcomeLabel(winningLabels[0]),
      detail: `${market.settlements.filter((event) => Boolean(eventData(event)?.win)).length} winning colony result(s).`,
      badge: "confirmed",
      tone: "green",
    };
  }
  if (winningLabels.length > 1) {
    return {
      label: winningLabels.map(cleanOutcomeLabel).join(" / "),
      detail: "Multiple winning options were recorded.",
      badge: "confirmed",
      tone: "green",
    };
  }

  const inferred = inferOutcomeFromSettlements(market);
  if (inferred) return inferred;

  const closedOutcomes = recordedMarketOutcomes(market.closures);
  if (closedOutcomes.length === 1) {
    return {
      label: cleanOutcomeLabel(closedOutcomes[0].label),
      detail: `${closedOutcomes[0].detail || "Resolved from the live match event."} No colony entered, so no Sugar was at risk.`,
      badge: "closed",
      tone: "muted",
    };
  }

  if (market.closures.length && !market.settlements.length && !market.voids.length) {
    return {
      label: "No colony entered",
      detail: "The colonies observed this market, so no Sugar was put at risk.",
      badge: "closed",
      tone: "muted",
    };
  }

  const voidReason = firstReason(market.voids);
  if (market.voids.length && !market.settlements.length) {
    return {
      label: voidOutcomeLabel(market, voidReason),
      detail: voidReason ? `Voided by ${humanizeReason(voidReason)}.` : "All recorded positions were voided.",
      badge: "void",
      tone: "muted",
    };
  }

  if (market.settlements.length) {
    return {
      label: "Resolved",
      detail: "No winning colony selected the outcome, so the exact outcome is not stored in this replay.",
      badge: "review",
      tone: "gold",
    };
  }

  return {
    label: "Closed",
    detail: "No outcome data was recorded for this market.",
    badge: "closed",
    tone: "muted",
  };
}

function inferOutcomeFromSettlements(market: MarketModel): MarketOutcome | null {
  const reason = firstReason(market.settlements) || firstReason(market.voids);
  const label = cleanMarketLabel(market.label).toLowerCase();
  const context = market.opportunity?.context;
  if ((context === "goal_next_10" || label.includes("goal in the next 10")) && ["expired", "full_time"].includes(reason || "")) {
    return {
      label: "no goal in the next 10 min",
      detail: `Inferred from ${humanizeReason(reason)}.`,
      badge: "inferred",
      tone: "gold",
    };
  }
  if ((context === "next_goal_team" || label.includes("who scores the next goal")) && ["expired", "full_time"].includes(reason || "")) {
    return {
      label: "no goal before full time",
      detail: `Inferred from ${humanizeReason(reason)}.`,
      badge: "inferred",
      tone: "gold",
    };
  }
  if ((context === "next_corner" || label.includes("who wins the next corner")) && reason === "full_time") {
    return {
      label: "no corner before full time",
      detail: "Inferred from full time.",
      badge: "inferred",
      tone: "gold",
    };
  }
  if ((context === "next_free_kick" || label.includes("who wins the next free kick")) && reason === "full_time") {
    return {
      label: "no free kick before full time",
      detail: "Inferred from full time.",
      badge: "inferred",
      tone: "gold",
    };
  }
  if ((context === "next_yellow_card" || label.includes("who gets the next yellow card")) && reason === "full_time") {
    return {
      label: "no yellow card before full time",
      detail: "Inferred from full time.",
      badge: "inferred",
      tone: "gold",
    };
  }
  if ((context === "next_foul" || label.includes("who commits the next foul")) && reason === "expired_no_foul") {
    return {
      label: "no matching legacy foul before full time",
      detail: "Legacy foul market expired without a matching signal.",
      badge: "void",
      tone: "muted",
    };
  }

  const optionLabels = (market.opportunity?.options ?? [])
    .map((option) => option.label || option.value || option.optionId || "")
    .filter(Boolean);
  const losingLabels = uniqueNonEmpty(
    market.settlements
      .filter((event) => eventData(event)?.win === false)
      .map(eventOptionLabel),
  );
  if (optionLabels.length === 2 && losingLabels.length === 1) {
    const outcome = optionLabels.find((option) => normalizeLabel(option) !== normalizeLabel(losingLabels[0]));
    if (outcome) {
      return {
        label: cleanOutcomeLabel(outcome),
        detail: "Inferred from the losing side on a two-option market.",
        badge: "inferred",
        tone: "gold",
      };
    }
  }
  return null;
}

function voidOutcomeLabel(market: MarketModel, reason?: string) {
  const label = cleanMarketLabel(market.label).toLowerCase();
  if (reason === "penalty_cancelled") return "penalty cancelled";
  if (reason === "expired_no_foul" || label.includes("who commits the next foul")) return "no matching legacy foul before full time";
  if (reason === "full_time") return "voided at full time";
  return "market voided";
}

function colonyMarketActivity(market: MarketModel, colony?: Colony): ColonyMarketActivity {
  const colonyId = colony?.colonyId;
  const stake = colonyStake(market, colonyId);
  const voteEvent = latestColonyEvent(market.votes, colonyId);
  const predictionEvent = latestColonyEvent(market.predictions, colonyId);
  const observeEvent = latestColonyEvent(market.observations, colonyId);
  const settlementEvent = latestColonyEvent(market.settlements, colonyId);
  const voidEvent = latestColonyEvent(market.voids, colonyId);
  const distribution = voteEvent ? aggregateVotes([voteEvent]) : { rows: [], total: 0, voters: 0 };
  const topVote = [...distribution.rows].sort((a, b) => b.count - a.count)[0];
  return { colony, stake, voteEvent, predictionEvent, observeEvent, settlementEvent, voidEvent, distribution, topVote };
}

function latestColonyEvent(events: GameEvent[], colonyId?: string): GameEvent | undefined {
  if (!colonyId) return undefined;
  return [...events]
    .filter((event) => String(event.data?.colonyId ?? "") === String(colonyId))
    .sort((a, b) => b.index - a.index)[0];
}

function colonyDecisionSummary(activity: ColonyMarketActivity) {
  if (!activity.voteEvent) {
    return { value: "Waiting", detail: "No answer yet", tone: "muted" as const };
  }
  if (!activity.topVote) {
    return { value: "Waiting", detail: "No ant votes yet", tone: "muted" as const };
  }
  const value = activity.topVote.key === "abstain" ? "Pass" : activity.topVote.label;
  return {
    value,
    detail: `${activity.topVote.count}/${Math.max(1, activity.distribution.total)} ants`,
    tone: voteTone(activity.topVote.key),
  };
}

function colonyCommitSummary(activity: ColonyMarketActivity) {
  const prediction = eventData(activity.predictionEvent);
  const ants = activity.stake?.ants ?? Number(prediction?.ants ?? 0);
  const option = activity.stake?.optionLabel ?? eventOptionLabel(activity.predictionEvent);
  if (activity.predictionEvent && ants > 0) {
    return {
      value: "Entered",
      detail: option ? `${antLabel(ants)} back ${option}` : `${antLabel(ants)} backed the call`,
      tone: "gold" as const,
    };
  }
  if (activity.observeEvent) {
    const observation = observeReasonSummary(activity.observeEvent);
    return {
      value: observation.value,
      detail: observation.detail,
      tone: "muted" as const,
    };
  }
  if (activity.voteEvent) {
    return {
      value: "Observed",
      detail: activity.topVote?.key === "abstain" ? "ants chose to pass" : "no colony position was recorded",
      tone: "muted" as const,
    };
  }
  return { value: "Waiting", detail: "no colony vote yet", tone: "muted" as const };
}

function observeReasonSummary(event?: GameEvent): { value: string; detail: string } {
  const data = eventData(event);
  const reason = String(data?.reason ?? "").trim().toLowerCase();

  if (["insufficient_sugar", "insufficient_food", "insufficient_balance", "not_enough_sugar"].includes(reason)) {
    const required = finiteNumber(data?.requiredSugar ?? data?.requiredFood);
    return {
      value: "No entry",
      detail: required != null ? `not enough available Sugar (needs ${required})` : "not enough available Sugar",
    };
  }

  if (["reserve_limit", "exposure_limit", "reserve_cap", "max_reserved"].includes(reason)) {
    const limit = finiteNumber(data?.maxReservedSugar);
    return {
      value: "No entry",
      detail: limit != null ? `${limit} Sugar exposure cap reached` : "Sugar exposure cap reached",
    };
  }

  if (["tied_vote", "tied", "tie", "vote_tied"].includes(reason)) {
    return { value: "No entry", detail: "ant vote ended in a tie" };
  }

  if (["low_consensus", "no_commitment", "below_threshold", "insufficient_consensus"].includes(reason)) {
    const support = finiteNumber(data?.supportFraction ?? data?.consensus);
    const threshold = finiteNumber(data?.entryThreshold);
    const supportLabel = support != null ? `${Math.round(support * 100)}% consensus` : "consensus";
    const thresholdLabel = threshold != null ? ` · needs ${Math.round(threshold * 100)}%` : " stayed below temperament";
    return { value: "No entry", detail: `${supportLabel}${thresholdLabel}` };
  }

  return {
    value: "Observed",
    detail: reason ? humanizeReason(reason) : "no colony entry",
  };
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function colonyResultSummary(activity: ColonyMarketActivity, mode: "open" | "settled") {
  const settlement = eventData(activity.settlementEvent);
  if (activity.settlementEvent) {
    const resourceDelta = Number(settlement?.sugar ?? settlement?.resourceDelta ?? settlement?.food ?? 0);
    if (settlement?.win) {
      return {
        badge: "won",
        value: resourceDelta > 0 ? `${signedValue(resourceDelta)} Sugar` : "Correct",
        detail: eventOptionLabel(activity.settlementEvent) || "resolved",
        tone: "!border-green/50 !text-green",
        cellTone: "green" as const,
      };
    }
    return {
      badge: "lost",
      value: resourceDelta < 0 ? `${signedValue(resourceDelta)} Sugar` : "Missed",
      detail: eventOptionLabel(activity.settlementEvent) || "resolved",
      tone: "!border-rust/50 !text-rust",
      cellTone: "rust" as const,
    };
  }
  if (activity.voidEvent) {
    return {
      badge: "void",
      value: "No Sugar change",
      detail: eventOptionLabel(activity.voidEvent) || "market voided",
      tone: "!border-ink-faint/50 !text-ink-faint",
      cellTone: "muted" as const,
    };
  }
  if (mode === "open") {
    const entered = Boolean(activity.predictionEvent);
    return {
      badge: entered ? "entered" : "observed",
      value: entered ? "Sugar at risk" : "No Sugar at risk",
      detail: entered ? "waiting for the match result" : "colony passed this market",
      tone: "!border-gold/50 !text-gold",
      cellTone: entered ? "gold" as const : "muted" as const,
    };
  }
  return {
    badge: "none",
    value: "No Sugar change",
    detail: "colony observed this market",
    tone: "!border-ink-faint/50 !text-ink-faint",
    cellTone: "muted" as const,
  };
}

function personalResultEvents(activity: ColonyMarketActivity) {
  return [activity.settlementEvent, activity.voidEvent].filter(Boolean) as GameEvent[];
}

function uniqueEventByIndex(event: GameEvent, index: number, list: GameEvent[]) {
  return list.findIndex((candidate) => candidate.index === event.index) === index;
}

function eventData(event?: GameEvent) {
  return event?.data as
    | {
        ants?: number;
        food?: number;
        sugar?: number;
        option?: { label?: string; optionId?: string };
        reason?: string;
        requiredSugar?: number;
        requiredFood?: number;
        maxReservedSugar?: number;
        supportFraction?: number;
        consensus?: number;
        entryThreshold?: number;
        resourceDelta?: number;
        resourceLoss?: number;
        resolvedOutcome?: { label?: string; detail?: string };
        win?: boolean;
      }
    | undefined;
}

function eventOptionLabel(event?: GameEvent) {
  const option = eventData(event)?.option;
  return option?.label || option?.optionId || "";
}

function signedValue(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function antLabel(count: number): string {
  return `${count} ant${count === 1 ? "" : "s"}`;
}

function firstReason(events: GameEvent[]) {
  return events.map((event) => eventData(event)?.reason).find(Boolean);
}

function recordedMarketOutcomes(events: GameEvent[]) {
  const seen = new Set<string>();
  const outcomes: { label: string; detail?: string }[] = [];
  for (const event of events) {
    const raw = eventData(event)?.resolvedOutcome;
    const label = String(raw?.label ?? "").trim();
    if (!label) continue;
    const key = normalizeLabel(label);
    if (seen.has(key)) continue;
    seen.add(key);
    outcomes.push({ label, detail: raw?.detail });
  }
  return outcomes;
}

function uniqueNonEmpty(values: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const clean = value.trim();
    const key = normalizeLabel(clean);
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    unique.push(clean);
  }
  return unique;
}

function normalizeLabel(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function cleanOutcomeLabel(value: string) {
  return shortVoteLabel(value).replace(/\?$/, "");
}

function humanizeReason(reason?: string) {
  if (!reason) return "settlement";
  return reason.replace(/_/g, " ");
}

function voteTone(key: string): "green" | "gold" | "rust" | "muted" {
  if (key === "yes" || key === "option_a") return "green";
  if (key === "no" || key === "option_b") return "rust";
  if (key === "option_c" || key === "option_d") return "gold";
  return "muted";
}

function opportunityFromEvent(event: GameEvent): Opportunity | undefined {
  const raw = event.data?.opportunity;
  return raw && typeof raw === "object" ? raw as Opportunity : undefined;
}

function eventOpportunityId(event: GameEvent): string | undefined {
  const direct = event.data?.opportunityId;
  if (typeof direct === "string") return direct;
  const directMarketId = event.data?.marketId;
  if (typeof directMarketId === "string") return directMarketId;
  const vote = event.data?.vote as PublicVote | undefined;
  const marketId = (vote as { market?: { marketId?: unknown } } | undefined)?.market?.marketId;
  if (typeof marketId === "string") return marketId;
  const market = event.data?.market as { marketId?: unknown; opportunityId?: unknown } | undefined;
  if (typeof market?.opportunityId === "string") return market.opportunityId;
  return typeof market?.marketId === "string" ? market.marketId : undefined;
}

function minuteFromLabel(label?: string) {
  const match = label?.match(/^(\d+)'/);
  return match ? Number(match[1]) : undefined;
}

function marketLabelPrefix(market: MarketModel) {
  return market.minute != null ? `${market.minute}' window` : `#${market.lastIndex}`;
}

function compactMarketName(market: MarketModel) {
  const prefix = market.minute != null ? `${market.minute}'` : `#${market.lastIndex}`;
  return `${prefix} ${marketKindName(market.label)}`;
}

function marketKindName(label: string) {
  const clean = cleanMarketLabel(label).toLowerCase();
  if (clean.includes("commits the next foul")) return "Legacy foul";
  if (clean.includes("wins the next free kick")) return "Free kick";
  if (clean.includes("scores the next goal")) return "Next goal";
  if (clean.includes("goal in the next 10")) return "Goal 10m";
  if (clean.includes("yellow card")) return "Yellow card";
  if (clean.includes("penalty")) return "Penalty";
  if (clean.includes("corner")) return "Corner";
  if (clean.includes("card")) return "Card";
  return cleanMarketLabel(label).replace(/\?$/, "").split(" ").slice(0, 3).join(" ");
}

function cleanMarketLabel(label: string) {
  return label.replace(/^\d+'\s*-\s*/, "");
}

function shortVoteLabel(label: string) {
  return label
    .replace("do not commit this ant to this market", "abstain")
    .replace("before the deadline", "before deadline")
    .replace("in the next 10 min", "next 10 min");
}

function voteColor(key: string, index: number) {
  if (key === "abstain") return "#8c7e60";
  if (key === "yes" || key === "option_a") return "#4e7e2a";
  if (key === "no" || key === "option_b") return "#c25a3a";
  if (key === "option_c") return "#b07e1c";
  return index % 2 ? "#5e5440" : "#876012";
}

function compactEventMessage(event: GameEvent) {
  const message = (event.message || event.kind).replace(/\bfood\b/gi, "Sugar");
  if (event.kind === "ant_agent_vote" || event.kind === "vote") {
    return message.replace(/^DeepSeek vote from /, "").replace(/Will there be /, "Will ");
  }
  if (event.kind === "settlement") return message.replace(/^Result /, "");
  return `${kindIcon(event.kind)} ${message}`;
}

function formatClock(ms: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function isUsefulLiveEvent(e: GameEvent) {
  return ["opportunity", "observe", "settlement", "void", "game_error", "game_started", "market_closed", "markets_closed", "live_sync"].includes(e.kind) || isMatchEvent(e);
}

// Job 2: turn the raw event log into a legible, game-feeling stream.
// Folds consecutive same-kind-same-colony events (e.g. repeated observations
// ticks) into one row with a count, and extracts a structured delta
// (+green / -rust) plus muted context instead of a dry sentence. Parses
// event.data defensively — the engine event shapes are not touched here.
function aggregateFeed(events: GameEvent[], colonyNames: Record<string, string> = {}): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const event of events) {
    const parsed = parseFeedEvent(event, colonyNames);
    const prev = rows[rows.length - 1];
    if (prev && prev.kind === event.kind && prev.colonyId !== null && prev.colonyId === parsed.colonyId) {
      prev.count += 1;
      prev.firstIndex = Math.min(prev.firstIndex, event.index);
      prev.lastIndex = Math.max(prev.lastIndex, event.index);
      if (parsed.delta) {
        prev.delta = prev.delta && prev.delta.unit === parsed.delta.unit
          ? { value: prev.delta.value + parsed.delta.value, unit: prev.delta.unit }
          : prev.delta ?? parsed.delta;
      }
      continue;
    }
    rows.push({
      key: `${event.kind}:${parsed.colonyId ?? "none"}:${event.index}`,
      kind: event.kind,
      colonyId: parsed.colonyId,
      colonyName: parsed.colonyName,
      message: parsed.message,
      detail: parsed.detail,
      delta: parsed.delta,
      count: 1,
      firstIndex: event.index,
      lastIndex: event.index,
    });
  }
  return rows;
}

function parseFeedEvent(
  event: GameEvent,
  colonyNames: Record<string, string>,
): { colonyId: string | null; colonyName: string | null; message: string; detail: string | null; delta: { value: number; unit: string } | null } {
  const data = event.data ?? {};
  const colonyId = typeof data.colonyId === "string" ? data.colonyId : null;
  const colonyName = (colonyId && colonyNames[colonyId]) || extractColonyNameFromMessage(event.message);
  const message = compactEventMessage(event);
  const option = data.option as { label?: string } | undefined;

  switch (event.kind) {
    case "observe": {
      const observation = observeReasonSummary(event);
      const detail = `passed · ${observation.detail}`;
      return { colonyId, colonyName, message: `Market passed — ${observation.detail}`, detail, delta: null };
    }
    case "settlement": {
      const sugar = Number(data.sugar ?? data.resourceDelta ?? data.food ?? 0);
      return { colonyId, colonyName, message, detail: option?.label ? `on ${option.label}` : null, delta: sugar ? { value: sugar, unit: "Sugar" } : null };
    }
    case "void": {
      return { colonyId, colonyName, message, detail: option?.label ? `voided · ${option.label}` : "voided", delta: null };
    }
    default:
      return { colonyId, colonyName: null, message, detail: null, delta: null };
  }
}

// Fallback only: colonyNames (built from game.colonies) covers almost every
// case. This just guards against a colony that dropped out of the roster.
function extractColonyNameFromMessage(message: string): string | null {
  const result = message.match(/^Result\s+([^:]+):/);
  if (result) return result[1].trim();
  const colon = message.match(/^([^:]{2,40}):\s/);
  if (colon) return colon[1].trim();
  return null;
}

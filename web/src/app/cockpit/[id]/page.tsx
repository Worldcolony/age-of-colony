"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useStore } from "@/store/game";
import { useGameStream } from "@/hooks/useGameStream";
import { getAnonId } from "@/lib/anon";
import { flag, teamName, fmtScore, kindIcon, isMatchEvent } from "@/lib/format";
import type { GameEvent, Colony, GameState, Opportunity, Style, FavoriteContext, InfoNeed, StrategyPatch } from "@/lib/types";
import { worldLink } from "@/three/worldLink";
import { GameShell, GameChip, GameToasts, useGameToasts } from "@/components/GameShell";

const RUNNING = new Set(["running_replay", "running_live"]);
const PULSE: Record<string, number> = { opportunity: 3, vote: 1.4, ant_agent_vote: 1.4, settlement: 2.4, hatch: 1.6, game_started: 3 };
const KIND_EDGE: Record<string, string> = {
  opportunity: "#b07e1c", markets_closed: "#b07e1c",
  settlement: "#4e7e2a", hatch: "#4e7e2a", info_result: "#4e7e2a",
  vote: "#c25a3a", ant_agent_vote: "#c25a3a", prediction: "#c25a3a",
  game_error: "#c25a3a", starvation: "#c25a3a", void: "#c25a3a",
  rally: "#b07e1c", recall: "#3fa89f", switch: "#b07e1c",
};

interface PublicVote {
  activeCount?: number;
  neutralCount?: number;
  agentDecisionCount?: number;
  aliveCount?: number;
  engagedCount?: number;
  woundedCount?: number;
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
  settlements: GameEvent[];
  voids: GameEvent[];
  rallies: GameEvent[];
  recalls: GameEvent[];
  switches: GameEvent[];
  lastIndex: number;
}

type CockpitTab = "live" | "settled" | "feed";

// A row in the aggregated event stream — one or more consecutive raw engine
// events of the same kind + colony, folded together so spam (e.g. four
// starvation ticks in a row) reads as one legible line with a ×N count.
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
  voteEvent?: GameEvent;
  predictionEvent?: GameEvent;
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

export default function CockpitPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const game = useStore((s) => s.game);
  const setGame = useStore((s) => s.setGame);
  const myColonyId = useStore((s) => s.myColonyId);
  const setMyColonyId = useStore((s) => s.setMyColonyId);
  const mf = useStore((s) => s.matchFixture);

  const [events, setEvents] = useState<GameEvent[]>([]);
  const [streamState, setStreamState] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<CockpitTab>("live");
  const [sheetOpen, setSheetOpen] = useState(false); // map first — this is the game screen
  const [selectedMarketId, setSelectedMarketId] = useState<string | null>(null);
  const [selectedSettledId, setSelectedSettledId] = useState<string | null>(null);
  const [ralliedMarkets, setRalliedMarkets] = useState<Set<string>>(new Set());
  const [switchedMarkets, setSwitchedMarkets] = useState<Set<string>>(new Set());
  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null);
  const seen = useRef<Set<number>>(new Set());
  const anonId = useMemo(() => getAnonId(), []);

  const { toasts, push } = useGameToasts();
  const mineIdRef = useRef<string | null>(null);
  const liveRef = useRef(false); // suppress fx/toasts while loading history
  // announceEvent runs outside render (called from addEvents) — it needs the
  // latest ranking to announce a winner on game_finished without becoming a
  // dependency of the event pipeline, so it's mirrored into a ref.
  const sortedRef = useRef<Colony[]>([]);

  function addEvent(e: GameEvent) {
    addEvents([e]);
  }

  // The mechanism, made visible: every meaningful engine event lands in the
  // 3D world (combat text over the mound that earned/lost it) and, when it's
  // about YOUR colony, as a toast over the HUD.
  function announceEvent(event: GameEvent) {
    const colonyId = typeof event.data?.colonyId === "string" ? event.data.colonyId : null;
    const isMine = Boolean(colonyId && colonyId === mineIdRef.current);
    if (event.kind === "settlement") {
      const food = Number(event.data?.food ?? 0);
      const win = Boolean(event.data?.win);
      const foodText = food > 0 ? `+${food} food` : food < 0 ? `${food} food` : win ? "safe call" : "missed";
      worldLink.fx(colonyId, win ? "gain" : "loss", foodText);
      if (isMine) {
        const label = (event.data?.option as { label?: string } | undefined)?.label ?? "market";
        push(`${win ? "🏆" : "💀"} ${foodText} — ${label}`, win ? "gain" : "loss");
      }
    } else if (event.kind === "opportunity") {
      const label = (event.data?.opportunity as Opportunity | undefined)?.label ?? event.message ?? "New market";
      worldLink.fx(null, "market", "🎯 market open");
      push(`🎯 ${cleanMarketLabel(String(label))} — ants are voting`, "market");
    } else if (event.kind === "hatch") {
      worldLink.fx(colonyId, "gain", "🥚 +larvae");
      if (isMine) push("🥚 Your colony hatched new ants", "gain");
    } else if (event.kind === "starvation") {
      worldLink.fx(colonyId, "death", "☠️ −1 ant");
      if (isMine) push("☠️ Your ants are starving — win markets to feed them", "loss");
    } else if (event.kind === "rally") {
      worldLink.fx(colonyId, "rally", "📣 rally!");
      if (!isMine) push(`📣 ${event.message}`, "market");
    } else if (event.kind === "recall") {
      worldLink.fx(colonyId, "recall", "🛡 recall");
      if (isMine) push(`🛡 ${event.message}`, "market");
    } else if (event.kind === "switch") {
      worldLink.fx(colonyId, "switch", "🔀 pivot!");
      if (isMine) push(`🔀 ${event.message}`, "market");
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

  function addEvents(incoming: GameEvent[]) {
    const fresh: GameEvent[] = [];
    for (const event of incoming) {
      if (seen.current.has(event.index)) continue;
      seen.current.add(event.index);
      if (PULSE[event.kind]) worldLink.pulse(PULSE[event.kind]);
      if (liveRef.current) announceEvent(event);
      fresh.push(event);
    }
    if (!fresh.length) return;
    setEvents((prev) => [...fresh, ...prev].sort((a, b) => b.index - a.index).slice(0, 700));
    // history is loaded — anything after this batch is live and worth announcing
    liveRef.current = true;
  }

  useEffect(() => {
    let cancelled = false;

    async function loadSnapshot() {
      try {
        const replay = await api.getReplay(id);
        if (cancelled) return;
        setGame(replay.game);
        const ownColony = findOwnColony(replay.game, anonId);
        if (ownColony) setMyColonyId(ownColony.colonyId);
        addEvents(replay.events ?? []);
        setLastSyncAt(Date.now());
      } catch {
        try {
          const g = await api.getGame(id);
          if (cancelled) return;
          setGame(g);
          const ownColony = findOwnColony(g, anonId);
          if (ownColony) setMyColonyId(ownColony.colonyId);
          setLastSyncAt(Date.now());
        } catch { /* keep current screen */ }
      }
    }

    loadSnapshot();
    const interval = window.setInterval(loadSnapshot, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useGameStream(id, {
    onOpen: () => setStreamState("live"),
    onError: () => setStreamState("reconnecting"),
    onEvent: (e) => {
      setStreamState("live");
      addEvent(e);
    },
    onState: (g) => {
      setStreamState("live");
      setGame(g);
      setLastSyncAt(Date.now());
    },
  });

  const sorted = useMemo(() => [...(game?.colonies ?? [])].sort((a, b) => (b.score || 0) - (a.score || 0)), [game?.colonies]);
  useEffect(() => {
    sortedRef.current = sorted;
  }, [sorted]);
  const ownColony = useMemo(() => findOwnColony(game, anonId), [game, anonId]);
  const spectatorFallback = (game?.players?.length ?? 0) === 0 ? sorted[0] : undefined;
  const mine = ownColony ?? spectatorFallback;
  const colonyFocusLabel = ownColony ? "Your colony" : "Watched colony";
  const myIdx = mine ? sorted.findIndex((c) => c.colonyId === mine.colonyId) : -1;
  const rank = myIdx >= 0 ? myIdx + 1 : 0;
  const p1 = teamName(game?.participant1 ?? mf?.participant1);
  const p2 = teamName(game?.participant2 ?? mf?.participant2);
  const status = game?.status ?? "";
  const txlineWaiting = isTxlineWaiting(game);
  const txlineStateLabel = matchStateLabel(game);
  const markets = useMemo(() => buildMarkets(game?.activeOpportunities ?? [], events), [game?.activeOpportunities, events]);
  const openMarkets = markets.filter((market) => market.status === "open");
  const settledMarkets = markets.filter((market) => market.status !== "open" && (market.settlements.length || market.voids.length));
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

  // The market action bar: three mid-match verbs on top of your ants' call.
  // Only one action is ever in flight per market at a time (actionBusyKey is
  // `${marketId}:${verb}`), so the three buttons can't race each other.
  async function handleRally(market: MarketModel) {
    if (!mine) return;
    if (actionBusyKey) return;
    setActionBusyKey(`${market.id}:rally`);
    try {
      const g = await api.rally(id, { colonyId: mine.colonyId, opportunityId: market.id, anonymousId: anonId });
      setGame(g);
      setRalliedMarkets((prev) => new Set(prev).add(market.id));
      push("📣 Rally! 5 more ants pile onto this market", "market");
      worldLink.fx(mine.colonyId, "rally", "📣 rally!");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Rally failed — try again.";
      push(message, "loss");
    } finally {
      setActionBusyKey(null);
    }
  }

  // Pull back up to 5 ants from a call you've soured on — free, repeatable,
  // but you always keep your last ant in the market.
  async function handleRecall(market: MarketModel) {
    if (!mine) return;
    if (actionBusyKey) return;
    setActionBusyKey(`${market.id}:recall`);
    try {
      const g = await api.recall(id, { colonyId: mine.colonyId, opportunityId: market.id, anonymousId: anonId });
      setGame(g);
      push("🛡 Recall! Your ants pull back from this market", "market");
      worldLink.fx(mine.colonyId, "recall", "🛡 recall");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Recall failed — try again.";
      push(message, "loss");
    } finally {
      setActionBusyKey(null);
    }
  }

  // Pivot your whole call to a different option — once per market, costs food.
  async function handleSwitch(market: MarketModel, optionId: string) {
    if (!mine) return;
    if (actionBusyKey) return;
    setActionBusyKey(`${market.id}:switch`);
    try {
      const g = await api.switchCall(id, { colonyId: mine.colonyId, opportunityId: market.id, optionId, anonymousId: anonId });
      setGame(g);
      setSwitchedMarkets((prev) => new Set(prev).add(market.id));
      push("🔀 Pivot! Your colony calls a new outcome", "market");
      worldLink.fx(mine.colonyId, "switch", "🔀 pivot!");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Switch failed — try again.";
      push(message, "loss");
    } finally {
      setActionBusyKey(null);
    }
  }

  useEffect(() => {
    if (ownColony?.colonyId && myColonyId !== ownColony.colonyId) {
      setMyColonyId(ownColony.colonyId);
    }
  }, [myColonyId, ownColony?.colonyId, setMyColonyId]);

  // Keep the 3D world's mounds in lockstep with the live game — founds any
  // colony that isn't in the world yet and feeds it live ants/food/score.
  useEffect(() => {
    if (game?.colonies?.length) worldLink.syncColonies(game.colonies, mine?.colonyId ?? null);
  }, [game?.colonies, mine?.colonyId]);

  useEffect(() => {
    mineIdRef.current = mine?.colonyId ?? null;
  }, [mine?.colonyId]);

  // Pre-match rooms have nothing on the map yet — surface the sheet's
  // "back to room" guidance instead of an empty world.
  useEffect(() => {
    if (status === "created") setSheetOpen(true);
  }, [status]);

  // Arrival shot: fly the camera to your mound once, so you always know
  // where "you" are on the map before the markets start moving.
  const introFlown = useRef(false);
  useEffect(() => {
    if (introFlown.current || !mine?.colonyId) return;
    introFlown.current = true;
    const t = window.setTimeout(() => worldLink.focusColony(mine.colonyId), 900);
    return () => window.clearTimeout(t);
  }, [mine?.colonyId]);

  const colonyRail = sorted.length > 0 && (
    <div className="colony-rail" aria-label="Colonies on the map">
      {sorted.map((colony, index) => (
        <button
          key={colony.colonyId}
          type="button"
          data-mine={colony.colonyId === mine?.colonyId}
          onClick={() => {
            worldLink.focusColony(colony.colonyId);
            setSheetOpen(false); // drop the sheet so you see the flight
          }}
        >
          <span className="rk">#{index + 1}</span>
          <span className="truncate">{colony.name}</span>
          <span className="text-xs text-ink-faint">🐜{colony.antsAlive}</span>
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
          ralliedMarkets={ralliedMarkets}
          switchedMarkets={switchedMarkets}
          actionBusyKey={actionBusyKey}
          onRally={handleRally}
          onRecall={handleRecall}
          onSwitch={handleSwitch}
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
      {activeTab === "feed" && <FeedTab feedRows={feedRows} onOpenRanks={() => router.push(`/results/${id}`)} />}
      <TacticsPanel gameId={id} colony={mine} anonId={anonId} onGame={setGame} push={push} />
    </>
  );

  const mobileShell = (
    <div className="xl:hidden">
      <GameShell
        chip={
          <GameChip
            emblem={flag(p1)}
            title={`${p1} ${fmtScore(game?.match?.score)} ${p2}`}
            sub={streamState === "reconnecting" ? "reconnecting..." : status.replace(/_/g, " ") || "live"}
          />
        }
        resources={[
          { icon: "🏆", value: rank ? `#${rank}` : "—", title: "Rank" },
          { icon: "🐜", value: mine?.antsAlive ?? "—", title: "Ants alive" },
          { icon: "🍖", value: mine?.food ?? "—", title: "Food stores" },
        ]}
        nav={[
          { icon: "🏟️", label: "Room", onClick: () => router.push(game?.roomCode ? `/room/${game.roomCode}` : "/lobby") },
          { icon: "🏆", label: "Ranks", onClick: () => router.push(`/results/${id}`) },
        ]}
        cta={
          <button type="button" className={`g-cta ${openMarkets.length ? "rust" : ""}`} onClick={() => setSheetOpen((v) => !v)}>
            {sheetOpen ? "⛰️ View the map" : openMarkets.length ? `🎯 Markets · ${openMarkets.length} live` : "📊 Decision board"}
          </button>
        }
        sheetTitle="Decision board"
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        hint={selectedMarket ? undefined : RUNNING.has(status) ? "colony rings flash as your ants vote" : "drag to orbit · tap a mound"}
      >
        {status === "created" ? (
          <div className="flex flex-col gap-3 text-center">
            <p className="text-lg font-bold">Room is not live yet</p>
            <p className="text-sm text-ink-soft">Start the match from the room once every player has a colony.</p>
            <button className="btn btn-primary" onClick={() => router.push(game?.roomCode ? `/room/${game.roomCode}` : "/lobby")}>
              Back to room
            </button>
          </div>
        ) : (
          <>
            <p className="loop-strip">🐜 ants vote → 🎯 markets settle → 🍖 food feeds your mound → 🏆 richest colony wins</p>
            {colonyRail}
            {mobileTabs}
          </>
        )}
      </GameShell>
      {!sheetOpen && selectedMarket && (
        <button type="button" className="market-banner" onClick={() => setSheetOpen(true)}>
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
        <button className="icon-btn" aria-label="Back" onClick={() => router.push(game?.roomCode ? `/room/${game.roomCode}` : "/lobby")}>←</button>
        <div className="text-center">
          <h1 className="hud-title text-[13px]">Live cockpit</h1>
          <p className="text-xs text-ink-faint">{lastSyncAt ? `Synced ${formatClock(lastSyncAt)}` : "Syncing..."}</p>
        </div>
        <span className={`status-pill ${RUNNING.has(status) ? "!border-rust/50 !text-rust" : ""}`}>
          {RUNNING.has(status) && <span className="live-dot" />}
          {streamState === "reconnecting" ? "reconnect" : status === "created" ? "not started" : status.replace("_", " ") || "live"}
        </span>
      </header>

      <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(320px,0.82fr)_minmax(520px,1.2fr)_minmax(360px,0.95fr)] 2xl:grid-cols-[360px_minmax(580px,1fr)_430px]">
        <aside className="grid min-w-0 content-start gap-4">
          <section className="glass match-card-media flex min-w-0 flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="plate grid h-10 w-12 place-items-center text-xl">{flag(p1)}</span>
              <div className="min-w-0 flex-1 text-center">
                <p className="truncate text-sm font-bold text-ink-soft">{p1} vs {p2}</p>
                <p className="font-mono text-4xl font-bold text-gold">{fmtScore(game?.match?.score)}</p>
                <p className="truncate font-mono text-xs text-cyan">{game?.match?.possessionLabel || txlineStateLabel}</p>
              </div>
              <span className="plate grid h-10 w-12 place-items-center text-xl">{flag(p2)}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <PulseMetric label="Open" value={openMarkets.length} tone="gold" />
              <PulseMetric label="Settled" value={settledMarkets.length} tone="green" />
              <PulseMetric label="Events" value={game?.eventIndex ?? events[0]?.index ?? 0} />
            </div>
          </section>

          <RankCard mine={mine} rank={rank} spectator={!ownColony && Boolean(spectatorFallback)} />
          <RunStatusCard gameId={id} status={status} streamState={streamState} lastSyncAt={lastSyncAt} />
        </aside>

        <main className="grid min-w-0 content-start gap-4">
          {status === "created" ? (
            <section className="glass flex min-w-0 flex-col gap-3 p-5 text-center xl:min-h-[360px] xl:justify-center">
              <p className="eyebrow">Simulation dashboard</p>
              <h2 className="text-2xl font-bold">Room is not live yet</h2>
              <p className="mx-auto max-w-md text-sm text-ink-soft">Start the match from the room once every player has a colony.</p>
              <button className="btn btn-primary mx-auto !w-auto px-8" onClick={() => router.push(game?.roomCode ? `/room/${game.roomCode}` : "/lobby")}>
                Back to room
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
                  ralliedMarkets={ralliedMarkets}
                  switchedMarkets={switchedMarkets}
                  actionBusyKey={actionBusyKey}
                  onRally={handleRally}
                  onRecall={handleRecall}
                  onSwitch={handleSwitch}
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
                <FeedTab feedRows={feedRows} onOpenRanks={() => router.push(`/results/${id}`)} />
              )}

              <TacticsPanel gameId={id} colony={mine} anonId={anonId} onGame={setGame} push={push} />
            </section>
          )}
        </main>

        <aside className="grid min-w-0 content-start gap-4">
          <ColonyRoster colonies={sorted} activeColonyId={mine?.colonyId} onOpenRanks={() => router.push(`/results/${id}`)} />
          <EventStreamCard feedRows={aggregatedFeed.slice(0, 7)} onOpenFeed={() => setActiveTab("feed")} />
        </aside>
      </div>

      <footer className="flex items-center justify-between px-1 pb-2 text-xs font-bold text-ink-faint">
        <span>{streamState === "reconnecting" ? "Reconnecting stream..." : "Watching live"}</span>
        <button className="quiet-link" onClick={() => router.push(`/results/${id}`)}>Ranks</button>
      </footer>
    </div>
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
    <div className="seg sticky top-2 z-20 bg-[rgba(228,218,193,0.95)] backdrop-blur-md">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
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
  ralliedMarkets,
  switchedMarkets,
  actionBusyKey,
  onRally,
  onRecall,
  onSwitch,
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
  ralliedMarkets: Set<string>;
  switchedMarkets: Set<string>;
  actionBusyKey: string | null;
  onRally: (market: MarketModel) => void;
  onRecall: (market: MarketModel) => void;
  onSwitch: (market: MarketModel, optionId: string) => void;
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
              ralliedMarkets={ralliedMarkets}
              switchedMarkets={switchedMarkets}
              actionBusyKey={actionBusyKey}
              onRally={onRally}
              onRecall={onRecall}
              onSwitch={onSwitch}
            />
          )}
        </>
      ) : (
        <EmptyState
          title={waitingForKickoff ? "Waiting for kickoff" : "No market open"}
          body={waitingForKickoff ? `TXLine reports ${matchStateLabel}. Markets open once the match is live.` : "The next prediction window will appear here."}
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
                  {signedValue(summary.resourceDelta)}
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
  ralliedMarkets,
  switchedMarkets,
  actionBusyKey,
  onRally,
  onRecall,
  onSwitch,
}: {
  market: MarketModel;
  colony?: Colony;
  colonyLabel: string;
  ralliedMarkets: Set<string>;
  switchedMarkets: Set<string>;
  actionBusyKey: string | null;
  onRally: (market: MarketModel) => void;
  onRecall: (market: MarketModel) => void;
  onSwitch: (market: MarketModel, optionId: string) => void;
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

      {distribution.rows.length ? (
        <Distribution distribution={distribution} title="All colonies vote split" />
      ) : (
        <OptionPreview opportunity={market.opportunity} />
      )}

      <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold text-ink-faint">
        <span className="rounded-full bg-[rgba(176,126,28,0.14)] px-2 py-1 text-gold-deep">
          {distribution.total ? `${distribution.total} total ant votes` : "Waiting for ants"}
        </span>
        <span className="rounded-full bg-[rgba(74,58,30,0.1)] px-2 py-1">
          {market.votes.length}/{Math.max(1, market.starts.length || market.votes.length)} colonies reported
        </span>
        {pending > 0 && <span className="rounded-full bg-[rgba(74,58,30,0.1)] px-2 py-1">{pending} calls pending</span>}
      </div>

      <ActionBar
        market={market}
        colony={colony}
        ralliedMarkets={ralliedMarkets}
        switchedMarkets={switchedMarkets}
        actionBusyKey={actionBusyKey}
        onRally={onRally}
        onRecall={onRecall}
        onSwitch={onSwitch}
      />
    </article>
  );
}

// Job 1: the market action bar. Three mid-match verbs on top of an existing
// call — Rally piles on 5 more ants (one per market), Recall pulls up to 5
// back at any time (never below 1), Switch pivots the whole stake to a
// different option once per market. All three need a prediction to act on.
function ActionBar({
  market,
  colony,
  ralliedMarkets,
  switchedMarkets,
  actionBusyKey,
  onRally,
  onRecall,
  onSwitch,
}: {
  market: MarketModel;
  colony?: Colony;
  ralliedMarkets: Set<string>;
  switchedMarkets: Set<string>;
  actionBusyKey: string | null;
  onRally: (market: MarketModel) => void;
  onRecall: (market: MarketModel) => void;
  onSwitch: (market: MarketModel, optionId: string) => void;
}) {
  const [switchOpen, setSwitchOpen] = useState(false);
  if (!colony) return null;

  const isOpen = market.status === "open";
  const stake = colonyStake(market, colony.colonyId);
  const hasPrediction = Boolean(stake);
  const busy = (verb: "rally" | "recall" | "switch") => actionBusyKey === `${market.id}:${verb}`;
  const anyBusy = actionBusyKey !== null;

  const alreadyRallied = ralliedMarkets.has(market.id)
    || market.rallies.some((event) => String(event.data?.colonyId ?? "") === String(colony.colonyId));
  const canAffordRally = (colony.food ?? 0) >= 3;
  const rallyDisabled = !isOpen || !canAffordRally || alreadyRallied || anyBusy || !hasPrediction;

  const recallDisabled = !isOpen || !stake || stake.ants <= 1 || anyBusy;

  const alreadySwitched = switchedMarkets.has(market.id)
    || market.switches.some((event) => String(event.data?.colonyId ?? "") === String(colony.colonyId));
  const canAffordSwitch = (colony.food ?? 0) >= 2;
  const switchDisabled = !isOpen || !stake || alreadySwitched || !canAffordSwitch || anyBusy;

  const switchOptions = (market.opportunity?.options ?? []).filter(
    (option) => String(option.optionId ?? option.value ?? option.label ?? "") !== String(stake?.optionId ?? ""),
  );

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-[color:var(--brd-soft)] pt-3">
      <div className="well px-3 py-2">
        <p className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">Your stake</p>
        {stake ? (
          <p className="mt-1 text-sm font-bold text-ink">
            🐜 {stake.ants} ants on <span className="text-gold-deep">{cleanOutcomeLabel(stake.optionLabel)}</span>
          </p>
        ) : (
          <p className="mt-1 text-sm text-ink-faint">No position on this market yet.</p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          className="btn btn-primary px-2 py-2 text-xs sm:text-sm"
          disabled={rallyDisabled}
          onClick={() => onRally(market)}
        >
          {busy("rally") ? "..." : alreadyRallied ? "📣 Rallied" : "📣 Rally · −3🍖"}
        </button>
        <button
          type="button"
          className="btn px-2 py-2 text-xs sm:text-sm"
          disabled={recallDisabled}
          onClick={() => onRecall(market)}
        >
          {busy("recall") ? "..." : "🛡 Recall"}
        </button>
        <button
          type="button"
          className="btn px-2 py-2 text-xs sm:text-sm"
          disabled={switchDisabled}
          onClick={() => setSwitchOpen((open) => !open)}
        >
          {busy("switch") ? "..." : alreadySwitched ? "🔀 Pivoted" : "🔀 Switch · −2🍖"}
        </button>
      </div>

      {switchOpen && !switchDisabled && (
        <div className="flex flex-wrap gap-2 pt-1">
          {switchOptions.length ? (
            switchOptions.map((option) => (
              <button
                key={option.optionId || option.value || option.label}
                type="button"
                className="chip"
                onClick={() => {
                  onSwitch(market, String(option.optionId ?? option.value ?? ""));
                  setSwitchOpen(false);
                }}
              >
                {option.label || option.value}
              </button>
            ))
          ) : (
            <span className="text-[11px] text-ink-faint">No other option to pivot to.</span>
          )}
        </div>
      )}

      <p className="text-[11px] text-ink-faint">
        {!hasPrediction && isOpen && "Your ants haven't staked this market yet — actions unlock on their next call."}
        {hasPrediction && !canAffordRally && !alreadyRallied && " Not enough food to rally."}
      </p>
    </div>
  );
}

// Derives the colony's live position on a market from its raw event history:
// the initial prediction's ant count, plus every rally, minus every recall —
// and the current option, which is whatever the latest switch (if any) moved
// it to.
function colonyStake(market: MarketModel, colonyId?: string): { ants: number; optionId?: string; optionLabel: string } | null {
  if (!colonyId) return null;
  const predictionEvent = latestColonyEvent(market.predictions, colonyId);
  if (!predictionEvent) return null;
  const initialAnts = Number(eventData(predictionEvent)?.ants ?? 0);
  const rallyAnts = sumColonyAnts(market.rallies, colonyId);
  const recallAnts = sumColonyAnts(market.recalls, colonyId);
  const ants = Math.max(0, initialAnts + rallyAnts - recallAnts);

  const switchEvent = latestColonyEvent(market.switches, colonyId);
  const predictionOption = eventData(predictionEvent)?.option;
  if (switchEvent) {
    const optionId = typeof switchEvent.data?.optionId === "string" ? switchEvent.data.optionId : undefined;
    return { ants, optionId, optionLabel: optionLabelById(market.opportunity, optionId) ?? optionId ?? "unknown" };
  }
  const predictionOptionId = (predictionOption?.optionId ?? (predictionOption as { option_id?: string } | undefined)?.option_id) as string | undefined;
  return { ants, optionId: predictionOptionId, optionLabel: predictionOption?.label || predictionOptionId || "unknown" };
}

function sumColonyAnts(events: GameEvent[], colonyId: string) {
  return events
    .filter((event) => String(event.data?.colonyId ?? "") === String(colonyId))
    .reduce((sum, event) => sum + Number(event.data?.ants ?? 0), 0);
}

function optionLabelById(opportunity: Opportunity | undefined, optionId?: string) {
  if (!opportunity || !optionId) return undefined;
  const match = opportunity.options?.find((option) => option.optionId === optionId);
  return match?.label || match?.value;
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
          label="Resources"
          value={signedValue(summary.resourceDelta)}
          tone={summary.resourceDelta >= 0 ? "green" : undefined}
        />
        <PulseMetric label="Losses" value={summary.losses} />
        <PulseMetric label="Void" value={summary.voided} />
      </div>

      {distribution.rows.length > 0 && <Distribution distribution={distribution} title="All colonies vote split" />}

      <div className="mt-3 flex flex-col gap-1">
        {[...personalResultEvents(activity), ...market.settlements, ...market.voids]
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
        <DecisionCell label="Decision" value={decision.value} detail={decision.detail} tone={decision.tone} />
        <DecisionCell label="Committed" value={commit.value} detail={commit.detail} tone={commit.tone} />
        <DecisionCell label="Result" value={result.value} detail={result.detail} tone={result.cellTone} />
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

// Job 2: mid-match tactics. Steers the colony's *future* ant decisions
// (style/focus/risk appetite) via the engine's strategy PATCH — separate
// from a market action, it doesn't touch any single market's stake.
function TacticsPanel({
  gameId,
  colony,
  anonId,
  onGame,
  push,
}: {
  gameId: string;
  colony?: Colony;
  anonId: string;
  onGame: (game: GameState) => void;
  push: (text: string, tone?: "gain" | "loss" | "market" | "info") => void;
}) {
  const [busyField, setBusyField] = useState<null | "style" | "favoriteContext" | "infoNeed">(null);
  if (!colony) return null;

  async function apply(field: "style" | "favoriteContext" | "infoNeed", patch: StrategyPatch) {
    if (busyField) return;
    setBusyField(field);
    try {
      const g = await api.updateStrategy(gameId, colony!.colonyId, { ...patch, anonymousId: anonId });
      onGame(g);
      push("🎛️ Tactics updated — applies to your ants' next calls", "market");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Tactics update failed — try again.";
      push(message, "loss");
    } finally {
      setBusyField(null);
    }
  }

  return (
    <section className="well mt-1 flex flex-col gap-3 border-2 border-[color:var(--brd-soft)] p-3">
      <div>
        <p className="eyebrow">Tactics</p>
        <h3 className="text-sm font-bold">Tactics — steer your ants</h3>
      </div>
      <TacticsRow<Style>
        label="Strategy"
        options={["cautious", "balanced", "aggressive"] as const}
        value={colony.style}
        busy={busyField === "style"}
        onPick={(value) => apply("style", { style: value })}
      />
      <TacticsRow<FavoriteContext>
        label="Focus"
        options={["penalties", "corners", "momentum", "chaos", "balanced"] as const}
        value={colony.favoriteContext}
        busy={busyField === "favoriteContext"}
        onPick={(value) => apply("favoriteContext", { favoriteContext: value })}
      />
      <TacticsRow<InfoNeed>
        label="Risk appetite"
        options={["low", "medium", "high"] as const}
        value={colony.infoNeed}
        busy={busyField === "infoNeed"}
        onPick={(value) => apply("infoNeed", { infoNeed: value })}
      />
    </section>
  );
}

function TacticsRow<T extends string>({
  label,
  options,
  value,
  busy,
  onPick,
}: {
  label: string;
  options: readonly T[];
  value: T;
  busy: boolean;
  onPick: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] font-bold text-ink-faint">{label}</p>
      <div className="seg">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            data-active={value === option}
            disabled={busy}
            onClick={() => onPick(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function findOwnColony(game: GameState | null | undefined, anonId: string): Colony | undefined {
  if (!game || !anonId) return undefined;
  const player = (game.players ?? []).find((candidate) => candidate.anonymousId === anonId);
  return (game.colonies ?? []).find((colony) => (
    Boolean(player?.colonyId && colony.colonyId === player.colonyId)
    || colony.playerAnonymousId === anonId
    || Boolean(player?.playerId && colony.playerId === player.playerId)
  ));
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
    <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(3, options.length)}, minmax(0, 1fr))` }}>
      {options.slice(0, 3).map((option) => (
        <div key={option.optionId || option.label} className="well p-2 text-center text-xs font-bold text-ink-soft">
          {option.label || option.value}
        </div>
      ))}
    </div>
  );
}

function RankCard({ mine, rank, spectator }: { mine?: Colony; rank: number; spectator?: boolean }) {
  if (!mine) return <div className="glass p-4 text-center text-sm text-ink-faint">Create a colony to compete.</div>;
  return (
    <section className="glass grid min-w-0 grid-cols-3 gap-1 p-3 text-center">
      <Vital label="Rank" value={`#${rank}`} tone="gold" />
      <Vital label={spectator ? "Lead ants" : "My ants"} value={mine.antsAlive} />
      <Vital label="Resources" value={mine.food} tone="green" />
    </section>
  );
}

function ColonyRoster({
  colonies,
  activeColonyId,
  onOpenRanks,
}: {
  colonies: Colony[];
  activeColonyId?: string;
  onOpenRanks: () => void;
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

      <div className="grid max-h-[300px] gap-2 overflow-y-auto pr-1 xl:max-h-[calc(100dvh-390px)]">
        {colonies.map((colony, index) => {
          const active = colony.colonyId === activeColonyId;
          return (
            <div
              key={colony.colonyId}
              className={`rounded-md border-2 p-3 ${
                active
                  ? "border-[color:var(--color-gold)] bg-[rgba(249,243,226,0.96)] shadow-[2px_2px_0_rgba(90,70,30,0.4)]"
                  : "border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.7)]"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-sm font-bold text-gold">#{index + 1}</span>
                    <h3 className="truncate text-sm font-bold text-ink">{colony.name}</h3>
                  </div>
                  <p className="mt-1 truncate text-xs text-ink-faint">
                    {labelize(colony.style)} · {labelize(colony.favoriteContext)} · info {labelize(colony.infoNeed)}
                  </p>
                </div>
                {active && <span className="status-pill">active</span>}
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <MiniStat label="Score" value={Math.round(colony.score ?? 0)} tone="gold" />
                <MiniStat label="Ants" value={colony.antsAlive ?? 0} />
                <MiniStat label="Resources" value={colony.food ?? 0} tone="green" />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
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
  return String(value || "balanced").replace(/_/g, " ");
}

function Vital({ label, value, tone }: { label: string; value: number | string; tone?: "gold" | "green" }) {
  const color = tone === "gold" ? "text-gold" : tone === "green" ? "text-green" : "text-ink";
  return (
    <div className="border-r border-[color:var(--brd-soft)] last:border-r-0">
      <p className="text-[11px] font-bold text-ink-faint">{label}</p>
      <p className={`font-mono text-lg font-bold ${color}`}>{value}</p>
    </div>
  );
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
      settlements: [],
      voids: [],
      rallies: [],
      recalls: [],
      switches: [],
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
    if (event.kind === "settlement") market.settlements.push(event);
    if (event.kind === "void") market.voids.push(event);
    if (event.kind === "rally") market.rallies.push(event);
    if (event.kind === "recall") market.recalls.push(event);
    if (event.kind === "switch") market.switches.push(event);
  }

  return [...map.values()]
    .map((market) => {
      const marketStatus: MarketModel["status"] = activeIds.has(market.id)
        ? "open"
        : market.settlements.length
          ? "settled"
          : market.voids.length
            ? "void"
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
    resourceDelta += Number(event.data?.resourceDelta ?? event.data?.food ?? 0);
  }
  for (const event of market.voids) voided += Number(event.data?.ants ?? 0) || 1;

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
  if ((context === "next_foul" || label.includes("who commits the next foul")) && reason === "expired_no_foul") {
    return {
      label: "no foul before full time",
      detail: "The foul market expired without a qualifying foul.",
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
  if (reason === "expired_no_foul" || label.includes("who commits the next foul")) return "no foul before full time";
  if (reason === "full_time") return "voided at full time";
  return "market voided";
}

function colonyMarketActivity(market: MarketModel, colony?: Colony): ColonyMarketActivity {
  const colonyId = colony?.colonyId;
  const voteEvent = latestColonyEvent(market.votes, colonyId);
  const predictionEvent = latestColonyEvent(market.predictions, colonyId);
  const settlementEvent = latestColonyEvent(market.settlements, colonyId);
  const voidEvent = latestColonyEvent(market.voids, colonyId);
  const distribution = voteEvent ? aggregateVotes([voteEvent]) : { rows: [], total: 0, voters: 0 };
  const topVote = [...distribution.rows].sort((a, b) => b.count - a.count)[0];
  return { colony, voteEvent, predictionEvent, settlementEvent, voidEvent, distribution, topVote };
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
    return { value: "Observed", detail: "No ants voted", tone: "muted" as const };
  }
  const value = activity.topVote.key === "abstain" ? "Abstain" : activity.topVote.label;
  return {
    value,
    detail: `${activity.topVote.count}/${Math.max(1, activity.distribution.total)} ants`,
    tone: voteTone(activity.topVote.key),
  };
}

function colonyCommitSummary(activity: ColonyMarketActivity) {
  const prediction = eventData(activity.predictionEvent);
  const ants = Number(prediction?.ants ?? 0);
  const option = eventOptionLabel(activity.predictionEvent);
  if (activity.predictionEvent && ants > 0) {
    return {
      value: `${ants} ants`,
      detail: option ? `on ${option}` : "committed",
      tone: "gold" as const,
    };
  }
  if (activity.voteEvent) {
    return {
      value: "No commit",
      detail: activity.topVote?.key === "abstain" ? "the colony abstained" : "support stayed below threshold",
      tone: "muted" as const,
    };
  }
  return { value: "Waiting", detail: "no colony vote yet", tone: "muted" as const };
}

function colonyResultSummary(activity: ColonyMarketActivity, mode: "open" | "settled") {
  const settlement = eventData(activity.settlementEvent);
  const voided = eventData(activity.voidEvent);
  if (activity.settlementEvent) {
    const resourceDelta = Number(settlement?.resourceDelta ?? settlement?.food ?? 0);
    if (settlement?.win) {
      return {
        badge: "won",
        value: resourceDelta > 0 ? `${signedValue(resourceDelta)} resources` : "Won",
        detail: eventOptionLabel(activity.settlementEvent) || "resolved",
        tone: "!border-green/50 !text-green",
        cellTone: "green" as const,
      };
    }
    return {
      badge: "lost",
      value: resourceDelta < 0 ? `${signedValue(resourceDelta)} resources` : "Lost",
      detail: eventOptionLabel(activity.settlementEvent) || "resolved",
      tone: "!border-rust/50 !text-rust",
      cellTone: "rust" as const,
    };
  }
  if (activity.voidEvent) {
    const ants = Number(voided?.ants ?? 0);
    return {
      badge: "void",
      value: "Voided",
      detail: ants > 0 ? `${ants} ants released` : eventOptionLabel(activity.voidEvent) || "no result",
      tone: "!border-ink-faint/50 !text-ink-faint",
      cellTone: "muted" as const,
    };
  }
  if (mode === "open") {
    return {
      badge: "open",
      value: activity.predictionEvent ? "At risk" : "Pending",
      detail: activity.predictionEvent ? "waiting for result" : "no position yet",
      tone: "!border-gold/50 !text-gold",
      cellTone: activity.predictionEvent ? "gold" as const : "muted" as const,
    };
  }
  return {
    badge: "none",
    value: "No result",
    detail: "colony did not play",
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
        dead?: number;
        food?: number;
        larvae?: number;
        option?: { label?: string; optionId?: string };
        reason?: string;
        resourceDelta?: number;
        resourceLoss?: number;
        resolvedOutcome?: { label?: string; detail?: string };
        win?: boolean;
        wounded?: number;
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
  const vote = event.data?.vote as PublicVote | undefined;
  const marketId = (vote as { market?: { marketId?: unknown } } | undefined)?.market?.marketId;
  return typeof marketId === "string" ? marketId : undefined;
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
  if (clean.includes("commits the next foul")) return "Foul";
  if (clean.includes("scores the next goal")) return "Next goal";
  if (clean.includes("goal in the next 10")) return "Goal 10m";
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
  const message = event.message || event.kind;
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
  return ["opportunity", "settlement", "void", "hatch", "starvation", "rally", "recall", "switch", "game_error", "game_started", "markets_closed", "live_sync"].includes(e.kind) || isMatchEvent(e);
}

// Job 2: turn the raw event log into a legible, game-feeling stream.
// Folds consecutive same-kind-same-colony events (e.g. repeated starvation
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
    case "starvation": {
      const deaths = Number(data.deaths ?? 0);
      return { colonyId, colonyName, message, detail: "food shortage", delta: deaths ? { value: -deaths, unit: "ants" } : null };
    }
    case "settlement": {
      const food = Number(data.food ?? data.resourceDelta ?? 0);
      return { colonyId, colonyName, message, detail: option?.label ? `on ${option.label}` : null, delta: food ? { value: food, unit: "food" } : null };
    }
    case "hatch": {
      const hatched = Number(data.hatched ?? 0);
      return { colonyId, colonyName, message, detail: "hatched", delta: hatched ? { value: hatched, unit: "ants" } : null };
    }
    case "void": {
      return { colonyId, colonyName, message, detail: option?.label ? `voided · ${option.label}` : "voided", delta: null };
    }
    case "rally": {
      const ants = Number(data.ants ?? 0);
      const cost = Number(data.cost ?? 0);
      return { colonyId, colonyName, message, detail: cost ? `−${cost} food` : "rally", delta: ants ? { value: ants, unit: "ants" } : null };
    }
    case "recall": {
      const ants = Number(data.ants ?? 0);
      return { colonyId, colonyName, message, detail: "recalled", delta: ants ? { value: -ants, unit: "ants" } : null };
    }
    case "switch": {
      const pivotMatch = /pivots to (.+?) \(/.exec(message);
      return { colonyId, colonyName, message, detail: pivotMatch ? `pivoted to ${pivotMatch[1]}` : "pivoted", delta: null };
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
  const loses = message.match(/^(.+?)\s+loses\s+\d+\s+ants/);
  if (loses) return loses[1].trim();
  const colon = message.match(/^([^:]{2,40}):\s/);
  if (colon) return colon[1].trim();
  return null;
}

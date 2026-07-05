"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api, type ReplayFixture } from "@/lib/api";
import { useStore } from "@/store/game";
import { fixtureId, flag, fmtKickoffLine, fmtScore, teamName } from "@/lib/format";
import type { CreateColonyBody, FavoriteContext, GameState, InfoNeed, Style } from "@/lib/types";

const ADMIN_TOKEN_STORAGE_KEY = "aoc_admin_token";
const REPLAY_SPEED = { replayDelaySeconds: 0.8, replayTimeScale: 120 };
const STYLES: { value: Style; label: string }[] = [
  { value: "cautious", label: "Cautious" },
  { value: "balanced", label: "Balanced" },
  { value: "aggressive", label: "Aggressive" },
];
const GROUNDS: { value: FavoriteContext; label: string }[] = [
  { value: "penalties", label: "Penalties" },
  { value: "corners", label: "Corners" },
  { value: "momentum", label: "Momentum" },
  { value: "chaos", label: "Chaos" },
  { value: "balanced", label: "Balanced" },
];
const INFO_NEEDS: { value: InfoNeed; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];
const SIZES = [10, 20, 50] as const;
const DEFAULT_ADMIN_COLONIES = [
  { name: "Red Nest", size: 10, style: "cautious", favoriteContext: "penalties", infoNeed: "high" },
  { name: "Amber Swarm", size: 20, style: "balanced", favoriteContext: "momentum", infoNeed: "medium" },
  { name: "Black Rush", size: 50, style: "aggressive", favoriteContext: "chaos", infoNeed: "low" },
] satisfies AdminColonyDraft[];

type AdminColonyDraft = Omit<CreateColonyBody, "anonymousId">;

function freshDefaultColonies(): AdminColonyDraft[] {
  return DEFAULT_ADMIN_COLONIES.map((colony) => ({ ...colony }));
}

export default function AdminPage() {
  const router = useRouter();
  const resetGame = useStore((s) => s.resetGame);
  const setGame = useStore((s) => s.setGame);
  const setMatchFixture = useStore((s) => s.setMatchFixture);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [fixtures, setFixtures] = useState<ReplayFixture[]>([]);
  const [games, setGames] = useState<GameState[]>([]);
  const [draftGame, setDraftGame] = useState<GameState | null>(null);
  const [roomSetupKey, setRoomSetupKey] = useState("");
  const [selectedFixtureKey, setSelectedFixtureKey] = useState("");
  const [fixtureSearch, setFixtureSearch] = useState("");
  const [manualFixtureId, setManualFixtureId] = useState("");
  const [manualParticipant1, setManualParticipant1] = useState("Home");
  const [manualParticipant2, setManualParticipant2] = useState("Away");
  const [colonies, setColonies] = useState<AdminColonyDraft[]>(freshDefaultColonies);
  const [adminToken, setAdminToken] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "" : "",
  );
  const [msg, setMsg] = useState("");
  const [working, setWorking] = useState("");

  const protectedAdmin = Boolean(health?.adminToolsProtected);
  const requestToken = adminToken.trim();
  const canUseAdmin = !protectedAdmin || Boolean(requestToken);
  const tx = Boolean(health?.txlineConfigured);
  const or = Boolean(health?.openrouterConfigured);
  const selectedFixture = useMemo(
    () => fixtures.find((fixture) => String(fixtureId(fixture)) === selectedFixtureKey) ?? fixtures[0] ?? null,
    [fixtures, selectedFixtureKey],
  );
  const selectedFixtureId = selectedFixture ? String(fixtureId(selectedFixture)) : "";
  const validColonies = useMemo(
    () => colonies
      .map((colony) => ({ ...colony, name: colony.name.trim() }))
      .filter((colony) => colony.name),
    [colonies],
  );
  const setupKey = useMemo(
    () => selectedFixtureId ? `${selectedFixtureId}:${JSON.stringify(validColonies)}` : "",
    [selectedFixtureId, validColonies],
  );
  const roomIsCurrent = Boolean(draftGame && setupKey && roomSetupKey === setupKey);
  const roomNeedsRebuild = Boolean(draftGame && setupKey && roomSetupKey !== setupKey);
  const runningGames = games.filter((game) => ["running_replay", "running_live"].includes(game.status));
  const finishedGames = games.filter((game) => game.status === "finished");
  const workflowStep = roomIsCurrent ? 4 : draftGame ? 3 : validColonies.length ? 2 : selectedFixture ? 1 : 0;

  async function loadFixtures(token = requestToken, shouldProtect = protectedAdmin) {
    if (shouldProtect && !token) {
      setFixtures([]);
      return;
    }
    const data = await api.replayFixtures(
      {
        days: 90,
        limit: 24,
        scan_limit: 160,
        search: fixtureSearch.trim() || undefined,
      },
      token || undefined,
    );
    const list = data.fixtures ?? [];
    setFixtures(list);
    setSelectedFixtureKey((current) =>
      list.some((fixture) => String(fixtureId(fixture)) === current)
        ? current
        : list[0]
          ? String(fixtureId(list[0]))
          : "",
    );
  }

  async function loadGames(token = requestToken, shouldProtect = protectedAdmin) {
    if (shouldProtect && !token) {
      setGames([]);
      return;
    }
    const data = await api.adminGames(50, token || undefined);
    setGames(data.games ?? []);
  }

  async function refreshDashboard(token = requestToken, shouldProtect = protectedAdmin) {
    if (shouldProtect && !token) {
      setMsg("Enter the admin token to load the simulation dashboard.");
      return;
    }
    setWorking("refresh");
    try {
      await Promise.all([loadFixtures(token, shouldProtect), loadGames(token, shouldProtect)]);
      setMsg("");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking("");
    }
  }

  useEffect(() => {
    let cancelled = false;

    api.health()
      .then((h) => {
        if (cancelled) return;
        setHealth(h);
        const shouldProtect = Boolean(h.adminToolsProtected);
        if (!shouldProtect || requestToken) refreshDashboard(requestToken, shouldProtect);
      })
      .catch((e) => {
        if (!cancelled) setMsg((e as Error).message);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveToken() {
    const token = adminToken.trim();
    if (typeof window !== "undefined") localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    refreshDashboard(token, protectedAdmin);
  }

  function updateColony(index: number, patch: Partial<AdminColonyDraft>) {
    setColonies((current) => current.map((colony, i) => (i === index ? { ...colony, ...patch } : colony)));
  }

  function addColony() {
    setColonies((current) => [
      ...current,
      {
        name: `Scout Nest ${current.length + 1}`,
        size: 20,
        style: "balanced",
        favoriteContext: "momentum",
        infoNeed: "medium",
      },
    ]);
  }

  function removeColony(index: number) {
    setColonies((current) => current.filter((_, i) => i !== index));
  }

  async function createAdminRoom() {
    if (!selectedFixture) return setMsg("Select a replayable match first.");
    if (!validColonies.length) return setMsg("Add at least one admin colony.");
    setWorking("create-room");
    setMsg("Creating the admin room...");
    try {
      const room = await createRoomWithColonies(selectedFixture, validColonies);
      setDraftGame(room);
      setRoomSetupKey(setupKey);
      setGame(room);
      setMatchFixture(selectedFixture);
      await loadGames();
      setMsg(`Room ready for ${matchTitle(room)} with ${room.colonies.length} colonies.`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking("");
    }
  }

  async function startDraftReplay() {
    if (!draftGame || !selectedFixture || !roomIsCurrent) {
      return setMsg("Create a room with the current match and colonies before launching.");
    }
    setWorking("launch");
    setMsg("Launching the replay simulation...");
    try {
      const started = await api.startGame(draftGame.gameId, "replay", {
        ...REPLAY_SPEED,
        adminToken: requestToken || undefined,
      });
      resetGame();
      setGame(started);
      setMatchFixture(selectedFixture);
      router.push(`/cockpit/${started.gameId}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking("");
    }
  }

  async function findLatestAndStart() {
    if (!validColonies.length) return setMsg("Add at least one admin colony.");
    setWorking("latest");
    setMsg("Searching for the latest completed fixture with score data...");
    try {
      const game = await api.runPrevious({
        days: 90,
        limit: 160,
        stream: true,
        colonies: validColonies,
        ...REPLAY_SPEED,
      }, requestToken || undefined);
      resetGame();
      setGame(game);
      router.push(`/cockpit/${game.gameId}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking("");
    }
  }

  async function launchManualFixture() {
    const cleanId = manualFixtureId.trim();
    if (!cleanId) return setMsg("Enter a TXLine fixture id.");
    if (!validColonies.length) return setMsg("Add at least one admin colony.");
    const fixture: ReplayFixture = {
      fixtureId: Number.isFinite(Number(cleanId)) ? Number(cleanId) : cleanId,
      participant1: manualParticipant1.trim() || "Home",
      participant2: manualParticipant2.trim() || "Away",
      competition: "Manual admin fixture",
    };
    setWorking("manual");
    setMsg("Creating manual replay room...");
    try {
      const room = await createRoomWithColonies(fixture, validColonies);
      const started = await api.startGame(room.gameId, "replay", {
        ...REPLAY_SPEED,
        adminToken: requestToken || undefined,
      });
      resetGame();
      setGame(started);
      router.push(`/cockpit/${started.gameId}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking("");
    }
  }

  async function rerunGame(game: GameState) {
    setWorking(`rerun-${game.gameId}`);
    setMsg(`Rerunning ${matchTitle(game)}...`);
    try {
      const replay = await api.rerun(game.gameId, requestToken || undefined, REPLAY_SPEED);
      resetGame();
      setGame(replay);
      router.push(`/cockpit/${replay.gameId}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking("");
    }
  }

  async function runDemo() {
    setWorking("demo");
    setMsg("Starting demo sandbox...");
    try {
      const game = await api.demoRun({}, requestToken || undefined);
      resetGame();
      setGame(game);
      router.push(`/cockpit/${game.gameId}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking("");
    }
  }

  async function createRoomWithColonies(fixture: ReplayFixture, colonyDrafts: AdminColonyDraft[]): Promise<GameState> {
    const id = fixtureId(fixture);
    if (!id) throw new Error("Fixture has no id.");
    const created = await api.createGame({
      fixtureId: id,
      participant1: fixture.participant1 ?? null,
      participant2: fixture.participant2 ?? null,
      competition: fixture.competition ?? null,
      startTime: fixture.startTime ?? null,
      startTimeIso: fixture.startTimeIso ?? null,
    });
    let room = created;
    for (const colony of colonyDrafts) {
      room = await api.addColony(created.gameId, colony, requestToken || undefined);
    }
    return room;
  }

  if (protectedAdmin && !canUseAdmin) {
    return (
      <div className="relative left-1/2 flex w-[min(1120px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-4 pb-6">
        <AdminHeader working={working} canUseAdmin={false} onRefresh={() => refreshDashboard()} />
        <section className="glass grid gap-6 p-6 lg:grid-cols-[1fr_360px]">
          <div className="flex min-h-[320px] flex-col justify-between">
            <div>
              <p className="eyebrow">Admin access</p>
              <h1 className="mt-3 max-w-3xl text-4xl font-bold leading-tight">Unlock the simulation dashboard</h1>
              <p className="mt-4 max-w-2xl text-base text-ink-soft">
                The replay tools are private. Enter the admin token once to load previous matches, create rooms, configure colonies, and launch simulations.
              </p>
            </div>
            <div className="mt-8 grid gap-3 sm:grid-cols-[1fr_auto]">
              <input
                className="input font-mono"
                placeholder="AOC_ADMIN_TOKEN"
                type="password"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveToken();
                }}
              />
              <button className="btn btn-primary !w-auto px-8" onClick={saveToken}>Unlock</button>
            </div>
          </div>
          <div className="grid content-start gap-3 sm:grid-cols-2 lg:grid-cols-1">
            <Kpi label="TXLine" value={tx ? "Online" : "Missing"} tone={tx ? "good" : "bad"} />
            <Kpi label="OpenRouter" value={or ? "Online" : "Missing"} tone={or ? "good" : "bad"} />
            <Kpi label="Fixtures" value="Locked" />
          </div>
        </section>
        {msg && <Message text={msg} />}
      </div>
    );
  }

  return (
    <div className="relative left-1/2 flex w-[min(1500px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-4 pb-6">
      <AdminHeader working={working} canUseAdmin={canUseAdmin} onRefresh={() => refreshDashboard()} />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Kpi label="TXLine" value={tx ? "Online" : "Missing"} tone={tx ? "good" : "bad"} />
        <Kpi label="OpenRouter" value={or ? "Online" : "Missing"} tone={or ? "good" : "bad"} />
        <Kpi label="Replayable matches" value={fixtures.length} />
        <Kpi label="Rooms" value={games.length} />
        <Kpi label="Running" value={runningGames.length} tone={runningGames.length ? "warn" : "neutral"} />
      </section>

      {msg && <Message text={msg} />}

      <section className="glass p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PanelTitle eyebrow="Simulation workflow" title="Build one replay room" />
          <span className="status-pill">Step {workflowStep}/4</span>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(380px,0.75fr)]">
          <div className="grid min-w-0 gap-4">
            <StepCard
              number="1"
              title="Select a previous match"
              status={selectedFixture ? "Selected" : fixtures.length ? "Choose one" : "No match loaded"}
            >
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <input
                  className="input"
                  placeholder="Search team, competition, fixture id"
                  value={fixtureSearch}
                  onChange={(e) => setFixtureSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") loadFixtures();
                  }}
                />
                <button
                  className="btn btn-ghost !min-h-0 !w-auto px-4 py-2 text-sm"
                  disabled={Boolean(working)}
                  onClick={() => loadFixtures()}
                >
                  Load matches
                </button>
              </div>

              <div className="mt-4 grid max-h-[520px] gap-2 overflow-y-auto pr-1">
                {fixtures.map((fixture) => {
                  const key = String(fixtureId(fixture));
                  const selected = key === selectedFixtureId;
                  return (
                    <button
                      key={key}
                      className={`rounded-md border p-3 text-left transition ${
                        selected
                          ? "border-lime/50 bg-lime/10"
                          : "border-[color:var(--brd-soft)] bg-black/20 hover:border-gold/50"
                      }`}
                      onClick={() => setSelectedFixtureKey(key)}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <FixtureTeams fixture={fixture} />
                        <span className="status-pill">{fixture.eventCount ?? 0} events</span>
                      </div>
                      <div className="mt-3 grid gap-2 text-xs text-ink-faint md:grid-cols-[1fr_auto_auto]">
                        <span className="truncate">{fixture.competition ?? "Completed fixture"}</span>
                        <span>{fmtKickoffLine(fixture.startTime, fixture.startTimeIso)}</span>
                        <span className="font-mono uppercase text-gold">{fixture.source ?? "replay"}</span>
                      </div>
                    </button>
                  );
                })}

                {!fixtures.length && (
                  <EmptyPanel
                    title="No replayable matches loaded"
                    text="Load matches to scan recent TXLine fixtures that have replay data. If TXLine returns empty, the fallback actions stay below."
                  >
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      <button className="btn btn-primary !min-h-0 py-2 text-sm" disabled={Boolean(working)} onClick={findLatestAndStart}>
                        Find latest and launch
                      </button>
                      <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={Boolean(working)} onClick={runDemo}>
                        Run demo sandbox
                      </button>
                    </div>
                  </EmptyPanel>
                )}
              </div>
            </StepCard>

            <StepCard number="2" title="Set admin colonies" status={`${validColonies.length} active`}>
              <div className="grid gap-3">
                {colonies.map((colony, index) => (
                  <div key={index} className="rounded-md border border-[color:var(--brd-soft)] bg-black/20 p-3">
                    <div className="grid gap-3 lg:grid-cols-[minmax(180px,1.2fr)_90px_140px_140px_120px_auto]">
                      <Field label="Name">
                        <input
                          className="input !px-3 !py-2 text-sm"
                          value={colony.name}
                          maxLength={40}
                          onChange={(e) => updateColony(index, { name: e.target.value })}
                        />
                      </Field>
                      <Field label="Size">
                        <select
                          className="input !px-3 !py-2 text-sm"
                          value={colony.size}
                          onChange={(e) => updateColony(index, { size: Number(e.target.value) })}
                        >
                          {SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                        </select>
                      </Field>
                      <Field label="Style">
                        <select
                          className="input !px-3 !py-2 text-sm"
                          value={colony.style}
                          onChange={(e) => updateColony(index, { style: e.target.value as Style })}
                        >
                          {STYLES.map((style) => <option key={style.value} value={style.value}>{style.label}</option>)}
                        </select>
                      </Field>
                      <Field label="Focus">
                        <select
                          className="input !px-3 !py-2 text-sm"
                          value={colony.favoriteContext}
                          onChange={(e) => updateColony(index, { favoriteContext: e.target.value as FavoriteContext })}
                        >
                          {GROUNDS.map((ground) => <option key={ground.value} value={ground.value}>{ground.label}</option>)}
                        </select>
                      </Field>
                      <Field label="Info">
                        <select
                          className="input !px-3 !py-2 text-sm"
                          value={colony.infoNeed}
                          onChange={(e) => updateColony(index, { infoNeed: e.target.value as InfoNeed })}
                        >
                          {INFO_NEEDS.map((need) => <option key={need.value} value={need.value}>{need.label}</option>)}
                        </select>
                      </Field>
                      <div className="flex items-end">
                        <button
                          className="btn btn-ghost !min-h-0 !w-full px-3 py-2 text-sm lg:!w-auto"
                          disabled={colonies.length <= 1}
                          onClick={() => removeColony(index)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={addColony}>Add colony</button>
                <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={() => setColonies(freshDefaultColonies())}>Reset defaults</button>
              </div>
            </StepCard>
          </div>

          <div className="grid min-w-0 content-start gap-4">
            <StepCard number="3" title="Create the room" status={roomIsCurrent ? "Ready" : roomNeedsRebuild ? "Needs rebuild" : "Waiting"}>
              {selectedFixture ? <SelectedFixture fixture={selectedFixture} /> : <EmptyPanel title="No match selected" text="Pick a replayable match first." />}

              <div className="mt-4 rounded-md border border-[color:var(--brd-soft)] bg-black/20 p-3">
                <p className="text-sm font-bold text-ink-soft">Room state</p>
                <p className="mt-2 text-lg font-bold text-ink">
                  {roomIsCurrent ? "Admin room ready" : roomNeedsRebuild ? "Current setup changed" : "No room created yet"}
                </p>
                <p className="mt-1 text-sm text-ink-faint">
                  {roomIsCurrent && draftGame
                    ? `${draftGame.colonies.length} colonies are attached. No room code is needed for this admin simulation.`
                    : roomNeedsRebuild
                      ? "Recreate the room so the selected match and colonies match what will launch."
                      : "Create the room after choosing a match and colonies."}
                </p>
              </div>

              <button
                className="btn btn-primary mt-4"
                disabled={Boolean(working) || !selectedFixture || !validColonies.length || roomIsCurrent}
                onClick={createAdminRoom}
              >
                {working === "create-room"
                  ? "Creating room..."
                  : roomNeedsRebuild
                    ? "Recreate room"
                    : roomIsCurrent
                      ? "Room ready"
                      : "Create room"}
              </button>
            </StepCard>

            <StepCard number="4" title="Launch simulation" status={roomIsCurrent ? "Ready to launch" : "Locked"}>
              <div className="rounded-md border border-[color:var(--brd-soft)] bg-black/20 p-4">
                <p className="text-sm text-ink-soft">
                  {roomIsCurrent
                    ? "The next click starts the replay stream and opens the cockpit for this room."
                    : "Create a room with the current match and colonies to unlock launch."}
                </p>
                {draftGame && (
                  <p className="mt-3 font-mono text-xs text-ink-faint">
                    Game {draftGame.gameId}
                  </p>
                )}
              </div>

              <div className="mt-4 grid gap-2">
                <button className="btn btn-primary" disabled={Boolean(working) || !roomIsCurrent} onClick={startDraftReplay}>
                  {working === "launch" ? "Launching..." : "Launch simulation"}
                </button>
                <button
                  className="btn btn-ghost !min-h-0 py-2 text-sm"
                  disabled={!draftGame}
                  onClick={() => draftGame && router.push(`/cockpit/${draftGame.gameId}`)}
                >
                  Open room cockpit
                </button>
              </div>
            </StepCard>

            <details className="rounded-md border border-[color:var(--brd-soft)] bg-black/20 p-4">
              <summary className="cursor-pointer text-sm font-bold text-ink-soft">Fallback tools</summary>
              <div className="mt-4 grid gap-3">
                <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={Boolean(working)} onClick={findLatestAndStart}>
                  Find latest and launch
                </button>
                <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={Boolean(working)} onClick={runDemo}>
                  Run demo sandbox
                </button>
                <div className="grid gap-2 border-t border-[color:var(--brd-soft)] pt-3">
                  <input
                    className="input font-mono"
                    inputMode="numeric"
                    placeholder="TXLine fixture id"
                    value={manualFixtureId}
                    onChange={(e) => setManualFixtureId(e.target.value)}
                  />
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input className="input" placeholder="Participant 1" value={manualParticipant1} onChange={(e) => setManualParticipant1(e.target.value)} />
                    <input className="input" placeholder="Participant 2" value={manualParticipant2} onChange={(e) => setManualParticipant2(e.target.value)} />
                  </div>
                  <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={Boolean(working) || !manualFixtureId.trim()} onClick={launchManualFixture}>
                    Launch manual fixture
                  </button>
                </div>
              </div>
            </details>

            {protectedAdmin && (
              <details className="rounded-md border border-[color:var(--brd-soft)] bg-black/20 p-4">
                <summary className="cursor-pointer text-sm font-bold text-ink-soft">Admin token</summary>
                <div className="mt-3 grid gap-2">
                  <input
                    className="input font-mono"
                    placeholder="AOC_ADMIN_TOKEN"
                    type="password"
                    value={adminToken}
                    onChange={(e) => setAdminToken(e.target.value)}
                  />
                  <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={saveToken}>Update token</button>
                </div>
              </details>
            )}
          </div>
        </div>
      </section>

      <section className="glass flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PanelTitle eyebrow="Runs" title="Simulation history" />
          <div className="flex gap-2">
            <span className="status-pill">{runningGames.length} running</span>
            <span className="status-pill">{finishedGames.length} finished</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-separate border-spacing-y-2 text-left">
            <thead className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
              <tr>
                <th className="px-3 py-1">Run</th>
                <th className="px-3 py-1">Status</th>
                <th className="px-3 py-1">Score</th>
                <th className="px-3 py-1">Colonies</th>
                <th className="px-3 py-1">Events</th>
                <th className="px-3 py-1 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {games.slice(0, 14).map((game) => (
                <tr key={game.gameId} className="bg-black/20">
                  <td className="rounded-l-md px-3 py-3">
                    <strong>{matchTitle(game)}</strong>
                    <p className="font-mono text-[11px] text-ink-faint">{game.gameId}</p>
                  </td>
                  <td className="px-3 py-3"><span className={`status-pill ${game.status === "finished" ? "!border-lime/40 !text-lime" : ""}`}>{game.status.replace("_", " ")}</span></td>
                  <td className="px-3 py-3 font-mono text-sm">{fmtScore(game.match?.score)}</td>
                  <td className="px-3 py-3 text-sm">{game.colonies.length}</td>
                  <td className="px-3 py-3 text-sm">{game.eventIndex ?? 0}</td>
                  <td className="rounded-r-md px-3 py-3">
                    <div className="flex justify-end gap-2">
                      <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-2 text-sm" onClick={() => router.push(`/cockpit/${game.gameId}`)}>Open</button>
                      <button className="btn btn-primary !min-h-0 !w-auto px-3 py-2 text-sm" disabled={Boolean(working)} onClick={() => rerunGame(game)}>
                        {working === `rerun-${game.gameId}` ? "Rerunning..." : "Rerun"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!games.length && <EmptyPanel title="No simulations yet" text="Create a room and launch it to populate this history." />}
        </div>
      </section>
    </div>
  );
}

function AdminHeader({ working, canUseAdmin, onRefresh }: { working: string; canUseAdmin: boolean; onRefresh: () => void }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <p className="eyebrow">Age of Colony admin</p>
        <h1 className="text-3xl font-bold leading-tight md:text-4xl">Simulation dashboard</h1>
      </div>
      <button className="btn btn-ghost !min-h-0 !w-auto px-4 py-2 text-sm" disabled={!canUseAdmin || working === "refresh"} onClick={onRefresh}>
        Refresh data
      </button>
    </header>
  );
}

function StepCard({ number, title, status, children }: { number: string; title: string; status: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border border-[color:var(--brd)] bg-black/20 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md border border-gold/50 bg-gold/10 font-mono text-sm font-bold text-gold">
            {number}
          </span>
          <h2 className="text-xl font-bold leading-tight">{title}</h2>
        </div>
        <span className="status-pill">{status}</span>
      </div>
      {children}
    </section>
  );
}

function PanelTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="text-xl font-bold leading-tight">{title}</h2>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-2">
      <span className="text-xs font-bold uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

function Kpi({ label, value, tone = "neutral" }: { label: string; value: ReactNode; tone?: "neutral" | "good" | "bad" | "warn" }) {
  const toneClass = tone === "good" ? "text-lime" : tone === "bad" ? "text-danger" : tone === "warn" ? "text-gold" : "text-ink";
  return (
    <div className="glass p-4">
      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">{label}</p>
      <strong className={`mt-2 block text-2xl ${toneClass}`}>{value}</strong>
    </div>
  );
}

function SelectedFixture({ fixture }: { fixture: ReplayFixture }) {
  return (
    <div className="rounded-md border border-lime/30 bg-lime/10 p-4">
      <FixtureTeams fixture={fixture} />
      <div className="mt-3 grid gap-2 text-sm text-ink-soft">
        <span className="truncate">{fixture.competition ?? "Completed fixture"}</span>
        <span>{fmtKickoffLine(fixture.startTime, fixture.startTimeIso)}</span>
        <span className="font-mono text-xs uppercase text-gold">{fixture.eventCount ?? 0} events · {fixture.source ?? "replay"}</span>
      </div>
    </div>
  );
}

function FixtureTeams({ fixture }: { fixture: ReplayFixture }) {
  const p1 = teamName(fixture.participant1);
  const p2 = teamName(fixture.participant2);
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
      <div className="flex min-w-0 items-center gap-2 font-bold">
        <span className="text-xl">{flag(p1)}</span>
        <span className="truncate">{p1}</span>
      </div>
      <span className="font-mono text-[10px] font-bold text-gold">VS</span>
      <div className="flex min-w-0 flex-row-reverse items-center gap-2 text-right font-bold">
        <span className="text-xl">{flag(p2)}</span>
        <span className="truncate">{p2}</span>
      </div>
    </div>
  );
}

function EmptyPanel({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-dashed border-[color:var(--brd-soft)] bg-black/10 p-6 text-center">
      <h3 className="font-bold text-ink">{title}</h3>
      <p className="mt-2 text-sm text-ink-faint">{text}</p>
      {children}
    </div>
  );
}

function Message({ text }: { text: string }) {
  return (
    <p className="min-w-0 break-words rounded-md border border-[color:var(--brd-soft)] bg-black/30 px-3 py-2 text-sm text-ink-soft">{text}</p>
  );
}

function matchTitle(game: GameState): string {
  return `${teamName(game.participant1, "Participant 1")} vs ${teamName(game.participant2, "Participant 2")}`;
}

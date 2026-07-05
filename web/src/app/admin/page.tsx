"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/store/game";
import { fixtureId, flag, fmtKickoffLine, fmtScore, teamName } from "@/lib/format";
import type { CreateColonyBody, FavoriteContext, Fixture, GameState, InfoNeed, Style } from "@/lib/types";

const ADMIN_TOKEN_STORAGE_KEY = "aoc_admin_token";
const REPLAY_SPEED = { replayDelaySeconds: 0.8, replayTimeScale: 120 };
const STYLES: { value: Style; label: string }[] = [
  { value: "cautious", label: "Cautious" },
  { value: "balanced", label: "Balanced" },
  { value: "aggressive", label: "Aggressive" },
];
const GROUNDS: FavoriteContext[] = ["penalties", "corners", "momentum", "chaos", "balanced"];
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
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [games, setGames] = useState<GameState[]>([]);
  const [draftGame, setDraftGame] = useState<GameState | null>(null);
  const [selectedFixtureKey, setSelectedFixtureKey] = useState("");
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
  const validColonies = colonies.filter((colony) => colony.name.trim());
  const runningGames = games.filter((game) => ["running_replay", "running_live"].includes(game.status));
  const finishedGames = games.filter((game) => game.status === "finished");

  async function loadFixtures(token = requestToken, shouldProtect = protectedAdmin) {
    if (shouldProtect && !token) {
      setFixtures([]);
      return;
    }
    const data = await api.recentFixtures({ days: 14, limit: 40 }, token || undefined);
    const list = data.fixtures ?? [];
    setFixtures(list);
    setSelectedFixtureKey((current) => current || (list[0] ? String(fixtureId(list[0])) : ""));
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

  async function createAdminRoom(fixture: Fixture | null = selectedFixture) {
    if (!fixture) return setMsg("No completed fixture selected.");
    if (!validColonies.length) return setMsg("Add at least one admin colony.");
    setWorking("create-room");
    setMsg("Creating admin room...");
    try {
      const room = await createRoomWithColonies(fixture);
      setDraftGame(room);
      setGame(room);
      await loadGames();
      setMsg(`Admin room ready for ${matchTitle(room)}. No room code needed.`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking("");
    }
  }

  async function launchSimulation(fixture: Fixture | null = selectedFixture) {
    if (!fixture) return setMsg("No completed fixture selected.");
    if (!validColonies.length) return setMsg("Add at least one admin colony.");
    setWorking("launch");
    setMsg("Building admin simulation...");
    try {
      const room = await createRoomWithColonies(fixture);
      const started = await api.startGame(room.gameId, "replay", {
        ...REPLAY_SPEED,
        adminToken: requestToken || undefined,
      });
      resetGame();
      setGame(started);
      setMatchFixture(fixture);
      router.push(`/cockpit/${started.gameId}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking("");
    }
  }

  async function startDraftReplay() {
    if (!draftGame) return;
    setWorking("start-draft");
    setMsg("Starting replay...");
    try {
      const started = await api.startGame(draftGame.gameId, "replay", {
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
    setMsg("Starting demo...");
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

  async function createRoomWithColonies(fixture: Fixture): Promise<GameState> {
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
    for (const colony of validColonies) {
      room = await api.addColony(created.gameId, { ...colony, name: colony.name.trim() }, requestToken || undefined);
    }
    return room;
  }

  return (
    <div className="flex flex-col gap-4 pb-6">
      <header className="page-top">
        <div>
          <p className="eyebrow">Debug cockpit</p>
          <h1 className="text-2xl font-bold">Admin simulation dashboard</h1>
        </div>
        <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-2 text-sm" disabled={!canUseAdmin || working === "refresh"} onClick={() => refreshDashboard()}>
          Refresh
        </button>
      </header>

      <section className="glass bracket p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill label="TXLine" ok={tx} />
          <StatusPill label="OpenRouter" ok={or} />
          {protectedAdmin && <span className="status-pill">Admin locked</span>}
          <span className="status-pill">{fixtures.length} fixtures</span>
          <span className="status-pill">{games.length} runs</span>
        </div>
        {health && !or && <p className="mt-3 text-xs text-ink-faint">Set OPENROUTER_API_KEY to start replay simulations.</p>}
      </section>

      {protectedAdmin && (
        <section className="glass flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="hud-title text-[12px]">Admin access</h2>
            <span className={`status-pill ${canUseAdmin ? "!border-lime/40 !text-lime" : ""}`}>{canUseAdmin ? "Unlocked" : "Locked"}</span>
          </div>
          <div className="flex gap-2">
            <input
              className="input font-mono"
              placeholder="AOC_ADMIN_TOKEN"
              type="password"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
            />
            <button className="btn btn-primary !w-auto shrink-0 px-5" onClick={saveToken}>Unlock</button>
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(320px,430px)_1fr]">
        <section className="glass flex flex-col gap-4 p-4">
          <div>
            <p className="eyebrow">Simulation builder</p>
            <h2 className="text-xl font-bold">Create a room without codes</h2>
          </div>

          <Field label="Replay fixture">
            <select
              className="input"
              disabled={!canUseAdmin || !fixtures.length}
              value={selectedFixture ? String(fixtureId(selectedFixture)) : ""}
              onChange={(e) => setSelectedFixtureKey(e.target.value)}
            >
              {fixtures.map((fixture) => (
                <option key={String(fixtureId(fixture))} value={String(fixtureId(fixture))}>
                  {teamName(fixture.participant1)} vs {teamName(fixture.participant2)}
                </option>
              ))}
            </select>
          </Field>

          {selectedFixture ? <FixturePlate fixture={selectedFixture} /> : <p className="text-sm text-ink-faint">Load recent fixtures to select a completed match.</p>}

          <div className="grid gap-2 sm:grid-cols-2">
            <button className="btn btn-primary" disabled={!canUseAdmin || Boolean(working)} onClick={() => launchSimulation()}>
              Create and start replay
            </button>
            <button className="btn btn-ghost" disabled={!canUseAdmin || Boolean(working)} onClick={() => createAdminRoom()}>
              Create admin room
            </button>
          </div>
          <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={!canUseAdmin || Boolean(working)} onClick={runDemo}>
            Run demo sandbox
          </button>
        </section>

        <section className="glass flex flex-col gap-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="eyebrow">Colonies</p>
              <h2 className="text-xl font-bold">Admin-only colony set</h2>
            </div>
            <span className="status-pill">{validColonies.length} active</span>
          </div>

          <div className="flex flex-col gap-3">
            {colonies.map((colony, index) => (
              <div key={index} className="grid gap-2 border-b border-[color:var(--brd-soft)] pb-3 last:border-0 last:pb-0 md:grid-cols-[1.2fr_0.8fr_0.9fr_0.9fr_0.8fr_auto]">
                <input className="input" value={colony.name} maxLength={40} onChange={(e) => updateColony(index, { name: e.target.value })} />
                <select className="input" value={colony.size} onChange={(e) => updateColony(index, { size: Number(e.target.value) })}>
                  {SIZES.map((size) => <option key={size} value={size}>{size} ants</option>)}
                </select>
                <select className="input" value={colony.style} onChange={(e) => updateColony(index, { style: e.target.value as Style })}>
                  {STYLES.map((style) => <option key={style.value} value={style.value}>{style.label}</option>)}
                </select>
                <select className="input" value={colony.favoriteContext} onChange={(e) => updateColony(index, { favoriteContext: e.target.value as FavoriteContext })}>
                  {GROUNDS.map((ground) => <option key={ground} value={ground}>{ground}</option>)}
                </select>
                <select className="input" value={colony.infoNeed} onChange={(e) => updateColony(index, { infoNeed: e.target.value as InfoNeed })}>
                  {INFO_NEEDS.map((need) => <option key={need.value} value={need.value}>{need.label}</option>)}
                </select>
                <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-2 text-sm" disabled={colonies.length <= 1} onClick={() => removeColony(index)}>
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={addColony}>Add colony</button>
            <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={() => setColonies(freshDefaultColonies())}>Reset defaults</button>
          </div>
        </section>
      </div>

      {draftGame && (
        <section className="glass flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="eyebrow">Room ready</p>
              <h2 className="text-xl font-bold">{matchTitle(draftGame)}</h2>
              <p className="text-sm text-ink-faint">{draftGame.colonies.length} admin colonies · {draftGame.status}</p>
            </div>
            <div className="flex w-full gap-2 sm:w-auto">
              <button className="btn btn-primary !min-h-0 py-2 text-sm" disabled={Boolean(working)} onClick={startDraftReplay}>Start replay</button>
              <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={() => router.push(`/cockpit/${draftGame.gameId}`)}>Open cockpit</button>
            </div>
          </div>
        </section>
      )}

      {msg && <p className="rounded-lg border border-[color:var(--brd-soft)] bg-black/20 px-3 py-2 text-sm text-ink-soft">{msg}</p>}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="eyebrow">Fixtures</p>
            <h2 className="text-xl font-bold">Completed matches</h2>
          </div>
          <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-2 text-sm" disabled={!canUseAdmin || working === "refresh"} onClick={() => loadFixtures()}>
            Reload
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {fixtures.slice(0, 12).map((fixture) => {
            const key = String(fixtureId(fixture));
            const selected = key === selectedFixtureKey || (!selectedFixtureKey && fixture === selectedFixture);
            return (
              <button
                key={key}
                className={`glass flex flex-col gap-3 p-4 text-left ${selected ? "!border-lime/50" : ""}`}
                disabled={!canUseAdmin || Boolean(working)}
                onClick={() => setSelectedFixtureKey(key)}
              >
                <FixtureTeams fixture={fixture} />
                <div className="grid gap-2 sm:grid-cols-2">
                  <span className="status-pill">{selected ? "Selected" : "Use fixture"}</span>
                  <button
                    className="btn btn-primary !min-h-0 py-2 text-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      launchSimulation(fixture);
                    }}
                  >
                    Start simulation
                  </button>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="eyebrow">Runs</p>
            <h2 className="text-xl font-bold">Simulation history</h2>
          </div>
          <div className="flex gap-2">
            <span className="status-pill">{runningGames.length} running</span>
            <span className="status-pill">{finishedGames.length} finished</span>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {games.slice(0, 12).map((game) => (
            <div key={game.gameId} className="glass flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold">{matchTitle(game)}</h3>
                  <p className="font-mono text-xs text-ink-faint">{game.gameId}</p>
                </div>
                <span className={`status-pill ${game.status === "finished" ? "!border-lime/40 !text-lime" : ""}`}>{game.status.replace("_", " ")}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-sm">
                <Metric label="Score" value={fmtScore(game.match?.score)} />
                <Metric label="Colonies" value={game.colonies.length} />
                <Metric label="Events" value={game.eventIndex ?? 0} />
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={() => router.push(`/cockpit/${game.gameId}`)}>Open cockpit</button>
                <button className="btn btn-primary !min-h-0 py-2 text-sm" disabled={!canUseAdmin || Boolean(working)} onClick={() => rerunGame(game)}>
                  {working === `rerun-${game.gameId}` ? "Rerunning..." : "Rerun"}
                </button>
              </div>
            </div>
          ))}
          {!games.length && (
            <div className="glass p-4 text-sm text-ink-faint">No admin simulations loaded yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-bold text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function StatusPill({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className={`rounded-full border px-3 py-1 text-xs font-bold ${ok ? "border-lime/40 text-lime" : "border-danger/40 text-danger"}`}>
      {label} {ok ? "OK" : "Missing"}
    </span>
  );
}

function FixturePlate({ fixture }: { fixture: Fixture }) {
  return (
    <div className="rounded-md border border-[color:var(--brd-soft)] bg-black/20 p-3">
      <FixtureTeams fixture={fixture} />
      <p className="mt-2 truncate text-xs text-ink-faint">{fixture.competition ?? "Completed fixture"} · {fmtKickoffLine(fixture.startTime, fixture.startTimeIso)}</p>
    </div>
  );
}

function FixtureTeams({ fixture }: { fixture: Fixture }) {
  const p1 = teamName(fixture.participant1);
  const p2 = teamName(fixture.participant2);
  return (
    <div className="flex items-center justify-between gap-2">
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

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[color:var(--brd-soft)] bg-black/20 px-2 py-2">
      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">{label}</p>
      <strong className="text-sm text-ink">{value}</strong>
    </div>
  );
}

function matchTitle(game: GameState): string {
  return `${teamName(game.participant1, "Participant 1")} vs ${teamName(game.participant2, "Participant 2")}`;
}

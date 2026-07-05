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

  if (protectedAdmin && !canUseAdmin) {
    return (
      <div className="relative left-1/2 flex w-[min(1180px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-4 pb-6">
        <AdminHeader working={working} canUseAdmin={false} onRefresh={() => refreshDashboard()} />
        <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="glass bracket flex min-h-[430px] flex-col justify-between p-6">
            <div>
              <p className="eyebrow">Operator lock</p>
              <h1 className="mt-3 text-4xl font-bold leading-tight">Unlock the simulation console</h1>
              <p className="mt-4 max-w-2xl text-base text-ink-soft">
                Admin replay tools are protected on this environment. Enter the token once to load fixtures, runs, colony presets, and direct replay controls.
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
              <button className="btn btn-primary !w-auto px-8" onClick={saveToken}>Unlock dashboard</button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            <Kpi label="TXLine" value={tx ? "Online" : "Missing"} tone={tx ? "good" : "bad"} />
            <Kpi label="OpenRouter" value={or ? "Online" : "Missing"} tone={or ? "good" : "bad"} />
            <Kpi label="Fixtures" value="Locked" />
            <Kpi label="Runs" value="Locked" />
          </div>
        </section>
        {msg && <Message text={msg} />}
      </div>
    );
  }

  return (
    <div className="relative left-1/2 flex w-[min(1440px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-4 pb-6">
      <AdminHeader working={working} canUseAdmin={canUseAdmin} onRefresh={() => refreshDashboard()} />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Kpi label="TXLine" value={tx ? "Online" : "Missing"} tone={tx ? "good" : "bad"} />
        <Kpi label="OpenRouter" value={or ? "Online" : "Missing"} tone={or ? "good" : "bad"} />
        <Kpi label="Fixtures" value={fixtures.length} />
        <Kpi label="Runs" value={games.length} />
        <Kpi label="Running" value={runningGames.length} tone={runningGames.length ? "warn" : "neutral"} />
        <Kpi label="Finished" value={finishedGames.length} tone="good" />
      </section>

      <section className="grid gap-4 xl:grid-cols-[360px_minmax(520px,1fr)_420px]">
        <aside className="glass flex flex-col gap-4 p-4">
          <PanelTitle eyebrow="Command rail" title="Build and launch" />

          <Field label="Replay fixture">
            <select
              className="input"
              disabled={!fixtures.length}
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

          {selectedFixture ? <SelectedFixture fixture={selectedFixture} /> : <EmptyPanel title="No fixture loaded" text="Refresh after unlocking to load completed TXLine matches." />}

          <div className="grid gap-2">
            <button className="btn btn-primary" disabled={Boolean(working) || !selectedFixture} onClick={() => launchSimulation()}>
              Create and start replay
            </button>
            <button className="btn btn-ghost" disabled={Boolean(working) || !selectedFixture} onClick={() => createAdminRoom()}>
              Create room only
            </button>
            <button className="btn btn-ghost !min-h-0 py-2 text-sm" disabled={Boolean(working)} onClick={runDemo}>
              Run demo sandbox
            </button>
          </div>

          {draftGame && (
            <div className="rounded-md border border-lime/30 bg-lime/10 p-3">
              <p className="eyebrow !text-lime">Room ready</p>
              <h3 className="mt-1 font-bold">{matchTitle(draftGame)}</h3>
              <p className="mt-1 text-xs text-ink-faint">{draftGame.colonies.length} colonies · {draftGame.status}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                <button className="btn btn-primary !min-h-0 py-2 text-sm" disabled={Boolean(working)} onClick={startDraftReplay}>Start replay</button>
                <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={() => router.push(`/cockpit/${draftGame.gameId}`)}>Open cockpit</button>
              </div>
            </div>
          )}

          {protectedAdmin && (
            <details className="rounded-md border border-[color:var(--brd-soft)] bg-black/20 p-3">
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
        </aside>

        <main className="flex flex-col gap-4">
          <section className="glass flex min-h-[460px] flex-col gap-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <PanelTitle eyebrow="Fixtures" title="Completed matches" />
              <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-2 text-sm" disabled={working === "refresh"} onClick={() => loadFixtures()}>
                Reload fixtures
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-separate border-spacing-y-2 text-left">
                <thead className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                  <tr>
                    <th className="px-3 py-1">Match</th>
                    <th className="px-3 py-1">Competition</th>
                    <th className="px-3 py-1">Kickoff</th>
                    <th className="px-3 py-1 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {fixtures.slice(0, 16).map((fixture) => {
                    const key = String(fixtureId(fixture));
                    const selected = key === String(fixtureId(selectedFixture ?? {} as Fixture));
                    return (
                      <tr key={key} className={`bg-black/20 ${selected ? "outline outline-2 outline-lime/40" : ""}`}>
                        <td className="rounded-l-md px-3 py-3"><FixtureTeams fixture={fixture} /></td>
                        <td className="max-w-[220px] truncate px-3 py-3 text-sm text-ink-soft">{fixture.competition ?? "Completed fixture"}</td>
                        <td className="px-3 py-3 text-sm text-ink-faint">{fmtKickoffLine(fixture.startTime, fixture.startTimeIso)}</td>
                        <td className="rounded-r-md px-3 py-3">
                          <div className="flex justify-end gap-2">
                            <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-2 text-sm" disabled={Boolean(working)} onClick={() => setSelectedFixtureKey(key)}>Select</button>
                            <button className="btn btn-primary !min-h-0 !w-auto px-3 py-2 text-sm" disabled={Boolean(working)} onClick={() => launchSimulation(fixture)}>Start</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!fixtures.length && <EmptyPanel title="No fixtures loaded" text="Refresh after unlocking, or check TXLine credentials." />}
            </div>
          </section>
        </main>

        <aside className="glass flex flex-col gap-4 p-4">
          <div className="flex items-start justify-between gap-3">
            <PanelTitle eyebrow="Colonies" title="Simulation roster" />
            <span className="status-pill">{validColonies.length} active</span>
          </div>

          <div className="overflow-x-auto xl:overflow-visible">
            <table className="w-full min-w-[620px] xl:min-w-0 border-separate border-spacing-y-2 text-left">
              <thead className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                <tr>
                  <th className="px-2 py-1">Name</th>
                  <th className="px-2 py-1">Size</th>
                  <th className="px-2 py-1">Style</th>
                  <th className="px-2 py-1">Focus</th>
                  <th className="px-2 py-1">Info</th>
                  <th className="px-2 py-1" />
                </tr>
              </thead>
              <tbody>
                {colonies.map((colony, index) => (
                  <tr key={index} className="bg-black/20">
                    <td className="rounded-l-md p-2">
                      <input className="input !px-2 !py-2 text-sm" value={colony.name} maxLength={40} onChange={(e) => updateColony(index, { name: e.target.value })} />
                    </td>
                    <td className="p-2">
                      <select className="input !px-2 !py-2 text-sm" value={colony.size} onChange={(e) => updateColony(index, { size: Number(e.target.value) })}>
                        {SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                      </select>
                    </td>
                    <td className="p-2">
                      <select className="input !px-2 !py-2 text-sm" value={colony.style} onChange={(e) => updateColony(index, { style: e.target.value as Style })}>
                        {STYLES.map((style) => <option key={style.value} value={style.value}>{style.label}</option>)}
                      </select>
                    </td>
                    <td className="p-2">
                      <select className="input !px-2 !py-2 text-sm" value={colony.favoriteContext} onChange={(e) => updateColony(index, { favoriteContext: e.target.value as FavoriteContext })}>
                        {GROUNDS.map((ground) => <option key={ground} value={ground}>{ground}</option>)}
                      </select>
                    </td>
                    <td className="p-2">
                      <select className="input !px-2 !py-2 text-sm" value={colony.infoNeed} onChange={(e) => updateColony(index, { infoNeed: e.target.value as InfoNeed })}>
                        {INFO_NEEDS.map((need) => <option key={need.value} value={need.value}>{need.label}</option>)}
                      </select>
                    </td>
                    <td className="rounded-r-md p-2">
                      <button className="btn btn-ghost !min-h-0 !w-auto px-3 py-2 text-sm" disabled={colonies.length <= 1} onClick={() => removeColony(index)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={addColony}>Add colony</button>
            <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={() => setColonies(freshDefaultColonies())}>Reset defaults</button>
          </div>
        </aside>
      </section>

      {msg && <Message text={msg} />}

      <section className="glass flex flex-col gap-4 p-4">
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
          {!games.length && <EmptyPanel title="No simulations yet" text="Create and start a replay to populate this run ledger." />}
        </div>
      </section>
    </div>
  );
}

function AdminHeader({ working, canUseAdmin, onRefresh }: { working: string; canUseAdmin: boolean; onRefresh: () => void }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <p className="eyebrow">Age of Colony control room</p>
        <h1 className="text-3xl font-bold leading-tight md:text-4xl">Admin simulation dashboard</h1>
      </div>
      <button className="btn btn-ghost !min-h-0 !w-auto px-4 py-2 text-sm" disabled={!canUseAdmin || working === "refresh"} onClick={onRefresh}>
        Refresh data
      </button>
    </header>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-bold text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function Kpi({ label, value, tone = "neutral" }: { label: string; value: React.ReactNode; tone?: "neutral" | "good" | "bad" | "warn" }) {
  const toneClass = tone === "good" ? "text-lime" : tone === "bad" ? "text-danger" : tone === "warn" ? "text-gold" : "text-ink";
  return (
    <div className="glass p-4">
      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">{label}</p>
      <strong className={`mt-2 block text-2xl ${toneClass}`}>{value}</strong>
    </div>
  );
}

function SelectedFixture({ fixture }: { fixture: Fixture }) {
  return (
    <div className="rounded-md border border-[color:var(--brd-soft)] bg-black/20 p-3">
      <FixtureTeams fixture={fixture} />
      <p className="mt-3 truncate text-xs text-ink-faint">{fixture.competition ?? "Completed fixture"}</p>
      <p className="mt-1 text-xs text-ink-faint">{fmtKickoffLine(fixture.startTime, fixture.startTimeIso)}</p>
    </div>
  );
}

function FixtureTeams({ fixture }: { fixture: Fixture }) {
  const p1 = teamName(fixture.participant1);
  const p2 = teamName(fixture.participant2);
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
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

function EmptyPanel({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-md border border-dashed border-[color:var(--brd-soft)] bg-black/10 p-6 text-center">
      <h3 className="font-bold text-ink">{title}</h3>
      <p className="mt-2 text-sm text-ink-faint">{text}</p>
    </div>
  );
}

function Message({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-[color:var(--brd-soft)] bg-black/30 px-3 py-2 text-sm text-ink-soft">{text}</p>
  );
}

function matchTitle(game: GameState): string {
  return `${teamName(game.participant1, "Participant 1")} vs ${teamName(game.participant2, "Participant 2")}`;
}

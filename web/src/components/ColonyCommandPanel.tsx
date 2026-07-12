"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  FOCUS_OPTIONS,
  INFO_NEED_OPTIONS,
  STYLE_OPTIONS,
  isStrategyEditableStatus,
  strategySummary,
  type StrategyOption,
} from "@/lib/strategy";
import type {
  Ant,
  AntBet,
  AntDetailResponse,
  AntStrategyPatch,
  Colony,
  ColonyAntsResponse,
  ColonyStrategy,
  GameState,
} from "@/lib/types";

export interface ColonyCommandPanelProps {
  gameId: string;
  status: string;
  colony: Colony;
  anonymousId: string;
  onGameChange: (game: GameState) => void;
  initialScope?: CommandScope;
  expandedByDefault?: boolean;
  onRequestClose?: () => void;
}

type CommandScope = "colony" | "ants";
const EMPTY_ANTS: Ant[] = [];

export function ColonyCommandPanel(props: ColonyCommandPanelProps) {
  const identity = `${props.gameId}:${props.colony.colonyId}`;
  return <ColonyCommandPanelState key={identity} {...props} />;
}

function ColonyCommandPanelState({
  gameId,
  status,
  colony,
  anonymousId,
  onGameChange,
  initialScope = "ants",
  expandedByDefault = false,
  onRequestClose,
}: ColonyCommandPanelProps) {
  const disclosureId = useId();
  const requestSequence = useRef(0);
  const detailRequestSequence = useRef(0);
  const selectedAntIdRef = useRef<string | null>(null);
  const editable = isStrategyEditableStatus(status);
  const [expanded, setExpanded] = useState(expandedByDefault);
  const [scope, setScope] = useState<CommandScope>(initialScope);
  const [roster, setRoster] = useState<ColonyAntsResponse | null>(null);
  const [loadingAnts, setLoadingAnts] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [globalError, setGlobalError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [query, setQuery] = useState("");
  const [overridesOnly, setOverridesOnly] = useState(false);
  const [selectedAntId, setSelectedAntId] = useState<string | null>(null);
  const [selectedAntView, setSelectedAntView] = useState<"history" | "strategy">("strategy");
  const [antDetail, setAntDetail] = useState<AntDetailResponse | null>(null);
  const [loadingAntDetail, setLoadingAntDetail] = useState(false);
  const [antDetailError, setAntDetailError] = useState("");
  const [globalDraft, setGlobalDraft] = useState<ColonyStrategy>(() => strategyFromColony(colony));

  const currentGlobal = roster?.globalStrategy ?? strategyFromColony(colony);
  const globalDirty = !sameStrategy(globalDraft, currentGlobal);
  const ants = roster?.ants ?? EMPTY_ANTS;
  const customCount = ants.filter((ant) => !ant.strategy.inheritsGlobal).length;
  const selectedAnt = ants.find((ant) => ant.antId === selectedAntId) ?? null;
  const visibleAnts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return ants.filter((ant) => {
      if (overridesOnly && ant.strategy.inheritsGlobal) return false;
      if (!needle) return true;
      return [ant.antId, ant.archetype, ant.naturalFocus, ant.strategy.favoriteContext]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [ants, overridesOnly, query]);

  const loadAnts = useCallback(async (silent = false) => {
    const requestId = ++requestSequence.current;
    if (!silent) setLoadingAnts(true);
    setLoadError("");
    try {
      const next = await api.getColonyAnts(gameId, colony.colonyId, anonymousId);
      if (requestId !== requestSequence.current) return;
      setRoster(next);
    } catch (error) {
      if (requestId === requestSequence.current) setLoadError(errorMessage(error));
    } finally {
      if (requestId === requestSequence.current && !silent) setLoadingAnts(false);
    }
  }, [anonymousId, colony.colonyId, gameId]);

  const loadAntDetail = useCallback(async (antId: string, silent = false) => {
    const requestId = ++detailRequestSequence.current;
    if (!silent) setLoadingAntDetail(true);
    setAntDetailError("");
    try {
      const detail = await api.getAntDetail(gameId, colony.colonyId, antId, anonymousId);
      if (requestId !== detailRequestSequence.current) return;
      setAntDetail(detail);
      setRoster((current) => current && ({
        ...current,
        strategyRevision: detail.strategyRevision,
        ants: current.ants.map((candidate) => candidate.antId === detail.ant.antId ? detail.ant : candidate),
      }));
    } catch (error) {
      if (requestId === detailRequestSequence.current) setAntDetailError(errorMessage(error));
    } finally {
      if (requestId === detailRequestSequence.current && !silent) setLoadingAntDetail(false);
    }
  }, [anonymousId, colony.colonyId, gameId]);

  useEffect(() => {
    if (!expanded || scope !== "ants" || !selectedAntId) return;
    const interval = window.setInterval(() => {
      void loadAntDetail(selectedAntId, true);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [expanded, loadAntDetail, scope, selectedAntId]);

  useEffect(() => {
    if (!expanded || scope !== "ants") return;
    if (!roster) {
      const timer = window.setTimeout(() => void loadAnts(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [expanded, loadAnts, roster, scope]);

  useEffect(() => {
    if (!expanded || scope !== "ants" || !roster) return;
    const interval = window.setInterval(() => {
      void loadAnts(true);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [expanded, loadAnts, roster, scope]);

  function openScope(nextScope: CommandScope) {
    setScope(nextScope);
    setExpanded(true);
    if (nextScope === "ants" && !roster && !loadingAnts) void loadAnts();
  }

  function selectAnt(antId: string | null) {
    selectedAntIdRef.current = antId;
    setSelectedAntId(antId);
  }

  function toggleExpanded() {
    if (expanded) {
      if (onRequestClose) {
        onRequestClose();
        return;
      }
      setExpanded(false);
      selectAnt(null);
      setAntDetail(null);
      detailRequestSequence.current += 1;
      return;
    }
    openScope(initialScope);
  }

  async function saveGlobalStrategy() {
    if (!editable || !globalDirty) return;
    setSavingGlobal(true);
    setGlobalError("");
    setAnnouncement("");
    try {
      const game = await api.updateStrategy(gameId, colony.colonyId, {
        ...globalDraft,
        anonymousId,
      });
      onGameChange(game);
      const savedColony = game.colonies.find((candidate) => candidate.colonyId === colony.colonyId);
      if (savedColony) {
        const savedStrategy = strategyFromColony(savedColony);
        setGlobalDraft(savedStrategy);
        setRoster((current) => current && ({
          ...current,
          globalStrategy: savedStrategy,
          strategyRevision: savedColony.strategyRevision ?? current.strategyRevision,
        }));
      }
      setAnnouncement("Colony orders saved. They apply to the next market.");
      void loadAnts();
    } catch (error) {
      setGlobalError(errorMessage(error));
    } finally {
      setSavingGlobal(false);
    }
  }

  async function saveAntStrategy(ant: Ant, patch: AntStrategyPatch) {
    // Invalidate any roster/detail reads that started before this mutation so
    // a slower poll cannot paint the previous strategy over the saved one.
    requestSequence.current += 1;
    detailRequestSequence.current += 1;
    setLoadingAntDetail(false);
    const result = await api.updateAntStrategy(gameId, colony.colonyId, ant.antId, {
      ...patch,
      anonymousId,
    });
    // A polling request may have started while the PATCH was in flight.
    requestSequence.current += 1;
    if (selectedAntIdRef.current === ant.antId) {
      detailRequestSequence.current += 1;
      setLoadingAntDetail(false);
    }
    setRoster((current) => current && ({
      ...current,
      strategyRevision: result.strategyRevision,
      ants: current.ants.map((candidate) => candidate.antId === result.ant.antId ? result.ant : candidate),
    }));
    setAntDetail((current) => current && current.ant.antId === result.ant.antId ? {
      ...current,
      ant: result.ant,
      strategyRevision: result.strategyRevision,
    } : current);
    setAnnouncement(`${antLabel(ant)} orders saved. They apply to the next market.`);
    if (selectedAntIdRef.current === ant.antId) void loadAntDetail(ant.antId, true);
    void api.getGame(gameId).then(onGameChange).catch(() => {});
  }

  return (
    <section className="colony-command-panel glass relative flex min-w-0 flex-col gap-3 p-3" aria-labelledby={`${disclosureId}-title`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Your colony</p>
          <h2 id={`${disclosureId}-title`} className="truncate text-base font-bold">Control {colony.name}</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-faint">
            Change the whole colony or choose one ant. New orders apply to the next market.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`status-pill ${editable ? "!border-green/50 !text-green" : ""}`}>
            {editable ? "Live changes" : "Read-only"}
          </span>
          <button
            type="button"
            className="quiet-link min-h-11 rounded-md px-2 text-sm"
            aria-expanded={expanded}
            aria-controls={disclosureId}
            onClick={toggleExpanded}
          >
            {expanded ? "Close" : "Manage"}
          </button>
        </div>
      </div>

      {!expanded && (
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            className="well group grid min-h-24 gap-1 p-3 text-left transition hover:border-gold/60 focus-visible:border-gold"
            onClick={() => openScope("colony")}
          >
            <span className="text-lg" aria-hidden="true">👑</span>
            <strong className="text-sm">Colony strategy</strong>
            <span className="truncate text-xs text-ink-faint">{strategySummary(strategyFromColony(colony))}</span>
          </button>
          <button
            type="button"
            className="well group grid min-h-24 gap-1 p-3 text-left transition hover:border-gold/60 focus-visible:border-gold"
            onClick={() => openScope("ants")}
          >
            <span className="text-lg" aria-hidden="true">🐜</span>
            <strong className="text-sm">My ants</strong>
            <span className="text-xs text-ink-faint">{colony.antsAlive} alive · select one to change its orders</span>
          </button>
        </div>
      )}

      {announcement && (
        <div aria-live="polite" aria-atomic="true">
          <InlineNotice message={announcement} />
        </div>
      )}

      {expanded && (
        <div id={disclosureId} className="colony-command-disclosure grid gap-4 border-t-2 border-[color:var(--brd-soft)] pt-3">
          <div className="seg" role="tablist" aria-label="Colony command scope">
            <button
              type="button"
              role="tab"
              aria-selected={scope === "ants"}
              data-active={scope === "ants"}
              onClick={() => openScope("ants")}
            >
              🐜 My ants{roster ? ` · ${roster.ants.length}` : ""}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === "colony"}
              data-active={scope === "colony"}
              onClick={() => openScope("colony")}
            >
              👑 Colony strategy
            </button>
          </div>

          {scope === "colony" && (
            <section className="well grid gap-3 p-3" role="tabpanel" aria-labelledby={`${disclosureId}-global-title`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="eyebrow">Default orders</p>
                  <h3 id={`${disclosureId}-global-title`} className="font-bold">Whole colony</h3>
                </div>
                <span className="status-pill !border-green/50 !text-green">Next market</span>
              </div>
              <p className="text-xs leading-relaxed text-ink-faint">
                Ants set to follow the colony inherit these orders. Ants with a custom strategy keep their own orders.
              </p>

              <ChoiceButtons
                legend="Temper"
                options={STYLE_OPTIONS}
                value={globalDraft.style}
                onChange={(style) => setGlobalDraft((current) => ({ ...current, style }))}
                disabled={!editable || savingGlobal}
                descriptionId={`${disclosureId}-style-help`}
              />

              <ChoiceChips
                legend="Focus"
                options={FOCUS_OPTIONS}
                value={globalDraft.favoriteContext}
                onChange={(favoriteContext) => setGlobalDraft((current) => ({ ...current, favoriteContext }))}
                disabled={!editable || savingGlobal}
                descriptionId={`${disclosureId}-focus-help`}
              />

              <ChoiceButtons
                legend="Info appetite"
                options={INFO_NEED_OPTIONS}
                value={globalDraft.infoNeed}
                onChange={(infoNeed) => setGlobalDraft((current) => ({ ...current, infoNeed }))}
                disabled={!editable || savingGlobal}
                descriptionId={`${disclosureId}-info-help`}
              />
              <p className="text-[11px] leading-relaxed text-ink-faint">
                Paid intel is not active yet; this order is retained for future information tools.
              </p>

              {globalError && <InlineError message={globalError} />}
              {!editable && <InlineNotice message="This match is finished. Orders are now read-only." />}

              <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
                <button
                  type="button"
                  className="btn btn-ghost !min-h-11 px-3 py-2 text-sm"
                  disabled={!globalDirty || savingGlobal}
                  onClick={() => setGlobalDraft(currentGlobal)}
                >
                  Reset changes
                </button>
                <button
                  type="button"
                  className="btn btn-primary !min-h-11 px-3 py-2 text-sm"
                  disabled={!editable || !globalDirty || savingGlobal}
                  aria-busy={savingGlobal}
                  onClick={saveGlobalStrategy}
                >
                  {savingGlobal ? "Saving orders..." : "Save for next market"}
                </button>
              </div>
            </section>
          )}

          {scope === "ants" && (
            <section className="grid min-w-0 gap-3" role="tabpanel" aria-labelledby={`${disclosureId}-ants-title`}>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="eyebrow">Individual control</p>
                  <h3 id={`${disclosureId}-ants-title`} className="font-bold">My ants</h3>
                  {roster && (
                    <p className="mt-1 text-xs text-ink-faint">
                      {roster.ants.length - customCount} follow colony · {customCount} custom
                    </p>
                  )}
                </div>
                {roster && <span className="status-pill">{roster.ants.filter((ant) => ant.alive).length} alive</span>}
              </div>

              {loadingAnts && !roster ? (
                <div className="well grid min-h-24 place-items-center p-4 text-sm text-ink-faint" role="status">
                  Gathering your ants...
                </div>
              ) : loadError && !roster ? (
                <div className="well grid gap-3 p-3">
                  <InlineError message={loadError} />
                  <button type="button" className="btn btn-ghost !min-h-11 py-2 text-sm" onClick={() => void loadAnts()}>
                    Retry roster
                  </button>
                </div>
              ) : roster ? (
                <div className="command-ant-workspace grid min-w-0 gap-3 xl:grid-cols-[minmax(250px,0.72fr)_minmax(0,1.28fr)]">
                  <div className={`${selectedAnt ? "hidden xl:grid" : "grid"} min-w-0 content-start gap-3`}>
                    <div className="grid gap-2 sm:grid-cols-[1fr_auto] xl:grid-cols-1">
                      <label>
                        <span className="sr-only">Search ants</span>
                        <input
                          className="input !py-2 text-sm"
                          type="search"
                          placeholder="Search ant or archetype"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                        />
                      </label>
                      <label className="well flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm font-bold text-ink-soft">
                        <input
                          type="checkbox"
                          checked={overridesOnly}
                          onChange={(event) => setOverridesOnly(event.target.checked)}
                        />
                        Custom strategies only
                      </label>
                    </div>

                    <ul className="grid gap-2 pr-1 xl:max-h-[600px] xl:overflow-y-auto" aria-label="Ant strategy roster">
                      {visibleAnts.map((ant) => {
                        const selected = selectedAntId === ant.antId;
                        return (
                          <li key={ant.antId} className={`well overflow-hidden ${selected ? "!border-gold bg-gold/10" : ""}`}>
                            <button
                              type="button"
                              className="grid min-h-14 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left"
                              aria-current={selected ? "true" : undefined}
                              aria-label={`Manage ${antLabel(ant)}`}
                              onClick={() => {
                                selectAnt(ant.antId);
                                setSelectedAntView("strategy");
                                setAntDetail(null);
                                void loadAntDetail(ant.antId);
                              }}
                            >
                              <AntStatus status={ant.status} />
                              <span className="min-w-0">
                                <span className="flex min-w-0 items-center gap-2">
                                  <strong className="truncate text-sm">{antLabel(ant)}</strong>
                                  {!ant.strategy.inheritsGlobal && <span className="status-pill !px-2 !py-0.5">custom</span>}
                                </span>
                                <span className="mt-1 block truncate text-xs text-ink-faint">
                                  {strategySummary(ant.strategy)} · {performanceLabel(ant)}
                                </span>
                              </span>
                              <span className="font-mono text-sm font-bold text-gold-deep" aria-hidden="true">→</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>

                    {visibleAnts.length === 0 && (
                      <div className="well p-4 text-center text-sm text-ink-faint">No ants match this filter.</div>
                    )}
                    {loadError && <InlineNotice message={`Roster refresh failed: ${loadError}`} />}
                  </div>

                  <div className={`${selectedAnt ? "grid" : "hidden xl:grid"} min-w-0 content-start gap-3`}>
                    {selectedAnt ? (
                      <>
                        <button
                          type="button"
                          className="quiet-link min-h-11 w-fit rounded-md px-2 text-sm xl:hidden"
                          onClick={() => {
                            selectAnt(null);
                            setAntDetail(null);
                            setAntDetailError("");
                            detailRequestSequence.current += 1;
                          }}
                        >
                          ← Back to my ants
                        </button>
                        <AntDetailPanel
                          id={`${disclosureId}-${selectedAnt.antId}-detail`}
                          ant={selectedAnt}
                          detail={antDetail?.ant.antId === selectedAnt.antId ? antDetail : null}
                          loading={loadingAntDetail}
                          error={antDetailError}
                          view={selectedAntView}
                          globalStrategy={roster.globalStrategy}
                          disabled={!editable || !selectedAnt.alive}
                          onViewChange={setSelectedAntView}
                          onRefresh={() => loadAntDetail(selectedAnt.antId)}
                          onSave={(patch) => saveAntStrategy(selectedAnt, patch)}
                        />
                      </>
                    ) : (
                      <div className="well grid min-h-64 place-items-center p-6 text-center">
                        <div>
                          <span className="text-3xl" aria-hidden="true">🐜</span>
                          <p className="mt-3 font-bold text-ink">Choose an ant</p>
                          <p className="mt-1 text-sm leading-relaxed text-ink-faint">
                            Select one ant to see its bets and change its strategy for the next market.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </section>
          )}
        </div>
      )}
    </section>
  );
}

function AntDetailPanel({
  id,
  ant,
  detail,
  loading,
  error,
  view,
  globalStrategy,
  disabled,
  onViewChange,
  onRefresh,
  onSave,
}: {
  id: string;
  ant: Ant;
  detail: AntDetailResponse | null;
  loading: boolean;
  error: string;
  view: "history" | "strategy";
  globalStrategy: ColonyStrategy;
  disabled: boolean;
  onViewChange: (view: "history" | "strategy") => void;
  onRefresh: () => Promise<void>;
  onSave: (patch: AntStrategyPatch) => Promise<void>;
}) {
  const currentAnt = detail?.ant ?? ant;
  const summary = detail?.summary;
  return (
    <section id={id} className="ant-detail-panel grid min-w-0 gap-3">
      <div className="rounded-md border-2 border-gold/35 bg-[rgba(255,250,236,0.72)] p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="plate grid h-11 w-11 shrink-0 place-items-center text-xl" aria-hidden="true">🐜</span>
            <div className="min-w-0">
              <p className="eyebrow">Selected ant</p>
              <h4 className="truncate text-base font-bold">{antLabel(currentAnt)}</h4>
              <p className="mt-1 truncate text-xs text-ink-faint">
                {strategySummary(currentAnt.strategy)} · influence {currentAnt.influence.toFixed(2)}
              </p>
            </div>
          </div>
          <span className={`status-pill ${antStatusTone(currentAnt.status)}`}>{currentAnt.status}</span>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-2 text-center">
          <AntMetric label="Bets" value={summary?.total ?? currentAnt.performance.attempts} />
          <AntMetric label="Won" value={summary?.won ?? currentAnt.performance.wins} tone="green" />
          <AntMetric label="Lost" value={summary?.lost ?? currentAnt.performance.losses} tone="rust" />
          <AntMetric label="Open" value={summary?.open ?? 0} tone="gold" />
        </div>
      </div>

      <div className="seg" role="tablist" aria-label={`Details for ${antLabel(currentAnt)}`}>
        <button
          type="button"
          role="tab"
          aria-selected={view === "strategy"}
          data-active={view === "strategy"}
          onClick={() => onViewChange("strategy")}
        >
          Strategy
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "history"}
          data-active={view === "history"}
          onClick={() => onViewChange("history")}
        >
          Bet history{summary ? ` · ${summary.total}` : ""}
        </button>
      </div>

      {view === "history" ? (
        <div role="tabpanel" className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs leading-relaxed text-ink-faint">
              Sugar belongs to the colony. Each row shows this ant&apos;s vote and the colony position it joined.
            </p>
            <button
              type="button"
              className="quiet-link min-h-11 shrink-0 rounded-md px-2 text-xs"
              disabled={loading}
              onClick={() => void onRefresh()}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          {loading && !detail ? (
            <div className="well grid min-h-24 place-items-center p-4 text-sm text-ink-faint" role="status">
              Opening the ant ledger...
            </div>
          ) : error && !detail ? (
            <div className="well grid gap-3 p-3">
              <InlineError message={error} />
              <button type="button" className="btn btn-ghost !min-h-11 py-2 text-sm" onClick={() => void onRefresh()}>
                Retry history
              </button>
            </div>
          ) : (
            <AntBetLedger bets={detail?.bets ?? []} />
          )}
          {error && detail && <InlineNotice message={`History refresh failed: ${error}`} />}
        </div>
      ) : (
        <div role="tabpanel" className="grid gap-3">
          <AntOrderEditor
            key={`${currentAnt.antId}:${detail?.strategyRevision ?? 0}`}
            id={`${id}-orders`}
            ant={currentAnt}
            globalStrategy={globalStrategy}
            disabled={disabled}
            onClose={() => onViewChange("history")}
            onSave={onSave}
          />
          <StrategyChangeLedger detail={detail} />
        </div>
      )}
    </section>
  );
}

function AntBetLedger({ bets }: { bets: AntBet[] }) {
  if (!bets.length) {
    return (
      <div className="well p-4 text-center">
        <p className="font-bold text-ink">No bets yet</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-faint">
          This ant has not joined a colony position in this match.
        </p>
      </div>
    );
  }
  return (
    <ol className="grid gap-2 pr-1 xl:max-h-[520px] xl:overflow-y-auto" aria-label="Ant bet history">
      {bets.map((bet) => (
        <li key={bet.predictionId} className={`rounded-md border-2 bg-[rgba(249,243,226,0.72)] p-3 ${betBorderTone(bet.status)}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-ink">{bet.marketLabel}</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                {bet.minute != null ? `${bet.minute}' · ` : ""}{labelizeBetValue(bet.context)} · event {bet.createdEventIndex}
              </p>
            </div>
            <span className={`status-pill ${betStatusTone(bet.status)}`}>{betStatusLabel(bet.status)}</span>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="well min-w-0 px-3 py-2">
              <p className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">Ant vote</p>
              <p className="truncate text-sm font-bold text-ink">{bet.optionLabel}</p>
              <p className="mt-1 font-mono text-[10px] text-ink-faint">
                {labelizeBetValue(bet.risk)}{bet.multiplier != null ? ` · win ×${bet.multiplier}` : ""}
              </p>
            </div>
            <div className="well min-w-[132px] px-3 py-2 text-right">
              <p className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">
                {bet.status === "open" ? "Sugar at risk" : "Colony impact"}
              </p>
              <p className={`font-mono text-lg font-bold ${foodTone(bet)}`}>
                {bet.status === "open" ? formatFood(bet.sugarAtRisk ?? bet.foodAtRisk) : formatSignedFood(bet.colonySugarDelta ?? bet.colonyFoodDelta)}
              </p>
              <p className="text-[10px] text-ink-faint">{bet.voteCount} ant vote{bet.voteCount === 1 ? "" : "s"}</p>
            </div>
          </div>

          {(bet.resolvedOutcome?.label || bet.decisionReason) && (
            <div className="mt-2 grid gap-1 text-xs leading-relaxed text-ink-soft">
              {bet.resolvedOutcome?.label && <p><strong>Outcome:</strong> {bet.resolvedOutcome.label}</p>}
              {bet.decisionReason && <p><strong>Reason:</strong> {bet.decisionReason}</p>}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-ink-faint">
            <span>{bet.strategy ? `Orders: ${strategySummary(bet.strategy)}` : `Strategy revision ${bet.strategyRevision ?? "—"}`}</span>
            <time dateTime={new Date(bet.createdAt * 1000).toISOString()}>{formatUnixTime(bet.createdAt)}</time>
          </div>
        </li>
      ))}
    </ol>
  );
}

function StrategyChangeLedger({ detail }: { detail: AntDetailResponse | null }) {
  const changes = detail?.strategyHistory ?? [];
  return (
    <section className="well grid gap-2 p-3">
      <div>
        <p className="eyebrow">Order log</p>
        <h5 className="text-sm font-bold">Individual strategy changes</h5>
      </div>
      {!changes.length ? (
        <p className="text-xs leading-relaxed text-ink-faint">No individual change recorded yet.</p>
      ) : (
        <ol className="grid gap-2">
          {changes.slice(0, 6).map((change) => (
            <li key={change.eventIndex} className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--brd-soft)] pt-2 text-xs">
              <span className="font-bold text-ink-soft">{strategySummary(change.strategy)}</span>
              <span className="font-mono text-[10px] text-ink-faint">rev {change.strategyRevision ?? "—"} · {formatUnixTime(change.changedAt)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function AntMetric({ label, value, tone }: { label: string; value: number; tone?: "green" | "rust" | "gold" }) {
  const color = tone === "green" ? "text-green" : tone === "rust" ? "text-rust" : tone === "gold" ? "text-gold-deep" : "text-ink";
  return (
    <div className="well min-w-0 px-1 py-2">
      <p className="truncate font-mono text-[9px] uppercase text-ink-faint">{label}</p>
      <p className={`font-mono text-lg font-bold ${color}`}>{value}</p>
    </div>
  );
}

function ChoiceButtons<T extends string>({
  legend,
  options,
  value,
  onChange,
  disabled,
  descriptionId,
}: {
  legend: string;
  options: readonly StrategyOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
  descriptionId: string;
}) {
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <fieldset className="grid gap-2" aria-describedby={descriptionId}>
      <legend className="text-sm font-bold text-ink-soft">{legend}</legend>
      <div className="seg">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            data-active={option.value === value}
            aria-pressed={option.value === value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p id={descriptionId} className="text-xs leading-relaxed text-ink-faint">
        <strong className="text-ink-soft">{selected.shortLabel}.</strong> {selected.description}
      </p>
    </fieldset>
  );
}

function ChoiceChips<T extends string>({
  legend,
  options,
  value,
  onChange,
  disabled,
  descriptionId,
}: {
  legend: string;
  options: readonly StrategyOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
  descriptionId: string;
}) {
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <fieldset className="grid gap-2" aria-describedby={descriptionId}>
      <legend className="text-sm font-bold text-ink-soft">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="chip disabled:cursor-not-allowed disabled:opacity-50"
            data-active={option.value === value}
            aria-pressed={option.value === value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p id={descriptionId} className="text-xs leading-relaxed text-ink-faint">
        <strong className="text-ink-soft">{selected.shortLabel}.</strong> {selected.description}
      </p>
    </fieldset>
  );
}

function AntOrderEditor({
  id,
  ant,
  globalStrategy,
  disabled,
  onClose,
  onSave,
}: {
  id: string;
  ant: Ant;
  globalStrategy: ColonyStrategy;
  disabled: boolean;
  onClose: () => void;
  onSave: (patch: AntStrategyPatch) => Promise<void>;
}) {
  const [custom, setCustom] = useState(!ant.strategy.inheritsGlobal);
  const [draft, setDraft] = useState<ColonyStrategy>({
    style: ant.strategy.style,
    favoriteContext: ant.strategy.favoriteContext,
    infoNeed: ant.strategy.infoNeed,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = custom
    ? ant.strategy.inheritsGlobal || !sameStrategy(draft, ant.strategy)
    : !ant.strategy.inheritsGlobal;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !dirty) return;
    setSaving(true);
    setError("");
    try {
      await onSave(custom ? draft : { inheritGlobal: true });
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form id={id} className="ant-order-editor well grid gap-3 p-3" onSubmit={submit}>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-bold text-ink-soft">Order source</legend>
        <div className="seg">
          <button type="button" data-active={!custom} aria-pressed={!custom} disabled={disabled || saving} onClick={() => setCustom(false)}>
            Follow colony
          </button>
          <button type="button" data-active={custom} aria-pressed={custom} disabled={disabled || saving} onClick={() => setCustom(true)}>
            Custom
          </button>
        </div>
      </fieldset>

      {!custom ? (
        <p className="rounded-md border-2 border-green/30 bg-green/10 p-3 text-xs leading-relaxed text-ink-soft">
          This ant will follow <strong>{strategySummary(globalStrategy)}</strong> and every later colony update.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <SelectField
            label="Temper"
            value={draft.style}
            options={STYLE_OPTIONS}
            disabled={disabled || saving}
            onChange={(style) => setDraft((current) => ({ ...current, style }))}
          />
          <SelectField
            label="Focus"
            value={draft.favoriteContext}
            options={FOCUS_OPTIONS}
            disabled={disabled || saving}
            onChange={(favoriteContext) => setDraft((current) => ({ ...current, favoriteContext }))}
          />
          <SelectField
            label="Info"
            value={draft.infoNeed}
            options={INFO_NEED_OPTIONS}
            disabled={disabled || saving}
            onChange={(infoNeed) => setDraft((current) => ({ ...current, infoNeed }))}
          />
        </div>
      )}

      {!ant.alive && <InlineNotice message="This ant is dead and cannot receive new orders." />}
      {error && <InlineError message={error} />}

      <div className="sticky bottom-0 grid grid-cols-2 gap-2 border-t-2 border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.96)] pt-3">
        <button type="button" className="btn btn-ghost !min-h-11 px-3 py-2 text-sm" disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary !min-h-11 px-3 py-2 text-sm" disabled={disabled || !dirty || saving} aria-busy={saving}>
          {saving ? "Saving..." : "Save for next market"}
        </button>
      </div>
      <p className="text-center text-[11px] font-bold text-ink-faint">Applies to next market</p>
    </form>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly StrategyOption<T>[];
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-bold text-ink-soft">
      {label}
      <select className="input !px-2 !py-2 text-sm" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function AntStatus({ status }: { status: string }) {
  const color = status === "active" ? "bg-green" : status === "wounded" ? "bg-rust" : "bg-ink-faint";
  return (
    <span className="grid justify-items-center gap-1" title={status}>
      <span className={`h-2.5 w-2.5 rounded-full ${color}`} aria-hidden="true" />
      <span className="sr-only">{status}</span>
      <span className="text-base" aria-hidden="true">🐜</span>
    </span>
  );
}

function antStatusTone(status: string): string {
  if (status === "active") return "!border-green/50 !text-green";
  if (status === "wounded") return "!border-rust/50 !text-rust";
  return "!border-ink-faint/40 !text-ink-faint";
}

function betStatusLabel(status: AntBet["status"]): string {
  if (status === "won") return "Won";
  if (status === "lost") return "Lost";
  if (status === "void") return "Void";
  if (status === "recalled") return "Recalled";
  return "Open";
}

function betStatusTone(status: AntBet["status"]): string {
  if (status === "won") return "!border-green/50 !text-green";
  if (status === "lost") return "!border-rust/50 !text-rust";
  if (status === "void") return "!border-ink-faint/40 !text-ink-faint";
  if (status === "recalled") return "!border-gold/50 !text-gold-deep";
  return "!border-gold/50 !text-gold-deep";
}

function betBorderTone(status: AntBet["status"]): string {
  if (status === "won") return "border-green/45";
  if (status === "lost") return "border-rust/45";
  if (status === "void") return "border-[color:var(--brd-soft)]";
  if (status === "recalled") return "border-gold/35";
  return "border-gold/45";
}

function foodTone(bet: AntBet): string {
  if (bet.status === "won") return "text-green";
  if (bet.status === "lost") return "text-rust";
  return "text-gold-deep";
}

function formatFood(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${formatNumber(value)} Sugar`;
}

function formatSignedFood(value: number | null | undefined): string {
  if (value == null) return "—";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatNumber(value)} Sugar`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatUnixTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value * 1000));
}

function labelizeBetValue(value: string | null | undefined): string {
  return String(value || "market").replace(/_/g, " ");
}

function InlineError({ message }: { message: string }) {
  return <p className="rounded-md border-2 border-danger/40 bg-danger/10 px-3 py-2 text-sm font-bold text-danger" role="alert">{message}</p>;
}

function InlineNotice({ message }: { message: string }) {
  return <p className="well px-3 py-2 text-xs leading-relaxed text-ink-soft">{message}</p>;
}

function strategyFromColony(colony: Colony): ColonyStrategy {
  return {
    style: colony.style,
    favoriteContext: colony.favoriteContext,
    infoNeed: colony.infoNeed,
  };
}

function sameStrategy(left: ColonyStrategy, right: ColonyStrategy): boolean {
  return left.style === right.style
    && left.favoriteContext === right.favoriteContext
    && left.infoNeed === right.infoNeed;
}

function antLabel(ant: Ant): string {
  return `${ant.antId.replace(/^ant_/, "Ant ")} · ${ant.archetype.replace(/_/g, " ")}`;
}

function performanceLabel(ant: Ant): string {
  const { attempts, successRate } = ant.performance;
  if (!attempts || successRate == null) return "no results yet";
  return `${Math.round(successRate * 100)}% over ${attempts}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The colony could not save these orders.";
}

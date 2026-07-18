"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  beginAntCommandSave,
  beginGlobalCommandSave,
  reconcileAntCommandDraft,
  reconcileGlobalCommandDraft,
  setAntCommandDraft,
  setGlobalCommandDraft,
  useColonyCommandDrafts,
  type AntCommandDraft,
  type ColonyDoctrineDraft,
  type CommandDraftEntry,
} from "@/lib/commandDrafts";
import {
  ANALYSIS_ROLE_OPTIONS,
  STYLE_OPTIONS,
  isStrategyEditableStatus,
  optionLabel,
  strategySummary,
  type StyleDoctrine,
} from "@/lib/strategy";
import {
  colonyAvailableSugar,
  colonyReservedSugar,
  colonySugar,
  colonySugarNet,
} from "@/lib/sugar";
import type {
  AnalysisRole,
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
  controlMode?: "player" | "admin";
  compactLayout?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  initialScope?: CommandScope;
  expandedByDefault?: boolean;
  onRequestClose?: () => void;
  rank?: number;
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
  controlMode = "player",
  compactLayout = false,
  onDirtyChange,
  initialScope = "ants",
  expandedByDefault = false,
  onRequestClose,
  rank = 0,
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
  const [selectedAntId, setSelectedAntId] = useState<string | null>(null);
  const [selectedAntView, setSelectedAntView] = useState<"history" | "strategy">("strategy");
  const [antDetail, setAntDetail] = useState<AntDetailResponse | null>(null);
  const [loadingAntDetail, setLoadingAntDetail] = useState(false);
  const [antDetailError, setAntDetailError] = useState("");
  const commandDrafts = useColonyCommandDrafts(gameId, colony.colonyId);

  const colonyGlobal = strategyFromColony(colony);
  const rosterIsAtLeastAsFresh = Boolean(roster)
    && (roster?.strategyRevision ?? -1) >= (colony.strategyRevision ?? -1);
  const currentGlobal = rosterIsAtLeastAsFresh ? roster!.globalStrategy : colonyGlobal;
  const currentGlobalRevision = rosterIsAtLeastAsFresh
    ? roster!.strategyRevision
    : colony.strategyRevision ?? -1;
  const currentDoctrine = doctrineFromStrategy(currentGlobal);
  const globalDraft = commandDrafts.global?.value ?? currentDoctrine;
  const adminControl = controlMode === "admin";
  const antsLabel = adminControl ? "Colony ants" : "My ants";
  const globalDirty = Boolean(commandDrafts.global && !sameDoctrine(commandDrafts.global.value, currentDoctrine));
  const ants = roster?.ants ?? EMPTY_ANTS;
  const antDraftDirty = Object.entries(commandDrafts.ants).some(([antId, entry]) => {
    const ant = ants.find((candidate) => candidate.antId === antId);
    return !ant || !sameAntCommand(entry.value, ant);
  });
  const commandDirty = globalDirty || antDraftDirty;
  const sugar = colonySugar(colony);
  const sugarAvailable = colonyAvailableSugar(colony);
  const sugarReserved = colonyReservedSugar(colony);
  const sugarNet = colonySugarNet(colony);
  const roleCounts = useMemo(() => Object.fromEntries(
    ANALYSIS_ROLE_OPTIONS.map((option) => [
      option.value,
      ants.filter(
        (ant) => effectiveAnalysisRole(ant, commandDrafts.ants[ant.antId]) === option.value,
      ).length,
    ]),
  ) as Record<AnalysisRole, number>, [ants, commandDrafts.ants]);
  const selectedAnt = ants.find((ant) => ant.antId === selectedAntId) ?? null;
  const rosterPaneClass = selectedAnt
    ? compactLayout ? "hidden" : "hidden xl:grid"
    : "grid";
  const detailPaneClass = selectedAnt
    ? "grid"
    : compactLayout ? "hidden" : "hidden xl:grid";
  const visibleAnts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return ants.filter((ant) => {
      if (!needle) return true;
      const role = effectiveAnalysisRole(ant, commandDrafts.ants[ant.antId]);
      const roleOption = ANALYSIS_ROLE_OPTIONS.find((option) => option.value === role);
      return [ant.antId, ant.archetype, roleOption?.label, roleOption?.shortLabel]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [ants, commandDrafts.ants, query]);

  useEffect(() => {
    onDirtyChange?.(commandDirty);
  }, [commandDirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    reconcileGlobalCommandDraft(
      gameId,
      colony.colonyId,
      { style: currentGlobal.style },
      currentGlobalRevision,
    );
  }, [
    colony.colonyId,
    currentGlobal.style,
    currentGlobalRevision,
    gameId,
  ]);

  function updateGlobalDraft(update: (current: ColonyDoctrineDraft) => ColonyDoctrineDraft) {
    const next = update(globalDraft);
    // A second mounted panel can edit while this panel's PATCH is pending. If
    // that newer edit returns to the current server value, retain it as a new
    // edit token so the older PATCH response cannot clear the user's intent.
    const hasPendingSave = Boolean(commandDrafts.global?.pending.length);
    setGlobalCommandDraft(
      gameId,
      colony.colonyId,
      sameDoctrine(next, currentDoctrine) && !hasPendingSave ? null : next,
      currentGlobalRevision,
    );
  }

  const loadAnts = useCallback(async (silent = false) => {
    const requestId = ++requestSequence.current;
    if (!silent) setLoadingAnts(true);
    setLoadError("");
    try {
      const next = await api.getColonyAnts(gameId, colony.colonyId, anonymousId);
      if (requestId !== requestSequence.current) return;
      for (const ant of next.ants) {
        reconcileAntCommandDraft(
          gameId,
          colony.colonyId,
          ant.antId,
          commandFromAnt(ant),
          next.strategyRevision,
        );
      }
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
      reconcileAntCommandDraft(
        gameId,
        colony.colonyId,
        detail.ant.antId,
        commandFromAnt(detail.ant),
        detail.strategyRevision,
      );
      setAntDetail(detail);
      setRoster((current) => current && ({
        ...current,
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
    const draftEntry = commandDrafts.global;
    if (!editable || !globalDirty || !draftEntry) return;
    const submission = beginGlobalCommandSave(gameId, colony.colonyId, draftEntry.editId);
    if (!submission) return;
    const submittedDraft = submission.value;
    setSavingGlobal(true);
    setGlobalError("");
    setAnnouncement("");
    try {
      const game = await api.updateStrategy(gameId, colony.colonyId, {
        style: submittedDraft.style,
        anonymousId,
      });
      const savedColony = game.colonies.find((candidate) => candidate.colonyId === colony.colonyId);
      if (savedColony) {
        const savedStrategy = strategyFromColony(savedColony);
        reconcileGlobalCommandDraft(
          gameId,
          colony.colonyId,
          doctrineFromStrategy(savedStrategy),
          savedColony.strategyRevision ?? submission.baseRevision + 1,
          submission.saveId,
        );
        setRoster((current) => current && ({
          ...current,
          globalStrategy: savedStrategy,
        }));
      }
      onGameChange(game);
      setAnnouncement("Colony orders saved. They apply to the next market.");
      void loadAnts();
    } catch (error) {
      setGlobalError(errorMessage(error));
    } finally {
      setSavingGlobal(false);
    }
  }

  async function saveAntStrategy(
    ant: Ant,
    patch: AntStrategyPatch,
    submittedEntry: CommandDraftEntry<AntCommandDraft>,
  ) {
    const submission = beginAntCommandSave(
      gameId,
      colony.colonyId,
      ant.antId,
      submittedEntry.editId,
    );
    if (!submission) return;
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
    reconcileAntCommandDraft(
      gameId,
      colony.colonyId,
      ant.antId,
      commandFromAnt(result.ant),
      result.strategyRevision,
      submission.saveId,
    );
    setRoster((current) => current && ({
      ...current,
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
    <section
      className={`colony-command-panel glass relative flex min-w-0 flex-col gap-3 p-3 ${
        compactLayout ? "is-compact" : ""
      } ${compactLayout && expanded && scope === "ants" && !selectedAnt ? "is-ants-roster" : ""}`}
      aria-labelledby={`${disclosureId}-title`}
    >
      {compactLayout ? (
        <>
          <div className="colony-console-head">
            <div className="min-w-0">
              <p className="eyebrow">{adminControl ? "Admin colony" : "Your colony"}</p>
              <h2 id={`${disclosureId}-title`}>{colony.name}</h2>
            </div>
            <div className="colony-console-head-actions">
              <span className={`colony-console-state ${commandDirty ? "is-dirty" : editable ? "is-live" : "is-locked"}`}>
                <i aria-hidden="true" />
                {commandDirty ? "Draft" : editable ? "Live" : "Locked"}
              </span>
              <span className="colony-console-rank">#{rank || "–"}</span>
              <button
                type="button"
                className="colony-console-manage"
                aria-expanded={expanded}
                aria-controls={disclosureId}
                onClick={toggleExpanded}
              >
                {expanded ? "Close" : "Manage"}
              </button>
            </div>
          </div>

          <div className="colony-console-score" aria-label={`${sugar} Sugar, ${sugarAvailable} available, ${sugarReserved} committed`}>
            <div className="colony-console-score-main">
              <span>Sugar</span>
              <p aria-live="polite" aria-atomic="true">
                <strong>{sugar}</strong>
                <b className={sugarNet < 0 ? "is-negative" : "is-positive"}>
                  Δ {sugarNet > 0 ? "+" : ""}{sugarNet}
                </b>
              </p>
            </div>
            <div className="colony-console-score-stat">
              <span>Available</span>
              <strong>{sugarAvailable}</strong>
            </div>
            <div className="colony-console-score-stat">
              <span>Committed</span>
              <strong>{sugarReserved}</strong>
            </div>
          </div>
        </>
      ) : (
        <div className="colony-command-head flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow">{adminControl ? "Selected admin colony" : "Your colony"}</p>
            <h2 id={`${disclosureId}-title`} className="truncate text-base font-bold">Control {colony.name}</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-faint">
              {adminControl
                ? "These controls affect only this admin colony. New orders apply to the next market."
                : "Change the whole colony or choose one ant. New orders apply to the next market."}
            </p>
          </div>
          <div className="colony-command-actions flex shrink-0 items-center gap-2">
            <span className={`status-pill ${commandDirty ? "!border-gold/60 !text-gold-deep" : editable ? "!border-green/50 !text-green" : ""}`}>
              {commandDirty ? "Unsaved draft" : editable ? "Live changes" : "Read-only"}
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
      )}

      {!expanded && (
        <div className={`colony-command-summary grid gap-2 ${compactLayout ? "is-compact" : "sm:grid-cols-2"}`}>
          <button
            type="button"
            className={`command-summary-card well group text-left transition hover:border-gold/60 focus-visible:border-gold ${
              compactLayout
                ? "is-compact grid min-h-[58px] grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2 p-2"
                : "grid min-h-24 gap-1 p-3"
            }`}
            onClick={() => openScope("colony")}
          >
            <span className="command-summary-icon" aria-hidden="true">
              {compactLayout ? <CommandSummaryIcon kind="strategy" /> : "👑"}
            </span>
            <span className="command-summary-copy min-w-0">
              <strong className="block text-sm">Colony strategy</strong>
              <span className="block text-xs leading-snug text-ink-faint">
                Doctrine {optionLabel(STYLE_OPTIONS, colony.style)}
              </span>
            </span>
            {compactLayout && <span className="command-summary-arrow" aria-hidden="true">→</span>}
          </button>
          <button
            type="button"
            className={`command-summary-card well group text-left transition hover:border-gold/60 focus-visible:border-gold ${
              compactLayout
                ? "is-compact grid min-h-[58px] grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2 p-2"
                : "grid min-h-24 gap-1 p-3"
            }`}
            onClick={() => openScope("ants")}
          >
            <span className="command-summary-icon" aria-hidden="true">
              {compactLayout ? <CommandSummaryIcon kind="ants" /> : "🐜"}
            </span>
            <span className="command-summary-copy min-w-0">
              <strong className="block text-sm">{antsLabel}</strong>
              <span className="block text-xs leading-snug text-ink-faint">{colony.antsAlive} alive · select one to change its orders</span>
            </span>
            {compactLayout && <span className="command-summary-arrow" aria-hidden="true">→</span>}
          </button>
        </div>
      )}

      {compactLayout && !expanded && (
        <p className="colony-console-note">Orders apply to the next market.</p>
      )}

      {announcement && (
        <div aria-live="polite" aria-atomic="true">
          <InlineNotice message={announcement} />
        </div>
      )}

      {expanded && (
        <div id={disclosureId} className="colony-command-disclosure grid gap-4 border-t-2 border-[color:var(--brd-soft)] pt-3">
          <div className="seg command-scope-tabs" aria-label="Colony command scope">
            <button
              type="button"
              aria-pressed={scope === "ants"}
              data-active={scope === "ants"}
              onClick={() => openScope("ants")}
            >
              <span className="command-scope-icon" aria-hidden="true"><CommandSummaryIcon kind="ants" /></span>
              <span>{antsLabel}</span>
              {roster && <strong>{roster.ants.length}</strong>}
            </button>
            <button
              type="button"
              aria-pressed={scope === "colony"}
              data-active={scope === "colony"}
              onClick={() => openScope("colony")}
            >
              <span className="command-scope-icon" aria-hidden="true"><CommandSummaryIcon kind="strategy" /></span>
              <span>Colony strategy</span>
            </button>
          </div>

          {scope === "colony" && (
            <section className="well grid gap-3 p-3" aria-labelledby={`${disclosureId}-global-title`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="eyebrow">Default orders</p>
                  <h3 id={`${disclosureId}-global-title`} className="font-bold">Whole colony</h3>
                </div>
                <span className="status-pill !border-green/50 !text-green">Next market</span>
              </div>
              <p className="text-xs leading-relaxed text-ink-faint">
                The doctrine controls how much consensus is required before the colony enters. Each ant keeps its own analysis role.
              </p>

              <DoctrineSelector
                legend="Entry rule"
                value={globalDraft.style}
                onChange={(style) => updateGlobalDraft((current) => ({ ...current, style }))}
                disabled={!editable || savingGlobal}
                descriptionId={`${disclosureId}-style-help`}
              />

              {globalError && <InlineError message={globalError} />}
              {!editable && <InlineNotice message="This match is finished. Orders are now read-only." />}

              <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
                <button
                  type="button"
                  className="btn btn-ghost !min-h-11 px-3 py-2 text-sm"
                  disabled={!globalDirty || savingGlobal}
                  onClick={() => setGlobalCommandDraft(
                    gameId,
                    colony.colonyId,
                    commandDrafts.global?.pending.length ? currentGlobal : null,
                    currentGlobalRevision,
                  )}
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
                  {savingGlobal
                    ? "Applying doctrine..."
                    : `Apply ${optionLabel(STYLE_OPTIONS, globalDraft.style)} doctrine`}
                </button>
              </div>
            </section>
          )}

          {scope === "ants" && (
            <section className="command-ants-section grid min-w-0 gap-3" aria-labelledby={`${disclosureId}-ants-title`}>
              <div className="command-ants-intro flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="eyebrow">Individual control</p>
                  <h3 id={`${disclosureId}-ants-title`} className="font-bold">{antsLabel}</h3>
                  {roster && (
                    <p className="mt-1 text-xs text-ink-faint">
                      One analysis role per ant. The colony doctrine stays global.
                    </p>
                  )}
                </div>
                {roster && <span className="status-pill">{roster.ants.filter((ant) => ant.alive).length} alive</span>}
              </div>

              {loadingAnts && !roster ? (
                <div className="well grid min-h-24 place-items-center p-4 text-sm text-ink-faint" role="status">
                  {adminControl ? "Gathering colony ants..." : "Gathering your ants..."}
                </div>
              ) : loadError && !roster ? (
                <div className="well grid gap-3 p-3">
                  <InlineError message={loadError} />
                  <button type="button" className="btn btn-ghost !min-h-11 py-2 text-sm" onClick={() => void loadAnts()}>
                    Retry roster
                  </button>
                </div>
              ) : roster ? (
                <div className={`command-ant-workspace grid min-w-0 gap-3 ${compactLayout ? "" : "xl:grid-cols-[minmax(250px,0.72fr)_minmax(0,1.28fr)]"}`}>
                  <div className={`${rosterPaneClass} command-ant-roster-pane min-w-0 content-start gap-3`}>
                    <RoleDistribution counts={roleCounts} />

                    <div className="grid gap-2">
                      <label>
                        <span className="sr-only">Search ants</span>
                        <input
                          className="input !py-2 text-sm"
                          type="search"
                          placeholder="Search ant, archetype or role"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                        />
                      </label>
                    </div>

                    <ul className="command-ant-list grid gap-2 pr-1 xl:max-h-[600px] xl:overflow-y-auto" aria-label="Ant strategy roster">
                      {visibleAnts.map((ant) => {
                        const selected = selectedAntId === ant.antId;
                        const hasDraft = Boolean(commandDrafts.ants[ant.antId]
                          && !sameAntCommand(commandDrafts.ants[ant.antId].value, ant));
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
                                  {hasDraft && <span className="status-pill !border-gold/60 !px-2 !py-0.5 !text-gold-deep">draft</span>}
                                  {selected && <span className="status-pill !border-gold/60 !px-2 !py-0.5 !text-gold-deep">selected</span>}
                                </span>
                                <span className="mt-1 block truncate text-xs text-ink-faint">
                                  {optionLabel(ANALYSIS_ROLE_OPTIONS, effectiveAnalysisRole(ant, commandDrafts.ants[ant.antId]))} · {performanceLabel(ant)}
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

                  <div className={`${detailPaneClass} min-w-0 content-start gap-3`}>
                    {selectedAnt ? (
                      <>
                        <button
                          type="button"
                          className={`quiet-link min-h-11 w-fit rounded-md px-2 text-sm ${compactLayout ? "" : "xl:hidden"}`}
                          onClick={() => {
                            selectAnt(null);
                            setAntDetail(null);
                            setAntDetailError("");
                            detailRequestSequence.current += 1;
                          }}
                        >
                          ← Back to {adminControl ? "colony ants" : "my ants"}
                        </button>
                        <AntDetailPanel
                          id={`${disclosureId}-${selectedAnt.antId}-detail`}
                          ant={selectedAnt}
                          detail={antDetail?.ant.antId === selectedAnt.antId ? antDetail : null}
                          loading={loadingAntDetail}
                          error={antDetailError}
                          view={selectedAntView}
                          disabled={!editable || !selectedAnt.alive}
                          onViewChange={setSelectedAntView}
                          onRefresh={() => loadAntDetail(selectedAnt.antId)}
                          onSave={(patch, submittedDraft) => saveAntStrategy(selectedAnt, patch, submittedDraft)}
                          draft={commandDrafts.ants[selectedAnt.antId]}
                          onDraftChange={(draft) => setAntCommandDraft(
                            gameId,
                            colony.colonyId,
                            selectedAnt.antId,
                            draft,
                            roster.strategyRevision,
                          )}
                          onDraftDiscard={() => setAntCommandDraft(
                            gameId,
                            colony.colonyId,
                            selectedAnt.antId,
                            null,
                            roster.strategyRevision,
                          )}
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

function CommandSummaryIcon({ kind }: { kind: "strategy" | "ants" }) {
  if (kind === "strategy") {
    return (
      <svg viewBox="0 0 24 24" role="presentation">
        <path d="M4 7.5 8.5 12 12 5l3.5 7L20 7.5l-1.4 10h-13L4 7.5Z" />
        <path d="M6 20h12" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <circle cx="12" cy="7" r="2.5" />
      <ellipse cx="12" cy="14" rx="3.5" ry="4.5" />
      <path d="m8.8 11-4-2m4 5H4m4.8 3-4 2m10.4-8 4-2m-4 5H20m-4.8 3 4 2M9.8 5 7.5 2.5M14.2 5l2.3-2.5" />
    </svg>
  );
}

function AntDetailPanel({
  id,
  ant,
  detail,
  loading,
  error,
  view,
  disabled,
  onViewChange,
  onRefresh,
  onSave,
  draft,
  onDraftChange,
  onDraftDiscard,
}: {
  id: string;
  ant: Ant;
  detail: AntDetailResponse | null;
  loading: boolean;
  error: string;
  view: "history" | "strategy";
  disabled: boolean;
  onViewChange: (view: "history" | "strategy") => void;
  onRefresh: () => Promise<void>;
  onSave: (patch: AntStrategyPatch, submittedDraft: CommandDraftEntry<AntCommandDraft>) => Promise<void>;
  draft?: CommandDraftEntry<AntCommandDraft>;
  onDraftChange: (draft: AntCommandDraft | null) => void;
  onDraftDiscard: () => void;
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
                {optionLabel(ANALYSIS_ROLE_OPTIONS, analysisRoleFromAnt(currentAnt))} · {ANALYSIS_ROLE_OPTIONS.find((option) => option.value === analysisRoleFromAnt(currentAnt))?.shortLabel}
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

      <div className="seg" aria-label={`Details for ${antLabel(currentAnt)}`}>
        <button
          type="button"
          aria-pressed={view === "strategy"}
          data-active={view === "strategy"}
          onClick={() => onViewChange("strategy")}
        >
          Strategy
        </button>
        <button
          type="button"
          aria-pressed={view === "history"}
          data-active={view === "history"}
          onClick={() => onViewChange("history")}
        >
          Bet history{summary ? ` · ${summary.total}` : ""}
        </button>
      </div>

      {view === "history" ? (
        <div className="grid gap-3">
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
        <div className="grid gap-3">
          <AntOrderEditor
            key={currentAnt.antId}
            id={`${id}-orders`}
            ant={currentAnt}
            disabled={disabled}
            onClose={() => onViewChange("history")}
            onSave={onSave}
            commandDraft={draft}
            onDraftChange={onDraftChange}
            onDraftDiscard={onDraftDiscard}
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

function DoctrineSelector({
  legend,
  value,
  onChange,
  disabled,
  descriptionId,
}: {
  legend: string;
  value: ColonyStrategy["style"];
  onChange: (value: ColonyStrategy["style"]) => void;
  disabled: boolean;
  descriptionId: string;
}) {
  const selected = STYLE_OPTIONS.find((option) => option.value === value) ?? STYLE_OPTIONS[0];
  return (
    <fieldset className="grid gap-2" aria-describedby={descriptionId}>
      <legend className="text-sm font-bold text-ink-soft">{legend}</legend>
      <div className="doctrine-grid">
        {STYLE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="doctrine-card"
            data-active={option.value === value}
            aria-pressed={option.value === value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            <span className="doctrine-card-head">
              <strong>{option.label}</strong>
              <b className="doctrine-gate-number">{option.thresholdPercent}%</b>
            </span>
            <span className="doctrine-card-kicker">{option.cadenceLabel}</span>
          </button>
        ))}
      </div>
      <ConsensusGatePreview doctrine={selected} descriptionId={descriptionId} />
    </fieldset>
  );
}

function ConsensusGatePreview({
  doctrine,
  descriptionId,
}: {
  doctrine: StyleDoctrine;
  descriptionId: string;
}) {
  return (
    <div id={descriptionId} className="consensus-gate" aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Consensus gate</p>
          <p className="text-sm font-bold text-ink">
            At least 10 ants take a side · {doctrine.thresholdPercent}% must agree
          </p>
        </div>
        <span className="status-pill !border-gold/50 !text-gold-deep">Next market</span>
      </div>
      <div
        className="consensus-ant-track"
        role="img"
        aria-label={`At least 10 directional voters are required, then ${doctrine.thresholdPercent} percent must agree`}
      >
        {Array.from({ length: 20 }, (_, index) => (
          <span key={index} data-required={index < 10} />
        ))}
      </div>
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Abstentions stay outside consensus. Below the 10-ant quorum, the colony observes and keeps its Sugar.
      </p>
    </div>
  );
}

function RoleDistribution({ counts }: { counts: Record<AnalysisRole, number> }) {
  const titleId = useId();
  return (
    <section className="command-role-distribution grid gap-2" aria-labelledby={titleId}>
      <div>
        <p className="eyebrow">Role distribution</p>
        <h4 id={titleId} className="text-sm font-bold text-ink">How the ants read each market</h4>
      </div>
      <dl className="command-role-distribution-grid grid gap-2 sm:grid-cols-3 xl:grid-cols-1">
        {ANALYSIS_ROLE_OPTIONS.map((option) => (
          <div key={option.value} className="command-role-distribution-card well grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 px-3 py-2">
            <dt className="min-w-0">
              <span className="block truncate text-xs font-bold text-ink">{option.label}</span>
              <span className="block truncate text-[10px] text-ink-faint">{option.shortLabel}</span>
            </dt>
            <dd className="order-first font-mono text-xl font-bold text-gold-deep">{counts[option.value]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function AnalysisRoleSelector({
  value,
  onChange,
  disabled,
  descriptionId,
}: {
  value: AnalysisRole;
  onChange: (value: AnalysisRole) => void;
  disabled: boolean;
  descriptionId: string;
}) {
  const selected = ANALYSIS_ROLE_OPTIONS.find((option) => option.value === value) ?? ANALYSIS_ROLE_OPTIONS[0];
  return (
    <fieldset className="grid gap-2" aria-describedby={descriptionId}>
      <legend className="text-sm font-bold text-ink-soft">Analysis role</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {ANALYSIS_ROLE_OPTIONS.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              className={`well grid min-h-24 cursor-pointer content-start gap-1 p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${active ? "!border-gold bg-gold/10" : "hover:border-gold/60"}`}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onChange(option.value)}
            >
              <span className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm text-ink">{option.label}</strong>
                {active && <span className="status-pill !border-gold/60 !px-2 !py-0.5 !text-gold-deep">Selected</span>}
              </span>
              <span className="text-xs font-bold text-ink-soft">{option.shortLabel}</span>
              <span className="text-[11px] leading-relaxed text-ink-faint">{option.description}</span>
            </button>
          );
        })}
      </div>
      <p id={descriptionId} className="text-xs leading-relaxed text-ink-faint" aria-live="polite">
        <strong className="text-ink-soft">{selected.label} reads {selected.shortLabel.toLowerCase()}.</strong> The colony doctrine still decides how much consensus is required.
      </p>
    </fieldset>
  );
}

function AntOrderEditor({
  id,
  ant,
  disabled,
  onClose,
  onSave,
  commandDraft,
  onDraftChange,
  onDraftDiscard,
}: {
  id: string;
  ant: Ant;
  disabled: boolean;
  onClose: () => void;
  onSave: (patch: AntStrategyPatch, submittedDraft: CommandDraftEntry<AntCommandDraft>) => Promise<void>;
  commandDraft?: CommandDraftEntry<AntCommandDraft>;
  onDraftChange: (draft: AntCommandDraft | null) => void;
  onDraftDiscard: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const draft = commandDraft?.value ?? commandFromAnt(ant);
  const dirty = Boolean(commandDraft && !sameAntCommand(commandDraft.value, ant));

  function updateDraft(analysisRole: AnalysisRole) {
    const next = { analysisRole };
    // Keep a clean-looking newer edit while an older request is pending. Its
    // edit token is what prevents that older acknowledgement from winning.
    const hasPendingSave = Boolean(commandDraft?.pending.length);
    onDraftChange(sameAntCommand(next, ant) && !hasPendingSave ? null : next);
  }

  function discardDraft() {
    if (commandDraft?.pending.length) {
      onDraftChange(commandFromAnt(ant));
      return;
    }
    onDraftDiscard();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !dirty || !commandDraft) return;
    setSaving(true);
    setError("");
    try {
      await onSave({ analysisRole: draft.analysisRole }, commandDraft);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form id={id} className="ant-order-editor well grid gap-3 p-3" onSubmit={submit}>
      <div>
        <p className="eyebrow">One choice for this ant</p>
        <h5 className="text-sm font-bold text-ink">Choose which match data it prioritizes</h5>
      </div>
      <AnalysisRoleSelector
        value={draft.analysisRole}
        disabled={disabled || saving}
        onChange={updateDraft}
        descriptionId={`${id}-role-help`}
      />

      {!ant.alive && <InlineNotice message="This ant is dead and cannot receive new orders." />}
      {error && <InlineError message={error} />}

      {dirty && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border-2 border-gold/35 bg-gold/10 px-3 py-2">
          <span className="text-xs font-bold text-gold-deep">Draft kept until you save or discard it.</span>
          <button type="button" className="quiet-link min-h-9 rounded-md px-2 text-xs" disabled={saving} onClick={discardDraft}>
            Discard draft
          </button>
        </div>
      )}

      <div className="sticky bottom-0 grid grid-cols-2 gap-2 border-t-2 border-[color:var(--brd-soft)] bg-[rgba(249,243,226,0.96)] pt-3">
        <button type="button" className="btn btn-ghost !min-h-11 px-3 py-2 text-sm" disabled={saving} onClick={onClose}>
          {dirty ? "Keep draft & close" : "View history"}
        </button>
        <button type="submit" className="btn btn-primary !min-h-11 px-3 py-2 text-sm" disabled={disabled || !dirty || saving} aria-busy={saving}>
          {saving ? "Applying role..." : `Apply ${optionLabel(ANALYSIS_ROLE_OPTIONS, draft.analysisRole)} role`}
        </button>
      </div>
      <p className="text-center text-[11px] font-bold text-ink-faint">Applies to next market</p>
    </form>
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

function doctrineFromStrategy(strategy: Pick<ColonyStrategy, "style">): ColonyDoctrineDraft {
  return { style: strategy.style };
}

function sameDoctrine(left: ColonyDoctrineDraft, right: ColonyDoctrineDraft): boolean {
  return left.style === right.style;
}

function analysisRoleFromAnt(ant: Ant): AnalysisRole {
  const storedRole = (ant.strategy as Partial<typeof ant.strategy>).analysisRole;
  if (storedRole && ANALYSIS_ROLE_OPTIONS.some((option) => option.value === storedRole)) {
    return storedRole;
  }
  if (ant.archetype === "momentum" || ant.archetype === "chaos") return "reactive";
  if (ant.archetype === "cautious" || ant.archetype === "data_first") return "statistical";
  return "situational";
}

function effectiveAnalysisRole(
  ant: Ant,
  draft?: CommandDraftEntry<AntCommandDraft>,
): AnalysisRole {
  return draft?.value.analysisRole ?? analysisRoleFromAnt(ant);
}

function commandFromAnt(ant: Ant): AntCommandDraft {
  return { analysisRole: analysisRoleFromAnt(ant) };
}

function sameAntCommand(draft: AntCommandDraft, ant: Ant): boolean {
  return draft.analysisRole === analysisRoleFromAnt(ant);
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

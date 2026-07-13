"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { ColonyStrategy } from "./types";

export interface AntCommandDraft {
  custom: boolean;
  strategy: ColonyStrategy;
}

interface PendingCommandSave<T> {
  saveId: string;
  editId: string;
  value: T;
  baseRevision: number;
}

export interface CommandDraftEntry<T> {
  value: T;
  baseRevision: number;
  editId: string;
  pending: PendingCommandSave<T>[];
}

export interface CommandDraftSubmission<T> {
  saveId: string;
  editId: string;
  value: T;
  baseRevision: number;
}

export interface ColonyCommandDrafts {
  global?: CommandDraftEntry<ColonyStrategy>;
  ants: Record<string, CommandDraftEntry<AntCommandDraft>>;
}

const STORAGE_PREFIX = "age-of-colony:command-drafts:";
const EMPTY_DRAFTS: ColonyCommandDrafts = Object.freeze({
  ants: Object.freeze({}),
});
const snapshots = new Map<string, ColonyCommandDrafts>();
const hydrated = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
let fallbackId = 0;

function draftKey(gameId: string, colonyId: string): string {
  return `${gameId}:${colonyId}`;
}

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

function nextId(prefix: "edit" | "save"): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  fallbackId += 1;
  return `${prefix}:${Date.now().toString(36)}:${fallbackId.toString(36)}`;
}

function revision(value: unknown, fallback = -1): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isStrategy(value: unknown): value is ColonyStrategy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ColonyStrategy>;
  return ["cautious", "balanced", "aggressive"].includes(String(candidate.style))
    && ["penalties", "corners", "momentum", "chaos", "balanced"].includes(String(candidate.favoriteContext))
    && ["low", "medium", "high"].includes(String(candidate.infoNeed));
}

function isAntDraft(value: unknown): value is AntCommandDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { custom?: unknown; strategy?: unknown };
  return typeof candidate.custom === "boolean" && isStrategy(candidate.strategy);
}

function cloneStrategy(value: ColonyStrategy): ColonyStrategy {
  return { ...value };
}

function cloneAntDraft(value: AntCommandDraft): AntCommandDraft {
  return { custom: value.custom, strategy: cloneStrategy(value.strategy) };
}

function normalizePending<T>(
  value: unknown,
  isValue: (candidate: unknown) => candidate is T,
  cloneValue: (candidate: T) => T,
): PendingCommandSave<T>[] {
  if (!Array.isArray(value)) return [];
  const pending: PendingCommandSave<T>[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const candidate = raw as Partial<PendingCommandSave<unknown>>;
    if (typeof candidate.saveId !== "string" || typeof candidate.editId !== "string" || !isValue(candidate.value)) continue;
    pending.push({
      saveId: candidate.saveId,
      editId: candidate.editId,
      value: cloneValue(candidate.value),
      baseRevision: revision(candidate.baseRevision),
    });
  }
  return pending;
}

function normalizeEntry<T>(
  raw: unknown,
  isValue: (candidate: unknown) => candidate is T,
  cloneValue: (candidate: T) => T,
): CommandDraftEntry<T> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as {
    value?: unknown;
    baseRevision?: unknown;
    editId?: unknown;
    pending?: unknown;
  };
  if (!isValue(candidate.value)) return null;
  return {
    value: cloneValue(candidate.value),
    baseRevision: revision(candidate.baseRevision),
    editId: typeof candidate.editId === "string" ? candidate.editId : nextId("edit"),
    pending: normalizePending(candidate.pending, isValue, cloneValue),
  };
}

function normalizeDrafts(value: unknown): ColonyCommandDrafts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { global?: unknown; ants?: unknown };

  // Schema v2 wraps every value with the server revision it was based on and
  // an edit token. Legacy values are retained with revision -1: the first
  // authoritative roster that already equals them safely reconciles them.
  const global = normalizeEntry(candidate.global, isStrategy, cloneStrategy)
    ?? (isStrategy(candidate.global) ? {
      value: cloneStrategy(candidate.global),
      baseRevision: -1,
      editId: nextId("edit"),
      pending: [],
    } : undefined);
  const ants: Record<string, CommandDraftEntry<AntCommandDraft>> = {};
  if (candidate.ants && typeof candidate.ants === "object" && !Array.isArray(candidate.ants)) {
    for (const [antId, rawDraft] of Object.entries(candidate.ants)) {
      const entry = normalizeEntry(rawDraft, isAntDraft, cloneAntDraft)
        ?? (isAntDraft(rawDraft) ? {
          value: cloneAntDraft(rawDraft),
          baseRevision: -1,
          editId: nextId("edit"),
          pending: [],
        } : null);
      if (entry) ants[antId] = entry;
    }
  }
  if (!global && Object.keys(ants).length === 0) return null;
  return { global, ants };
}

function hydrate(key: string): void {
  if (hydrated.has(key) || typeof window === "undefined") return;
  hydrated.add(key);
  try {
    const normalized = normalizeDrafts(JSON.parse(window.sessionStorage.getItem(storageKey(key)) || "null"));
    if (normalized) snapshots.set(key, normalized);
  } catch {
    try {
      window.sessionStorage.removeItem(storageKey(key));
    } catch {
      // Storage can be unavailable in privacy-restricted contexts.
    }
  }
}

function getSnapshot(key: string): ColonyCommandDrafts {
  hydrate(key);
  return snapshots.get(key) ?? EMPTY_DRAFTS;
}

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

function persist(key: string, next: ColonyCommandDrafts): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(key), JSON.stringify(next));
  } catch {
    // In-memory sharing still protects drafts when session storage is unavailable.
  }
}

function removeStored(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(storageKey(key));
  } catch {
    // The in-memory snapshot is still removed when storage is unavailable.
  }
}

function replaceSnapshot(key: string, next: ColonyCommandDrafts): void {
  if (!next.global && Object.keys(next.ants).length === 0) {
    snapshots.delete(key);
    removeStored(key);
  } else {
    snapshots.set(key, next);
    persist(key, next);
  }
  notify(key);
}

function sameStrategy(left: ColonyStrategy, right: ColonyStrategy): boolean {
  return left.style === right.style
    && left.favoriteContext === right.favoriteContext
    && left.infoNeed === right.infoNeed;
}

function sameAntDraft(left: AntCommandDraft, right: AntCommandDraft): boolean {
  return left.custom === right.custom
    && (!left.custom || sameStrategy(left.strategy, right.strategy));
}

function subscribe(key: string, listener: () => void): () => void {
  hydrate(key);
  const current = listeners.get(key) ?? new Set<() => void>();
  current.add(listener);
  listeners.set(key, current);
  return () => {
    current.delete(listener);
    if (!current.size) listeners.delete(key);
  };
}

function beginSave<T>(entry: CommandDraftEntry<T>, expectedEditId: string, cloneValue: (value: T) => T): {
  entry: CommandDraftEntry<T>;
  submission: CommandDraftSubmission<T>;
} | null {
  if (entry.editId !== expectedEditId) return null;
  const submission: CommandDraftSubmission<T> = {
    saveId: nextId("save"),
    editId: entry.editId,
    value: cloneValue(entry.value),
    baseRevision: entry.baseRevision,
  };
  return {
    submission,
    entry: {
      ...entry,
      pending: [...entry.pending, { ...submission }],
    },
  };
}

function reconcileEntry<T>(
  entry: CommandDraftEntry<T>,
  serverValue: T,
  serverRevision: number,
  equals: (left: T, right: T) => boolean,
  acknowledgedSaveId?: string,
): CommandDraftEntry<T> | null {
  const authoritativeRevision = revision(serverRevision);

  if (acknowledgedSaveId) {
    const acknowledged = entry.pending.find((pending) => pending.saveId === acknowledgedSaveId);
    if (!acknowledged) return entry;
    if (entry.editId === acknowledged.editId && equals(serverValue, acknowledged.value)) return null;
    return {
      ...entry,
      baseRevision: Math.max(entry.baseRevision, authoritativeRevision),
      pending: entry.pending.filter((pending) => pending.saveId !== acknowledgedSaveId),
    };
  }

  const eligible = entry.pending.filter((pending) => authoritativeRevision > pending.baseRevision);
  // If an older request can explain the observed server value, it must never
  // acknowledge a newer edit that happens to contain that same value. Rebase
  // the newer edit on this response and wait for its own acknowledgement.
  const olderExplainers = eligible.filter((pending) => (
    pending.editId !== entry.editId && equals(serverValue, pending.value)
  ));
  if (olderExplainers.length) {
    const explained = new Set(olderExplainers.map((pending) => pending.saveId));
    return {
      ...entry,
      baseRevision: Math.max(entry.baseRevision, authoritativeRevision),
      pending: entry.pending.filter((pending) => !explained.has(pending.saveId)),
    };
  }

  const currentExplainer = eligible.find((pending) => (
    pending.editId === entry.editId && equals(serverValue, pending.value)
  ));
  if (currentExplainer) return null;

  const obsolete = eligible.filter((pending) => pending.editId !== entry.editId);
  if (obsolete.length) {
    const obsoleteIds = new Set(obsolete.map((pending) => pending.saveId));
    return {
      ...entry,
      baseRevision: Math.max(entry.baseRevision, authoritativeRevision),
      pending: entry.pending.filter((pending) => !obsoleteIds.has(pending.saveId)),
    };
  }

  if (authoritativeRevision > entry.baseRevision && equals(serverValue, entry.value)) return null;
  return entry;
}

export function useColonyCommandDrafts(gameId: string, colonyId: string): ColonyCommandDrafts {
  const key = draftKey(gameId, colonyId);
  const subscribeToKey = useCallback((listener: () => void) => subscribe(key, listener), [key]);
  const readKey = useCallback(() => getSnapshot(key), [key]);
  return useSyncExternalStore(subscribeToKey, readKey, () => EMPTY_DRAFTS);
}

export function setGlobalCommandDraft(
  gameId: string,
  colonyId: string,
  draft: ColonyStrategy | null,
  baseRevision: number,
): void {
  const key = draftKey(gameId, colonyId);
  const current = getSnapshot(key);
  if (!draft) {
    replaceSnapshot(key, { ants: current.ants });
    return;
  }
  if (current.global && sameStrategy(current.global.value, draft)) return;
  replaceSnapshot(key, {
    global: {
      value: cloneStrategy(draft),
      baseRevision: Math.max(revision(baseRevision), current.global?.baseRevision ?? -1),
      editId: nextId("edit"),
      pending: current.global?.pending ?? [],
    },
    ants: current.ants,
  });
}

export function setAntCommandDraft(
  gameId: string,
  colonyId: string,
  antId: string,
  draft: AntCommandDraft | null,
  baseRevision: number,
): void {
  const key = draftKey(gameId, colonyId);
  const current = getSnapshot(key);
  const ants = { ...current.ants };
  const previous = ants[antId];
  if (!draft) delete ants[antId];
  else if (previous && sameAntDraft(previous.value, draft)) return;
  else {
    ants[antId] = {
      value: cloneAntDraft(draft),
      baseRevision: Math.max(revision(baseRevision), previous?.baseRevision ?? -1),
      editId: nextId("edit"),
      pending: previous?.pending ?? [],
    };
  }
  replaceSnapshot(key, {
    ...(current.global ? { global: current.global } : {}),
    ants,
  });
}

export function beginGlobalCommandSave(
  gameId: string,
  colonyId: string,
  expectedEditId: string,
): CommandDraftSubmission<ColonyStrategy> | null {
  const key = draftKey(gameId, colonyId);
  const current = getSnapshot(key);
  if (!current.global) return null;
  const started = beginSave(current.global, expectedEditId, cloneStrategy);
  if (!started) return null;
  replaceSnapshot(key, { global: started.entry, ants: current.ants });
  return started.submission;
}

export function beginAntCommandSave(
  gameId: string,
  colonyId: string,
  antId: string,
  expectedEditId: string,
): CommandDraftSubmission<AntCommandDraft> | null {
  const key = draftKey(gameId, colonyId);
  const current = getSnapshot(key);
  const entry = current.ants[antId];
  if (!entry) return null;
  const started = beginSave(entry, expectedEditId, cloneAntDraft);
  if (!started) return null;
  replaceSnapshot(key, {
    ...(current.global ? { global: current.global } : {}),
    ants: { ...current.ants, [antId]: started.entry },
  });
  return started.submission;
}

export function reconcileGlobalCommandDraft(
  gameId: string,
  colonyId: string,
  serverValue: ColonyStrategy,
  serverRevision: number,
  acknowledgedSaveId?: string,
): void {
  const key = draftKey(gameId, colonyId);
  const current = getSnapshot(key);
  if (!current.global) return;
  const nextGlobal = reconcileEntry(current.global, serverValue, serverRevision, sameStrategy, acknowledgedSaveId);
  if (nextGlobal === current.global) return;
  replaceSnapshot(key, {
    ...(nextGlobal ? { global: nextGlobal } : {}),
    ants: current.ants,
  });
}

export function reconcileAntCommandDraft(
  gameId: string,
  colonyId: string,
  antId: string,
  serverValue: AntCommandDraft,
  serverRevision: number,
  acknowledgedSaveId?: string,
): void {
  const key = draftKey(gameId, colonyId);
  const current = getSnapshot(key);
  const entry = current.ants[antId];
  if (!entry) return;
  const nextEntry = reconcileEntry(entry, serverValue, serverRevision, sameAntDraft, acknowledgedSaveId);
  if (nextEntry === entry) return;
  const ants = { ...current.ants };
  if (nextEntry) ants[antId] = nextEntry;
  else delete ants[antId];
  replaceSnapshot(key, {
    ...(current.global ? { global: current.global } : {}),
    ants,
  });
}

export function discardColonyCommandDrafts(gameId: string, colonyId: string): void {
  const key = draftKey(gameId, colonyId);
  hydrated.add(key);
  snapshots.delete(key);
  removeStored(key);
  notify(key);
}

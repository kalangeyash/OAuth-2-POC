/*
 * Presenter state: what is selected, which panel is open, which filters apply,
 * which explanations are showing. Shared by every panel through one context, so
 * the canvas, the network monitor, the timeline and the inspector always agree.
 *
 * Nothing here is persisted: the browser stores exactly one thing (the theme).
 * That is a teaching point, and "What can the browser see?" checks it live.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { DIRECTION_ACTORS } from "../../server/src/timeline";
import { isFailure } from "./model";
import type { ActorId, Channel, TimelineStepId, WireEntry } from "./types";

export type DockTab =
  | "traffic"
  | "timeline"
  | "builder"
  | "pkce"
  | "state"
  | "browser"
  | "tokens"
  | "patient"
  | "scenarios"
  | "app";

export interface Filters {
  actors: ActorId[];
  channels: Channel[];
  status: "all" | "success" | "error";
  search: string;
}

export const EMPTY_FILTERS: Filters = { actors: [], channels: [], status: "all", search: "" };

/** Essentials: real messages, security checks, failures and deliberate changes. Everything: every recorded step. */
export type DetailLevel = "essentials" | "everything";

export interface Presenter {
  selectedId: number | null;
  /** A presenter's own choice: it takes the wheel, so "Follow live" switches off. */
  select: (id: number | null) => void;
  /** Used by the live stream and breakpoints: moves the selection without changing Follow live. */
  followTo: (id: number | null) => void;
  dockTab: DockTab;
  setDockTab: (tab: DockTab) => void;
  detailLevel: DetailLevel;
  setDetailLevel: (level: DetailLevel) => void;
  /** Freeze the display (not the protocol): new events wait until unfrozen. */
  frozen: boolean;
  setFrozen: (frozen: boolean) => void;
  showDetails: boolean;
  showSecurity: boolean;
  showSource: boolean;
  inspectorOpen: boolean;
  toggle: (name: "showDetails" | "showSecurity" | "showSource" | "inspectorOpen" | "followLive" | "popupMode" | "failureInjection") => void;
  followLive: boolean;
  popupMode: boolean;
  /** Show injection buttons at breakpoints. Off by default so nothing breaks by accident. */
  failureInjection: boolean;
  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;
  replayStep: TimelineStepId | null;
  setReplayStep: (step: TimelineStepId | null) => void;
  pinned: number[];
  togglePin: (id: number) => void;
  compare: number[];
  toggleCompare: (id: number) => void;
  glossaryTerm: string | null;
  explain: (term: string | null) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
}

const PresenterContext = createContext<Presenter | null>(null);

export function PresenterProvider({ value, children }: { value: Presenter; children: ReactNode }) {
  return <PresenterContext.Provider value={value}>{children}</PresenterContext.Provider>;
}

export function usePresenter(): Presenter {
  const presenter = useContext(PresenterContext);
  if (!presenter) throw new Error("usePresenter() outside PresenterProvider");
  return presenter;
}

export function usePresenterState(): Presenter {
  const [selectedId, followTo] = useState<number | null>(null);
  const [dockTab, setDockTab] = useState<DockTab>("traffic");
  const [detailLevel, setDetailLevel] = useState<DetailLevel>("essentials");
  const [frozen, setFrozen] = useState(false);
  const [flags, setFlags] = useState({
    showDetails: true,
    showSecurity: true,
    showSource: true,
    inspectorOpen: true,
    followLive: true,
    popupMode: true,
    failureInjection: false,
  });
  const [filters, setFilterState] = useState<Filters>(EMPTY_FILTERS);
  const [replayStep, setReplayStep] = useState<TimelineStepId | null>(null);
  const [pinned, setPinned] = useState<number[]>([]);
  const [compare, setCompare] = useState<number[]>([]);
  const [glossaryTerm, explain] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const toggle = useCallback<Presenter["toggle"]>((name) => setFlags((current) => ({ ...current, [name]: !current[name] })), []);
  const select = useCallback((id: number | null) => {
    followTo(id);
    if (id !== null) setFlags((current) => (current.followLive ? { ...current, followLive: false } : current));
  }, []);
  const setFilters = useCallback((patch: Partial<Filters>) => setFilterState((current) => ({ ...current, ...patch })), []);
  const togglePin = useCallback(
    (id: number) => setPinned((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id])),
    [],
  );
  const toggleCompare = useCallback(
    (id: number) =>
      setCompare((current) =>
        current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(-2),
      ),
    [],
  );

  return useMemo(
    () => ({
      selectedId,
      select,
      followTo,
      dockTab,
      setDockTab,
      detailLevel,
      setDetailLevel,
      frozen,
      setFrozen,
      ...flags,
      toggle,
      filters,
      setFilters,
      replayStep,
      setReplayStep,
      pinned,
      togglePin,
      compare,
      toggleCompare,
      glossaryTerm,
      explain,
      shortcutsOpen,
      setShortcutsOpen,
    }),
    [selectedId, select, dockTab, detailLevel, frozen, flags, toggle, filters, setFilters, replayStep, pinned, togglePin, compare, toggleCompare, glossaryTerm, shortcutsOpen],
  );
}

/**
 * What "Essentials" keeps: every real message on the front or back channel, every
 * browser/React request to our server, the two security checks (state, PKCE),
 * anything that failed, anything deliberately changed, and the request the
 * debugger is holding right now. It hides routine steps inside Node (generate
 * state, store session…) and past pause markers; "Everything" shows them.
 */
export function isEssential(entry: WireEntry, heldEntryId: number | null = null): boolean {
  if (entry.id === heldEntryId) return true;
  if (entry.breakpoint) return false;
  if (entry.direction !== "internal") return true;
  if (isFailure(entry)) return true;
  if (entry.demo?.modified || entry.injection) return true;
  return entry.detail?.kind === "state-check" || entry.detail?.kind === "pkce-proof";
}

/** Every actor a message touches: an authorization redirect also passes through the browser. */
export function actorsInvolved(entry: WireEntry): ActorId[] {
  const { from, to } = DIRECTION_ACTORS[entry.direction];
  const actors = new Set<ActorId>([from, to]);
  if (entry.direction === "auth-browser") actors.add("browser");
  if (entry.direction === "browser-auth") actors.add("node");
  return [...actors];
}

export function matchesFilters(entry: WireEntry, filters: Filters): boolean {
  if (filters.actors.length > 0 && !actorsInvolved(entry).some((actor) => filters.actors.includes(actor))) return false;
  if (filters.channels.length > 0 && !filters.channels.includes(entry.channel)) return false;
  if (filters.status === "error" && !isFailure(entry)) return false;
  if (filters.status === "success" && isFailure(entry)) return false;
  const search = filters.search.trim().toLowerCase();
  if (search) {
    const haystack = [
      entry.step,
      entry.method,
      entry.endpoint,
      String(entry.status ?? ""),
      JSON.stringify(entry.params ?? {}),
      JSON.stringify(entry.result ?? {}),
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  return true;
}

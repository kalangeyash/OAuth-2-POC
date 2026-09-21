import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, startAuthorizationFlow, toTeachingError } from "./api";
import { describeNow } from "./flow";
import { deriveFlowModel } from "./model";
import { matchesFilters, PresenterProvider, usePresenterState, type DockTab } from "./presenter";
import { SCENARIOS, type Scenario } from "./scenarios";
import { useTheme } from "./theme";
import { useEventStream } from "./useEventStream";
import { BrowserVisibility } from "./components/BrowserVisibility";
import { GlossaryDialog, ShortcutsDialog } from "./components/Dialogs";
import { DiscoveryPanel } from "./components/DiscoveryPanel";
import { ErrorNotice } from "./components/ErrorNotice";
import { FailureLab } from "./components/FailureLab";
import { LabTable } from "./components/LabTable";
import { LabToolbar } from "./components/LabToolbar";
import { MessageInspector } from "./components/MessageInspector";
import { NetworkMonitor } from "./components/NetworkMonitor";
import { NowPanel } from "./components/NowPanel";
import { PatientContext } from "./components/PatientContext";
import { PatientPanel } from "./components/PatientPanel";
import { PkceWorkbench } from "./components/PkceWorkbench";
import { ProtocolCanvas, SeqMarkers } from "./components/ProtocolCanvas";
import { RequestBuilder } from "./components/RequestBuilder";
import { ScopeComparison } from "./components/ScopeComparison";
import { StateLab } from "./components/StateLab";
import { Timeline } from "./components/Timeline";
import { TokenLifecycle } from "./components/TokenLifecycle";
import type {
  BuilderModId,
  DemoId,
  DiscoveryInfo,
  InjectionId,
  LabMode,
  LabResults,
  Load,
  PatientSummary,
  SessionInfo,
  TeachingError,
  WireEntry,
} from "./types";

const SESSION_POLL_MS = 2000;
const LIVE_HIGHLIGHT_MS = 3000;

const DOCK_TABS: { id: DockTab; label: string }[] = [
  { id: "traffic", label: "Traffic" },
  { id: "timeline", label: "Timeline" },
  { id: "builder", label: "Request builder" },
  { id: "pkce", label: "PKCE" },
  { id: "state", label: "State / CSRF" },
  { id: "browser", label: "Browser view" },
  { id: "tokens", label: "Tokens" },
  { id: "patient", label: "Patient context" },
  { id: "scenarios", label: "Failure lab" },
  { id: "app", label: "App" },
];

export function App() {
  const presenter = usePresenterState();
  const { theme, setTheme } = useTheme();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [serverReachable, setServerReachable] = useState(true);
  const [discovery, setDiscovery] = useState<Load<DiscoveryInfo>>({ state: "loading" });
  const [discoveryRefreshing, setDiscoveryRefreshing] = useState(false);
  const [patient, setPatient] = useState<Load<PatientSummary>>({ state: "idle" });
  const [labs, setLabs] = useState<Load<LabResults>>({ state: "idle" });
  const [requestError, setRequestError] = useState<TeachingError | null>(null);
  const [running, setRunning] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const [scenario, setScenario] = useState<Scenario>(SCENARIOS[0]);
  const [liveIds, setLiveIds] = useState<Set<number>>(new Set());
  const [frozenEntries, setFrozenEntries] = useState<WireEntry[] | null>(null);
  const [dockSize, setDockSize] = useState<"min" | "half" | "tall">("half");
  const popupRef = useRef<Window | null>(null);
  const sessionTimer = useRef<number | undefined>(undefined);

  // Read inside the stream callback without re-subscribing it.
  const followRef = useRef({ followLive: presenter.followLive, frozen: presenter.frozen, followTo: presenter.followTo });
  followRef.current = { followLive: presenter.followLive, frozen: presenter.frozen, followTo: presenter.followTo };

  // The UI learns the authorization state from safe metadata only. It never receives a token.
  const refreshSession = useCallback(async () => {
    try {
      setSession(await api.session());
      setServerReachable(true);
    } catch {
      setServerReachable(false);
    } finally {
      setSessionLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
    const timer = window.setInterval(refreshSession, SESSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshSession]);

  // Every live event: refresh the session metadata at once, highlight the new arrow, follow it.
  const onLiveEntry = useCallback(
    (entry: WireEntry) => {
      window.clearTimeout(sessionTimer.current);
      sessionTimer.current = window.setTimeout(() => void refreshSession(), 150);
      setLiveIds((current) => new Set(current).add(entry.id));
      window.setTimeout(() => {
        setLiveIds((current) => {
          const next = new Set(current);
          next.delete(entry.id);
          return next;
        });
      }, LIVE_HIGHLIGHT_MS);
      const follow = followRef.current;
      if (follow.followLive && !follow.frozen) follow.followTo(entry.id);
    },
    [refreshSession],
  );
  const stream = useEventStream(onLiveEntry);
  const { lab } = stream;

  // Freeze the DISPLAY (never the protocol): keep a snapshot until unfrozen.
  useEffect(() => {
    setFrozenEntries(presenter.frozen ? stream.entries : null);
    // Only when the toggle changes: the snapshot must not follow new entries.
  }, [presenter.frozen]);
  const displayEntries = frozenEntries ?? stream.entries;
  const bufferedCount = frozenEntries ? stream.entries.filter((entry) => entry.id > (frozenEntries.at(-1)?.id ?? 0)).length : 0;
  const model = useMemo(() => deriveFlowModel(displayEntries), [displayEntries]);

  // A breakpoint is the most important thing on screen: select it.
  useEffect(() => {
    if (lab.breakpoint) presenter.followTo(lab.breakpoint.entryId);
  }, [lab.breakpoint?.entryId]);

  const loadDiscovery = useCallback(async (force: boolean) => {
    if (force) setDiscoveryRefreshing(true);
    else setDiscovery({ state: "loading" });
    try {
      const data = force ? await api.refreshDiscovery() : await api.discovery();
      setDiscovery({ state: "ready", data });
    } catch (error) {
      setDiscovery({ state: "error", error: toTeachingError(error) });
    } finally {
      setDiscoveryRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadDiscovery(false);
  }, [loadDiscovery]);

  const authorized = session?.authorized ?? false;

  // Displayed data belongs to an authorization. When that is gone, so is the data.
  useEffect(() => {
    if (!authorized) {
      setPatient({ state: "idle" });
      setLabs({ state: "idle" });
    }
  }, [authorized]);

  // Step 19 is reported only after React has rendered the FHIR data.
  useEffect(() => {
    if (patient.state === "ready" && labs.state === "ready") {
      void api.markRendered().then(refreshSession).catch(() => undefined);
    }
  }, [patient, labs, refreshSession]);

  // The authorization popup: when it closes, the flow has finished (or was abandoned).
  useEffect(() => {
    if (!popupOpen) return;
    const timer = window.setInterval(() => {
      if (!popupRef.current || popupRef.current.closed) {
        popupRef.current = null;
        setPopupOpen(false);
        void refreshSession();
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [popupOpen, refreshSession]);

  const startAuth = useCallback(
    (path: string) => {
      setRequestError(null);
      presenter.setReplayStep(null);
      const popup = startAuthorizationFlow(path, presenter.popupMode);
      if (popup) {
        popupRef.current = popup;
        setPopupOpen(true);
      }
    },
    [presenter],
  );

  async function loadPatientData() {
    setPatient({ state: "loading" });
    setLabs({ state: "loading" });
    setRequestError(null);
    try {
      // One request at a time: either may refresh the tokens held in the same server-side session.
      const { patient: loaded } = await api.patient();
      setPatient({ state: "ready", data: loaded });
      setLabs({ state: "ready", data: await api.labs() });
    } catch (error) {
      const teaching = toTeachingError(error);
      setPatient((current) => (current.state === "ready" ? current : { state: "error", error: teaching }));
      setLabs({ state: "error", error: teaching });
    } finally {
      void refreshSession();
    }
  }

  const runPostDemo = useCallback(
    async (demo: DemoId) => {
      setRunning(true);
      setRequestError(null);
      try {
        await api.runPostDemo(demo);
      } catch (error) {
        setRequestError(toTeachingError(error));
      } finally {
        setRunning(false);
        void refreshSession();
      }
    },
    [refreshSession],
  );

  const tryOtherPatient = useCallback(async () => {
    setRunning(true);
    setRequestError(null);
    try {
      // The server ignores this ID and answers with the authorized patient.
      const { patient: loaded } = await api.patient("123");
      setPatient({ state: "ready", data: loaded });
    } catch (error) {
      setRequestError(toTeachingError(error));
    } finally {
      setRunning(false);
      void refreshSession();
    }
  }, [refreshSession]);

  const runScenario = useCallback(
    (chosen: Scenario = scenario) => {
      setScenario(chosen);
      switch (chosen.run.kind) {
        case "connect":
          startAuth("/auth/login");
          break;
        case "redirect-demo":
          startAuth(`/demo/${chosen.run.demo}`);
          break;
        case "builder":
          startAuth(`/lab/authorize?mods=${chosen.run.mods.join(",")}`);
          break;
        case "post-demo":
          void runPostDemo(chosen.run.demo);
          break;
        case "patient-override":
          void tryOtherPatient();
          break;
        case "illustration":
          presenter.setDockTab("scenarios");
          break;
      }
    },
    [scenario, startAuth, runPostDemo, tryOtherPatient, presenter],
  );

  const generateRequest = useCallback((mods: BuilderModId[]) => startAuth(`/lab/authorize?mods=${mods.join(",")}`), [startAuth]);

  const setMode = useCallback(async (mode: LabMode) => {
    try {
      await api.labMode(mode);
    } catch (error) {
      setRequestError(toTeachingError(error));
    }
  }, []);

  const decide = useCallback(
    async (action: "send" | "run" | "abort", inject?: InjectionId) => {
      if (!lab.breakpoint) return;
      setDeciding(true);
      try {
        await api.labDecide(lab.breakpoint.id, action, inject);
      } catch (error) {
        setRequestError(toTeachingError(error));
      } finally {
        setDeciding(false);
      }
    },
    [lab.breakpoint],
  );

  const reset = useCallback(
    async (all: boolean) => {
      await api.labReset(true).catch(() => undefined);
      if (all) await api.logout().catch(() => undefined);
      setRequestError(null);
      setPatient({ state: "idle" });
      setLabs({ state: "idle" });
      presenter.select(null);
      presenter.setReplayStep(null);
      void refreshSession();
    },
    [presenter, refreshSession],
  );

  async function logOut() {
    await api.logout().catch(() => undefined);
    setRequestError(null);
    void refreshSession();
  }

  /** Arm the debugger (and failure injection), then start a normal flow. */
  const stepAndConnect = useCallback(
    async (mode: LabMode) => {
      if (!presenter.failureInjection) presenter.toggle("failureInjection");
      await setMode(mode);
      startAuth("/auth/login");
    },
    [presenter, setMode, startAuth],
  );

  const runDisabledReason = (chosen: Scenario): string | null => {
    if (!serverReachable) return "The Node server is not answering.";
    if (popupOpen) return "An authorization is already in progress in the popup window.";
    if (running) return "Running…";
    if (chosen.needsConnection && !authorized) return "Connect first: this scenario needs stored tokens.";
    return null;
  };

  // Previous / next message, over what the filters show.
  const stepSelection = useCallback(
    (delta: 1 | -1) => {
      const list = displayEntries.filter((entry) => matchesFilters(entry, presenter.filters));
      if (list.length === 0) return;
      const index = list.findIndex((entry) => entry.id === presenter.selectedId);
      const next = index === -1 ? (delta === 1 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, index + delta));
      presenter.select(list[next].id);
    },
    [displayEntries, presenter],
  );

  // Presenter keyboard shortcuts. They drive the same actions as the buttons.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("dialog[open]")) return;
      const onControl = Boolean(target?.closest("button, a, summary, [role='tab']"));
      switch (event.key) {
        case " ":
          if (onControl) return; // Space activates the focused control.
          event.preventDefault();
          void setMode(lab.mode === "run" ? "step" : "run");
          break;
        case "ArrowRight":
          event.preventDefault();
          if (lab.breakpoint) void decide("send");
          else stepSelection(1);
          break;
        case "ArrowLeft":
          event.preventDefault();
          stepSelection(-1);
          break;
        case "r":
        case "R":
          if (!runDisabledReason(scenario)) runScenario();
          break;
        case "f":
        case "F":
          presenter.setDockTab("scenarios");
          break;
        case "t":
        case "T":
          presenter.setDockTab("timeline");
          break;
        case "i":
        case "I":
          presenter.toggle("inspectorOpen");
          break;
        case "s":
        case "S":
          presenter.toggle("showSecurity");
          break;
        case "d":
        case "D":
          presenter.toggle("showDetails");
          break;
        case "e":
        case "E":
          presenter.setDetailLevel(presenter.detailLevel === "essentials" ? "everything" : "essentials");
          break;
        case "?":
          presenter.setShortcutsOpen(true);
          break;
        case "Escape":
          presenter.setReplayStep(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const narration = describeNow({
    entries: displayEntries,
    model,
    lab,
    serverReachable,
    loaded: stream.loaded && sessionLoaded,
    frozen: presenter.frozen,
    bufferedCount,
    replayStep: presenter.replayStep,
    awaitingAuthorizationServer: session?.awaitingAuthorizationServer ?? false,
    lastError: session?.lastError ?? null,
  });

  let connection = { className: "connection", text: "Not connected" };
  if (!serverReachable) connection = { className: "connection is-down", text: "Node server unreachable" };
  else if (lab.breakpoint) connection = { className: "connection is-waiting", text: "Paused at a breakpoint" };
  else if (authorized) connection = { className: "connection is-connected", text: "Connected" };
  else if (session?.awaitingAuthorizationServer) connection = { className: "connection is-waiting", text: "At the authorization server" };

  const visibleError = session?.lastError ?? requestError;
  const findScenario = (id: string) => SCENARIOS.find((item) => item.id === id) ?? SCENARIOS[0];

  const panel = (() => {
    switch (presenter.dockTab) {
      case "traffic":
        return <NetworkMonitor entries={displayEntries} />;
      case "timeline":
        return <Timeline model={model} />;
      case "builder":
        return <RequestBuilder model={model} session={session} onGenerate={generateRequest} busy={popupOpen} />;
      case "pkce":
        return (
          <PkceWorkbench
            model={model}
            onRunScenario={() => runScenario(findScenario("missing-pkce"))}
            onStepAndAlter={() => void stepAndConnect("messages")}
          />
        );
      case "state":
        return (
          <StateLab
            model={model}
            onRunTamperScenario={() => runScenario(findScenario("invalid-state"))}
            onTamperAtBreakpoint={() => void stepAndConnect("step")}
            onRemoveState={() => generateRequest(["remove-state"])}
          />
        );
      case "browser":
        return <BrowserVisibility session={session} model={model} />;
      case "tokens":
        return (
          <TokenLifecycle
            model={model}
            session={session}
            discovery={discovery.state === "ready" ? discovery.data : null}
            running={running}
            onForceExpiry={() => runScenario(findScenario("expired-token"))}
            onDisableRefresh={() => void runPostDemo("refresh-disabled")}
            onRefreshFailure={() => runScenario(findScenario("refresh-failure"))}
          />
        );
      case "patient":
        return <PatientContext model={model} session={session} busy={running} onTryOtherPatient={() => runScenario(findScenario("patient-override"))} />;
      case "scenarios":
        return (
          <FailureLab
            scenario={scenario}
            onSelect={setScenario}
            onRun={() => runScenario()}
            onReset={() => void reset(false)}
            runDisabledReason={runDisabledReason(scenario)}
            session={session}
            entries={displayEntries}
            model={model}
          />
        );
      case "app":
        return (
          <div className="app-view">
            {authorized && session ? (
              <>
                <PatientPanel session={session} patient={patient} onLoad={() => void loadPatientData()} />
                <LabTable labs={labs} onRetry={() => void loadPatientData()} />
              </>
            ) : (
              <section className="section connect">
                <h2>Connect to the SMART sandbox</h2>
                <p>
                  {presenter.popupMode
                    ? "The sandbox's login and consent pages open in a popup, so this lab stays on screen and shows every message live."
                    : "Your browser goes to the sandbox's login and consent pages, then comes back here."}
                </p>
                <button type="button" className="button primary big" onClick={() => runScenario(SCENARIOS[0])} disabled={popupOpen}>
                  Connect
                </button>
              </section>
            )}
            <ScopeComparison
              current={session?.scopeDiff ?? null}
              requestedScope={session?.requestedScope ?? null}
              authorized={authorized}
              lastError={session?.lastError ?? null}
              narrow={session?.scopeComparison?.narrow}
              broad={session?.scopeComparison?.broad}
            />
            <DiscoveryPanel discovery={discovery} refreshing={discoveryRefreshing} onRefresh={() => void loadDiscovery(true)} />
          </div>
        );
    }
  })();

  return (
    <PresenterProvider value={presenter}>
      <div className={`lab${presenter.inspectorOpen ? "" : " no-inspector"} dock-${dockSize}`}>
        <SeqMarkers />
        <div className="synthetic-banner" role="note">
          <strong>DEMO / SYNTHETIC DATA</strong>
          <p>Public sandbox, synthetic patients. Every secret is redacted on the server before it reaches this page.</p>
        </div>

        <header className="masthead">
          <div>
            <h1>SMART on FHIR · OAuth 2.0 Protocol Lab</h1>
            <p className="masthead-subtitle">
              Stop it, inspect it, understand it, modify it, break it. Every message is real; the browser never holds a token.
            </p>
          </div>
          <div className="masthead-actions">
            <p className={connection.className} role="status" aria-live="polite" aria-atomic="true">
              <span className="connection-dot" aria-hidden="true" />
              {connection.text}
            </p>
            <button
              type="button"
              className="button small theme-toggle"
              aria-pressed={theme === "dark"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? "Light" : "Dark"}
            </button>
            {authorized && (
              <button type="button" className="button small" onClick={() => void logOut()}>
                Log out
              </button>
            )}
          </div>
        </header>

        <LabToolbar
          lab={lab}
          scenario={scenario}
          onScenario={setScenario}
          onRun={() => runScenario()}
          runDisabledReason={runDisabledReason(scenario)}
          onMode={(mode) => void setMode(mode)}
          onDecide={(action) => void decide(action)}
          onReset={(all) => void reset(all)}
          bufferedCount={bufferedCount}
          streamStatus={stream.status}
        />

        <NowPanel narration={narration} model={model} />

        {/* Always present, so a screen reader announces a change into it. */}
        <div className="lab-alert" role="status" aria-live="assertive" aria-atomic="true">
          {visibleError && (
            <ErrorNotice
              error={visibleError}
              onReconnect={visibleError.reauthRequired ? () => runScenario(SCENARIOS[0]) : undefined}
            />
          )}
        </div>

        <main className="workspace">
          <div className="stage">
            <ProtocolCanvas
              entries={displayEntries}
              runEntries={model.run}
              lab={lab}
              liveIds={liveIds}
              awaitingAuthorizationServer={session?.awaitingAuthorizationServer ?? false}
            />
            <section className="dock" aria-label="Lab panels">
              <div className="dock-tabs" role="tablist" aria-label="Lab panels">
                {DOCK_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    id={`dock-tab-${tab.id}`}
                    aria-selected={presenter.dockTab === tab.id}
                    aria-controls="dock-panel"
                    className="dock-tab"
                    onClick={() => presenter.setDockTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="button small dock-size"
                  onClick={() => setDockSize(dockSize === "half" ? "tall" : dockSize === "tall" ? "min" : "half")}
                  title="Change the height of this panel"
                >
                  {dockSize === "half" ? "▲ Taller" : dockSize === "tall" ? "▼ Smaller" : "▲ Half"}
                </button>
              </div>
              <div className="dock-panel" id="dock-panel" role="tabpanel" aria-labelledby={`dock-tab-${presenter.dockTab}`}>
                {panel}
              </div>
            </section>
          </div>
          {presenter.inspectorOpen && (
            <MessageInspector entries={displayEntries} lab={lab} onDecide={(action, inject) => void decide(action, inject)} deciding={deciding} onStep={stepSelection} />
          )}
        </main>

        <GlossaryDialog />
        <ShortcutsDialog />
      </div>
    </PresenterProvider>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, navigateTo, toTeachingError } from "./api";
import { describeFlow } from "./flow";
import { useTheme } from "./theme";
import { DiscoveryPanel } from "./components/DiscoveryPanel";
import { ErrorNotice } from "./components/ErrorNotice";
import { FailureDemoPanel } from "./components/FailureDemoPanel";
import { FlowBand } from "./components/FlowBand";
import { FlowRail } from "./components/FlowRail";
import { LabTable } from "./components/LabTable";
import { PatientPanel } from "./components/PatientPanel";
import { ScopeComparison } from "./components/ScopeComparison";
import { WireLog } from "./components/WireLog";
import type { DiscoveryInfo, LabResults, Load, PatientSummary, SessionInfo, TeachingError, WireEntry } from "./types";

const SESSION_POLL_MS = 2000;
const WIRE_LOG_POLL_MS = 1000;
const MAX_WIRE_ENTRIES = 500;

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [serverReachable, setServerReachable] = useState(true);
  const [discovery, setDiscovery] = useState<Load<DiscoveryInfo>>({ state: "loading" });
  const [discoveryRefreshing, setDiscoveryRefreshing] = useState(false);
  const [patient, setPatient] = useState<Load<PatientSummary>>({ state: "idle" });
  const [labs, setLabs] = useState<Load<LabResults>>({ state: "idle" });
  const [requestError, setRequestError] = useState<TeachingError | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);
  const [entries, setEntries] = useState<WireEntry[]>([]);
  const lastEntryId = useRef(0);
  const pollingWireLog = useRef(false);
  const { theme, setTheme } = useTheme();

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

  // Live wire log: fetch only the entries newer than the last one received.
  useEffect(() => {
    async function poll() {
      if (pollingWireLog.current) return;
      pollingWireLog.current = true;
      try {
        const { entries: fresh, latestId } = await api.wireLog(lastEntryId.current);
        if (latestId < lastEntryId.current) {
          // The Node server restarted, so its log numbering started again.
          lastEntryId.current = 0;
          setEntries([]);
        } else if (fresh.length > 0) {
          lastEntryId.current = fresh[fresh.length - 1].id;
          setEntries((current) => [...current, ...fresh].slice(-MAX_WIRE_ENTRIES));
        }
      } catch {
        // An unreachable server is reported by the session poll.
      } finally {
        pollingWireLog.current = false;
      }
    }
    void poll();
    const timer = window.setInterval(poll, WIRE_LOG_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

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

  // Stepper step 9 is reported only after React has rendered the FHIR data.
  useEffect(() => {
    if (patient.state === "ready" && labs.state === "ready") {
      void api.markRendered().then(refreshSession).catch(() => undefined);
    }
  }, [patient, labs, refreshSession]);

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

  async function forceTokenExpiry() {
    setDemoRunning(true);
    setRequestError(null);
    try {
      await api.forceTokenExpiry();
    } catch (error) {
      setRequestError(toTeachingError(error));
    } finally {
      setDemoRunning(false);
      void refreshSession();
    }
  }

  async function logOut() {
    await api.logout().catch(() => undefined);
    setRequestError(null);
    void refreshSession();
  }

  async function clearWireLog() {
    await api.clearWireLog().catch(() => undefined);
    setEntries([]);
  }

  const loadingData = patient.state === "loading" || labs.state === "loading";
  const hasData = patient.state === "ready" && labs.state === "ready";

  const narration = useMemo(
    () =>
      describeFlow({
        flow: session?.flow ?? [],
        awaitingAuthorizationServer: session?.awaitingAuthorizationServer ?? false,
        authorized,
        lastError: session?.lastError ?? null,
        serverReachable,
        sessionLoaded,
        loadingData,
        hasData,
      }),
    [session, authorized, serverReachable, sessionLoaded, loadingData, hasData],
  );

  let connection = { className: "connection", text: "Not connected" };
  if (!serverReachable) {
    connection = { className: "connection is-down", text: "Node server unreachable" };
  } else if (authorized) {
    connection = { className: "connection is-connected", text: "Connected" };
  } else if (session?.awaitingAuthorizationServer) {
    connection = { className: "connection is-waiting", text: "Waiting for the authorization server" };
  }

  const visibleError = session?.lastError ?? requestError;
  const discoveryPanel = (
    <DiscoveryPanel
      discovery={discovery}
      refreshing={discoveryRefreshing}
      onRefresh={() => void loadDiscovery(true)}
    />
  );

  return (
    <div className="app">
      <div className="synthetic-banner" role="note">
        <strong>DEMO / SYNTHETIC DATA</strong>
        <p>This application uses a public sandbox containing synthetic healthcare data.</p>
      </div>

      <header className="masthead">
        <div>
          <h1>SMART on FHIR: the OAuth 2.0 authorization code flow</h1>
          <p className="masthead-subtitle">
            Authorization Code with PKCE. The Node server is the OAuth client, and the browser never holds a token.
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

      <FlowBand narration={narration} />

      <main className="panes">
        <aside className="pane pane-flow" aria-label="OAuth flow steps" tabIndex={-1}>
          <FlowRail steps={session?.flow ?? []} known={sessionLoaded && serverReachable} />
        </aside>

        <section className="pane pane-app" aria-label="Application and FHIR data">
          {/* Always present, so a screen reader announces a change into it. */}
          <div role="status" aria-live="assertive" aria-atomic="true">
            {visibleError && (
              <ErrorNotice
                error={visibleError}
                onReconnect={visibleError.reauthRequired ? () => navigateTo("/auth/login") : undefined}
              />
            )}
          </div>

          {authorized && session ? (
            <>
              <PatientPanel
                session={session}
                patient={patient}
                onLoad={() => void loadPatientData()}
              />
              <ScopeComparison
                current={session.scopeDiff}
                requestedScope={session.requestedScope}
                authorized={authorized}
                lastError={session.lastError ?? null}
                narrow={session.scopeComparison?.narrow}
                broad={session.scopeComparison?.broad}
              />
              <LabTable labs={labs} onRetry={() => void loadPatientData()} />
              <details className="section discovery-details">
                <summary>SMART discovery document</summary>
                {discoveryPanel}
              </details>
            </>
          ) : (
            <>
              <section className="section connect">
                <h2>Connect to the SMART sandbox</h2>
                <p>
                  Your browser goes to the sandbox's login and consent screens, then comes back here. The Node server
                  exchanges the authorization code for tokens and keeps them.
                </p>
                <button type="button" className="button primary big" onClick={() => navigateTo("/auth/login")}>
                  Connect
                </button>
                <p className="lede">Status: {connection.text}.</p>
              </section>
              <ScopeComparison
                current={null}
                requestedScope={session?.requestedScope ?? null}
                authorized={false}
                lastError={session?.lastError ?? null}
                narrow={session?.scopeComparison?.narrow}
                broad={session?.scopeComparison?.broad}
              />
              {discoveryPanel}
            </>
          )}

          <FailureDemoPanel
            authorized={authorized}
            demo={session?.demo ?? null}
            entries={entries}
            running={demoRunning}
            onForceExpiry={() => void forceTokenExpiry()}
          />
        </section>

        <section className="pane pane-wire" aria-label="Wire log">
          <WireLog entries={entries} serverReachable={serverReachable} loaded={sessionLoaded} onClear={() => void clearWireLog()} />
        </section>
      </main>
    </div>
  );
}

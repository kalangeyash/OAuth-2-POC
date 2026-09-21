import { useEffect, useState } from "react";
import type { FlowModel } from "../model";
import { usePresenter } from "../presenter";
import type { DiscoveryInfo, SessionInfo, WireEntry } from "../types";
import { Chain, PanelHead, Term } from "./bits";

/*
 * TOKEN LIFECYCLE SIMULATOR. Token METADATA only (never a value), the three
 * tokens compared side by side, and the lifecycle chain lit by real events:
 * code → exchange → tokens → FHIR → expiry → 401 → refresh → new token → retry.
 */

interface Props {
  model: FlowModel;
  session: SessionInfo | null;
  discovery: DiscoveryInfo | null;
  running: boolean;
  onForceExpiry: () => void;
  onDisableRefresh: () => void;
  onRefreshFailure: () => void;
}

export function TokenLifecycle({ model, session, discovery, running, onForceExpiry, onDisableRefresh, onRefreshFailure }: Props) {
  const { toggleCompare, compare, setDockTab } = usePresenter();
  const authorized = session?.authorized ?? false;
  const remaining = useLocalCountdown(session?.secondsRemaining ?? null);
  const claims = session?.idTokenClaims ?? null;
  const issuer = typeof claims?.iss === "string" ? claims.iss : hostOf(discovery?.token_endpoint);
  const idExp = typeof claims?.exp === "number" ? new Date(claims.exp * 1000).toLocaleTimeString([], { hour12: false }) : null;

  const { original, retry } = refreshPair(model.real);

  return (
    <section className="tokens" aria-label="Token lifecycle simulator">
      <PanelHead title="Token lifecycle" note="Metadata only. Token values never leave the Node server, so this page could not show them if it tried." />

      <dl className="facts">
        <div>
          <dt>Access token</dt>
          <dd className={authorized ? "fact-ok" : undefined}>{authorized ? "Yes — held by the Node server" : "No"}</dd>
        </div>
        <div>
          <dt>Expires in</dt>
          <dd className={expiryClass(remaining)}>
            <span className="expiry-value">{formatSeconds(remaining)}</span>
            {session?.expiresIn != null && <span className="fact-note"> (expires_in {session.expiresIn} s)</span>}
          </dd>
        </div>
        <div>
          <dt>Refresh token</dt>
          <dd>{session?.hasRefreshToken ? "Yes — server only" : "No"}</dd>
        </div>
        <div>
          <dt>ID token</dt>
          <dd>{session?.hasIdToken ? "Yes — server only (claims decoded)" : "No"}</dd>
        </div>
        <div>
          <dt>Patient context</dt>
          <dd>
            <code>{session?.patientId ?? "none"}</code>
          </dd>
        </div>
        <div>
          <dt>Storage / browser exposure</dt>
          <dd>Server-side session · none</dd>
        </div>
      </dl>

      <div className="table-scroll">
        <table className="token-table">
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col">Purpose</th>
              <th scope="col">Issuer</th>
              <th scope="col">Intended recipient</th>
              <th scope="col">Lifetime</th>
              <th scope="col">Stored</th>
              <th scope="col">Browser sees it</th>
              <th scope="col">Sent to FHIR</th>
              <th scope="col">Calls APIs</th>
              <th scope="col">Proves identity</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">
                <Term name="access_token" />
              </th>
              <td>Access protected resources</td>
              <td>{issuer}</td>
              <td>FHIR server ({hostOf(session?.fhirBaseUrl)})</td>
              <td>{session?.expiresIn ? `${session.expiresIn} s` : "expires_in"}</td>
              <td>Server session</td>
              <td className="no">No</td>
              <td className="yes">Yes (Bearer)</td>
              <td className="yes">Yes</td>
              <td className="no">No</td>
            </tr>
            <tr>
              <th scope="row">
                <Term name="refresh_token" />
              </th>
              <td>Obtain a new access token</td>
              <td>{issuer}</td>
              <td>Token endpoint only</td>
              <td>Long, server-defined</td>
              <td>Server session</td>
              <td className="no">No</td>
              <td className="no">Never</td>
              <td className="no">No</td>
              <td className="no">No</td>
            </tr>
            <tr>
              <th scope="row">
                <Term name="id_token" />
              </th>
              <td>Convey authentication / identity claims</td>
              <td>{issuer}</td>
              <td>This client (aud = client_id)</td>
              <td>{idExp ? `until ${idExp}` : "its exp claim"}</td>
              <td>Server session</td>
              <td className="no">No (claims only)</td>
              <td className="no">Never</td>
              <td className="no">No</td>
              <td className="yes">Yes, once verified</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>Lifecycle, from this run's real events</h3>
      <Chain stages={model.tokens.stages} label="Token lifecycle" />

      <div className="experiment">
        <h3>Break the lifecycle</h3>
        <div className="builder-actions">
          <button type="button" className="button" disabled={!authorized || running} onClick={onForceExpiry}>
            Force token expiry
          </button>
          <button type="button" className="button" disabled={!authorized || running} onClick={onDisableRefresh}>
            Disable refresh
          </button>
          <button type="button" className="button" disabled={!authorized || running} onClick={onRefreshFailure}>
            Simulate refresh failure
          </button>
          <button
            type="button"
            className="button"
            disabled={!original || !retry}
            onClick={() => {
              for (const id of compare) toggleCompare(id);
              if (original) toggleCompare(original.id);
              if (retry) toggleCompare(retry.id);
              setDockTab("traffic");
            }}
          >
            Compare original and refreshed requests
          </button>
        </div>
        {!authorized && <p className="lede">Connect first: these experiments change the tokens stored on the server.</p>}
      </div>

      {claims && <IdTokenView claims={claims} />}
    </section>
  );
}

function IdTokenView({ claims }: { claims: Record<string, unknown> }) {
  const fhirUser = typeof claims.fhirUser === "string" ? claims.fhirUser : null;
  return (
    <div className="id-token">
      <h3>ID token (OpenID Connect)</h3>
      <div className="verdicts">
        <p className="verdict verdict-yes">
          <span className="verdict-icon" aria-hidden="true">
            ✓
          </span>
          Payload decoded
        </p>
        <p className="verdict verdict-no">
          <span className="verdict-icon" aria-hidden="true">
            ✕
          </span>
          Signature not verified
        </p>
      </div>
      <p className="id-token-warning">Teaching demo only: this payload is decoded but the ID token signature is NOT verified by this application.</p>
      <p className="fhir-user">
        <span className="fhir-user-label">
          <Term name="fhirUser" />
        </span>
        <span className="fhir-user-value">{fhirUser ?? "Not present in the ID token"}</span>
      </p>
      <details>
        <summary>Decoded payload</summary>
        <pre className="raw">{JSON.stringify(claims, null, 2)}</pre>
      </details>
    </div>
  );
}

/** The FHIR request that got 401, and its retry after the refresh. */
function refreshPair(entries: WireEntry[]): { original: WireEntry | undefined; retry: WireEntry | undefined } {
  const retry = [...entries].reverse().find((entry) => entry.direction === "client-fhir" && entry.step.endsWith("(retry)"));
  const original = retry
    ? [...entries].reverse().find((entry) => entry.id < retry.id && entry.direction === "client-fhir" && entry.status === 401)
    : undefined;
  return { original, retry };
}

function hostOf(url: string | null | undefined): string {
  if (!url) return "—";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/*
 * The session poll is every 2 s, so the countdown visibly stutters if it is driven
 * by the poll alone. Tick locally each second, re-seeded whenever the server
 * reports a fresh number.
 */
function useLocalCountdown(reported: number | null): number | null {
  const [seconds, setSeconds] = useState(reported);
  useEffect(() => {
    setSeconds(reported);
  }, [reported]);
  useEffect(() => {
    if (reported === null) return;
    const timer = window.setInterval(() => {
      setSeconds((current) => (current === null || current <= 0 ? current : current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [reported]);
  return seconds;
}

function expiryClass(seconds: number | null): string | undefined {
  if (seconds === null) return undefined;
  if (seconds <= 0) return "fact-expired";
  if (seconds < 300) return "fact-expiring";
  return undefined;
}

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds <= 0) return "expired";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

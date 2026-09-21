import { useEffect, useState } from "react";
import { ErrorNotice } from "./ErrorNotice";
import type { Load, PatientSummary, SessionInfo } from "../types";

interface Props {
  session: SessionInfo;
  patient: Load<PatientSummary>;
  onLoad: () => void;
}

export function PatientPanel({ session, patient, onLoad }: Props) {
  const loading = patient.state === "loading";
  const remaining = useLocalCountdown(session.secondsRemaining);

  return (
    <section className="section" aria-busy={loading || undefined}>
      <h2>Authorization</h2>
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd className="fact-ok">
            Authorized
            <span className="fact-note"> — tokens held by the Node server</span>
          </dd>
        </div>
        <div>
          <dt>Access token expires in</dt>
          <dd className={expiryClass(remaining)}>
            <span className="expiry-value">{formatSeconds(remaining)}</span>
            {expiryGlyph(remaining)}
            {session.expiresIn !== null && <span className="fact-note"> (expires_in: {session.expiresIn} s)</span>}
          </dd>
        </div>
        <div>
          <dt>Refresh token</dt>
          <dd>{session.hasRefreshToken ? "Available on the server" : "Not issued"}</dd>
        </div>
        <div>
          <dt>Patient context</dt>
          <dd>
            <code>{session.patientId ?? "None in the token response"}</code>
          </dd>
        </div>
      </dl>

      {patient.state === "loading" && (
        <div className="skeleton skeleton-banner" aria-hidden="true" />
      )}

      {patient.state === "error" && <ErrorNotice error={patient.error} onRetry={onLoad} />}

      {patient.state === "ready" ? (
        <div className="patient-banner">
          <div>
            <p className="patient-name">{patient.data.name ?? "Name missing"}</p>
            <dl className="patient-details">
              <div>
                <dt>Born</dt>
                <dd>{patient.data.birthDate ?? "Missing"}</dd>
              </div>
              <div>
                <dt>Sex</dt>
                <dd>{patient.data.gender ?? "Missing"}</dd>
              </div>
              <div>
                <dt>FHIR id</dt>
                <dd>
                  <code>{patient.data.id}</code>
                </dd>
              </div>
            </dl>
            <p className="synthetic-tag">Synthetic record</p>
          </div>
          <button type="button" className="button small" onClick={onLoad} disabled={loading}>
            {loading ? "Loading…" : "Load again"}
          </button>
        </div>
      ) : patient.state === "error" ? null : (
        <div className="load-data">
          <button type="button" className="button primary big" onClick={onLoad} disabled={loading}>
            {loading ? "Calling the FHIR API…" : "Load patient and labs"}
          </button>
          <p className="lede">
            The Node server calls the FHIR server with the access token. The browser sends only its session cookie.
          </p>
        </div>
      )}

      {session.idTokenClaims && <IdTokenView claims={session.idTokenClaims} />}
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
      <p className="id-token-warning">
        Teaching demo only: this payload is decoded but the ID token signature is NOT verified by this application.
      </p>
      <p className="fhir-user">
        <span className="fhir-user-label">fhirUser</span>
        <span className="fhir-user-value">{fhirUser ?? "Not present in the ID token"}</span>
      </p>
      <details open>
        <summary>Decoded payload</summary>
        <pre className="raw">{JSON.stringify(claims, null, 2)}</pre>
      </details>
    </div>
  );
}

/*
 * The session poll is every 2 s, so the countdown visibly stutters if it is driven
 * by the poll alone. Tick locally each second, re-seeded whenever the server
 * reports a fresh number — this is the clock "Force token expiry" asks the room
 * to watch.
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

/* Never colour alone: an expiring token says so in words too. */
function expiryGlyph(seconds: number | null) {
  if (seconds === null) return null;
  if (seconds <= 0) return <span className="fact-note"> — expired</span>;
  if (seconds < 300) return <span className="fact-note"> — expiring soon</span>;
  return null;
}

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return "Unknown (no expires_in)";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

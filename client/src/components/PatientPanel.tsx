import type { PatientSummary, SessionInfo } from "../types";

interface Props {
  session: SessionInfo;
  patient: PatientSummary | null;
  loading: boolean;
  onLoad: () => void;
}

export function PatientPanel({ session, patient, loading, onLoad }: Props) {
  return (
    <section className="section">
      <h2>Authorization</h2>
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd className="fact-ok">Authorized. Tokens are held by the Node server.</dd>
        </div>
        <div>
          <dt>Access token expires in</dt>
          <dd>
            {formatSeconds(session.secondsRemaining)}
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

      {patient ? (
        <div className="patient-banner">
          <div>
            <p className="patient-name">{patient.name ?? "Name missing"}</p>
            <dl className="patient-details">
              <div>
                <dt>Born</dt>
                <dd>{patient.birthDate ?? "Missing"}</dd>
              </div>
              <div>
                <dt>Sex</dt>
                <dd>{patient.gender ?? "Missing"}</dd>
              </div>
              <div>
                <dt>FHIR id</dt>
                <dd>
                  <code>{patient.id}</code>
                </dd>
              </div>
            </dl>
            <p className="synthetic-tag">Synthetic record</p>
          </div>
          <button type="button" className="button small" onClick={onLoad} disabled={loading}>
            {loading ? "Calling…" : "Call FHIR API again"}
          </button>
        </div>
      ) : (
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

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return "Unknown (no expires_in)";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

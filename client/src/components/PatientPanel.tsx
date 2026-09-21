import { ErrorNotice } from "./ErrorNotice";
import type { Load, PatientSummary, SessionInfo } from "../types";

interface Props {
  session: SessionInfo;
  patient: Load<PatientSummary>;
  onLoad: () => void;
}

/**
 * What the React application shows: the patient it received from our own server.
 * Token details live in the "Tokens" panel; this panel is the app's view.
 */
export function PatientPanel({ session, patient, onLoad }: Props) {
  const loading = patient.state === "loading";

  return (
    <section className="section" aria-busy={loading || undefined}>
      <h2>Patient</h2>
      <p className="lede">
        Authorized. The Node server holds the tokens; this page holds a session cookie. Patient context from the token response:{" "}
        <code>{session.patientId ?? "none"}</code>.
      </p>

      {patient.state === "loading" && <div className="skeleton skeleton-banner" aria-hidden="true" />}

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
    </section>
  );
}

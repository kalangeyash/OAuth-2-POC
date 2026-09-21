import type { FlowModel } from "../model";
import type { SessionInfo } from "../types";
import { Chain, PanelHead, Term } from "./bits";

/*
 * PATIENT CONTEXT: where the patient ID comes from (the token response, over the
 * back channel), and proof that the browser cannot choose another one.
 */

interface Props {
  model: FlowModel;
  session: SessionInfo | null;
  busy: boolean;
  onTryOtherPatient: () => void;
}

export function PatientContext({ model, session, busy, onTryOtherPatient }: Props) {
  const { patient } = model;
  const supplied = patient.request?.detail.browserSupplied ?? null;
  return (
    <section className="patient-context" aria-label="Patient context">
      <PanelHead
        title="Patient context"
        note="The authorization server decides which patient this session may read. The browser never does."
      />
      <dl className="facts-list compact">
        <div>
          <dt>Patient ID</dt>
          <dd>
            <code>{patient.context?.detail.patientId ?? session?.patientId ?? "none yet"}</code>
          </dd>
        </div>
        <div>
          <dt>Came from</dt>
          <dd>{patient.context?.detail.source ?? "the token response's \"patient\" parameter (after the token exchange)"}</dd>
        </div>
        <div>
          <dt>Used by</dt>
          <dd>The Node server, for every FHIR request, with the access token (Bearer, redacted)</dd>
        </div>
        <div>
          <dt>Why the browser cannot pick a patient</dt>
          <dd>
            The backend ignores any patient ID in the request. It reads the <Term name="patient" /> from the token context stored in the
            session, which only the authorization server could have written.
          </dd>
        </div>
      </dl>

      <h3>From consent to screen, from this run's real events</h3>
      <Chain stages={patient.stages} label="Patient context flow" />

      <div className="experiment">
        <h3>Try to read a different patient</h3>
        <p>
          This sends a real request: <code>GET /api/patient?patient=123</code>. Watch the traffic monitor: the FHIR request still
          goes to the authorized patient.
        </p>
        <button type="button" className="button" disabled={busy || !session?.authorized} onClick={onTryOtherPatient}>
          Send GET /api/patient?patient=123
        </button>
        {!session?.authorized && <p className="lede">Connect first.</p>}
        {supplied !== null && patient.request && (
          <p className="verdict-box is-defended" role="status">
            <strong>Ignored.</strong> The browser asked for patient “{supplied}”. The backend used{" "}
            <code>{patient.request.detail.used ?? "the token's patient"}</code> from the token context instead.
          </p>
        )}
      </div>
    </section>
  );
}

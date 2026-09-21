import { ErrorNotice } from "./ErrorNotice";
import type { LabResults, LabRow, Load } from "../types";

interface Props {
  labs: Load<LabResults>;
  onRetry: () => void;
}

/** Laboratory observations for the authorized patient. Never guesses a clinical value. */
export function LabTable({ labs, onRetry }: Props) {
  return (
    <section className="section" aria-label="Laboratory results" aria-busy={labs.state === "loading" || undefined}>
      <h2>Laboratory results</h2>
      <p className="lede">
        <code>Observation?patient=…&amp;category=laboratory</code>
        {labs.state === "ready" && ` · ${caption(labs.data)}`}
      </p>

      {labs.state === "idle" && (
        <p className="absent">
          No labs requested yet. Load the patient and this fills with the first page of Observations the FHIR server returns.
        </p>
      )}

      {labs.state === "loading" && (
        <div aria-hidden="true">
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="skeleton skeleton-row" />
          ))}
        </div>
      )}

      {labs.state === "error" && <ErrorNotice error={labs.error} onRetry={onRetry} />}

      {labs.state === "ready" &&
        (labs.data.rows.length === 0 ? (
          <p className="absent">
            This patient has no laboratory observations. Log in again and pick another patient to see a populated table.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="labs">
              <thead>
                <tr>
                  <th scope="col">Test</th>
                  <th scope="col" className="num">
                    Value
                  </th>
                  <th scope="col">Unit</th>
                  <th scope="col">Date</th>
                  <th scope="col">Interpretation</th>
                </tr>
              </thead>
              <tbody>
                {labs.data.rows.map((row, index) => (
                  <tr key={row.id ?? index}>
                    <td>{row.code ?? <Missing />}</td>
                    <td className="num">{row.value ?? <Missing />}</td>
                    <td>{row.unit ?? "—"}</td>
                    <td>{row.date ? row.date.slice(0, 10) : "—"}</td>
                    <td>{renderInterpretation(row.interpretation)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

function caption(labs: LabResults): string {
  const of = labs.total !== null ? ` of ${labs.total}` : "";
  const more = labs.hasMorePages ? ". More pages exist and are not loaded by this demo." : "";
  return `Showing ${labs.rows.length}${of}${more}`;
}

/* Abnormal results carry a glyph and the word, never colour alone. */
function renderInterpretation(value: LabRow["interpretation"]) {
  if (!value) return "—";
  const abnormal = /abnormal|high|low|critical|panic/i.test(value);
  if (!abnormal) return value;
  return (
    <span className="lab-flag is-abnormal">
      <span aria-hidden="true">▲</span>
      {value}
    </span>
  );
}

function Missing() {
  return <span className="missing">Missing</span>;
}

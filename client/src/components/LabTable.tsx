import type { LabResults } from "../types";

export function LabTable({ labs }: { labs: LabResults }) {
  const count =
    `Showing ${labs.rows.length}` +
    (labs.total !== null ? ` of ${labs.total}` : "") +
    (labs.hasMorePages ? ". More pages exist and are not loaded by this demo." : ".");

  return (
    <section className="section">
      <h2>Laboratory results</h2>
      <p className="lede">
        <code>Observation?patient=…&amp;category=laboratory</code> (first page). {count}
      </p>
      {labs.rows.length === 0 ? (
        <p className="absent">The FHIR server returned no laboratory Observations for this patient.</p>
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
              {labs.rows.map((row, index) => (
                <tr key={row.id ?? index}>
                  <td>{row.code ?? <Missing />}</td>
                  <td className="num">{row.value ?? <Missing />}</td>
                  <td>{row.unit ?? "—"}</td>
                  <td>{row.date ? row.date.slice(0, 10) : "—"}</td>
                  <td>{row.interpretation ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The Observation had no usable value. We say so instead of guessing. */
function Missing() {
  return <span className="missing">Missing</span>;
}

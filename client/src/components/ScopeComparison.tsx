import type { ScopeDiff } from "../types";

interface Props {
  current: ScopeDiff | null;
  narrow?: ScopeDiff | null;
  broad?: ScopeDiff | null;
}

export function ScopeComparison({ current, narrow, broad }: Props) {
  if (!current && !broad) return null;
  return (
    <section className="section">
      <h2>Requested vs granted scope</h2>
      <p className="lede">Requested permissions are not necessarily the permissions that are granted.</p>
      {current && <ScopeTable diff={current} />}
      {broad && (
        <>
          <h3 className="versus-title">Narrow request vs broad request</h3>
          <div className="versus">
            <div>
              <h4>NARROW REQUEST</h4>
              {narrow ? (
                <ScopeTable diff={narrow} compact />
              ) : (
                <p className="absent">No narrow grant recorded yet. Connect normally to record one.</p>
              )}
            </div>
            <div>
              <h4>BROAD REQUEST</h4>
              <ScopeTable diff={broad} compact />
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function ScopeTable({ diff, compact = false }: { diff: ScopeDiff; compact?: boolean }) {
  let summary = "Every requested scope was granted.";
  if (!diff.grantedReported) {
    summary = "The token response had no scope parameter, so the granted scope is unknown.";
  } else if (diff.dropped.length > 0) {
    summary = `${diff.dropped.length} requested ${diff.dropped.length === 1 ? "scope was" : "scopes were"} NOT GRANTED.`;
  } else if (diff.added.length > 0) {
    summary = `Granted ${diff.added.length} ${diff.added.length === 1 ? "scope" : "scopes"} that were not requested.`;
  }

  return (
    <>
      <p className={diff.dropped.length > 0 ? "scope-summary is-dropped" : "scope-summary"}>{summary}</p>
      <div className="table-scroll">
        <table className="scopes">
          <thead>
            <tr>
              <th scope="col">{compact ? "Scope" : "Requested scope"}</th>
              <th scope="col">{compact ? "Result" : "Granted scope"}</th>
            </tr>
          </thead>
          <tbody>
            {diff.rows.map((row) => {
              const dropped = diff.grantedReported && row.requested && !row.granted;
              const scope = <code>{row.scope}</code>;
              return (
                <tr key={row.scope} className={dropped ? "is-dropped" : undefined}>
                  <td>
                    {compact || row.requested ? (
                      dropped ? <del>{scope}</del> : scope
                    ) : (
                      <span className="absent">not requested</span>
                    )}
                  </td>
                  <td>
                    {!diff.grantedReported ? (
                      <span className="absent">not reported</span>
                    ) : dropped ? (
                      <span className="tag tag-not-granted">NOT GRANTED</span>
                    ) : !row.requested ? (
                      <>
                        {!compact && scope}
                        <span className="tag tag-added">added by server</span>
                      </>
                    ) : compact ? (
                      "Granted"
                    ) : (
                      scope
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

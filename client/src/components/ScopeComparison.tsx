import type { ScopeDiff, TeachingError } from "../types";

interface Props {
  current: ScopeDiff | null;
  /** The scope string this client asks for, known before any token response. */
  requestedScope: string | null;
  authorized: boolean;
  lastError: TeachingError | null;
  narrow?: ScopeDiff | null;
  broad?: ScopeDiff | null;
}

/**
 * Requested versus granted.
 *
 * This panel never returns null. It used to disappear entirely before connecting,
 * taking one of the two most teachable ideas off the screen; now it shows what is
 * about to be asked for, so the audience can read the request before the answer.
 */
export function ScopeComparison({ current, requestedScope, authorized, lastError, narrow, broad }: Props) {
  const requested = (requestedScope ?? "").split(" ").filter(Boolean);

  return (
    <section className="section" aria-label="Requested versus granted scope">
      <h2>Requested vs granted scope</h2>
      <p className="lede">Requested permissions are not necessarily the permissions that are granted.</p>

      {current ? (
        <ScopeTable diff={current} />
      ) : lastError && !authorized ? (
        <p className="absent">
          No scope was granted: the flow stopped at {lastError.step.toLowerCase()}. Connect again to see a grant.
        </p>
      ) : requested.length > 0 ? (
        <>
          <p className="scope-summary">This client will ask for {requested.length} scopes.</p>
          <ul className="chips">
            {requested.map((scope) => (
              <li key={scope} className="chip chip-strong">
                {scope}
              </li>
            ))}
          </ul>
          <p className="lede">
            The granted scope appears here after the token response, next to what was asked for. Anything the server
            refuses is struck through.
          </p>
        </>
      ) : (
        <p className="absent">Waiting for the Node server to report the scope it will request.</p>
      )}

      {broad && (
        <>
          <h3 className="versus-title">Narrow request vs broad request</h3>
          <div className="versus">
            <div>
              <h4>Narrow request</h4>
              {narrow ? (
                <ScopeTable diff={narrow} compact />
              ) : (
                <p className="absent">No narrow grant recorded yet. Connect normally to record one to compare against.</p>
              )}
            </div>
            <div>
              <h4>Broad request</h4>
              <ScopeTable diff={broad} compact />
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/* Three visually distinct verdicts: dropped (danger), grant unknown (warning),
   everything granted (plain). "Unknown" is not the same as "nothing was dropped". */
function summaryClass(diff: ScopeDiff): string {
  if (!diff.grantedReported) return "scope-summary is-unknown";
  if (diff.dropped.length > 0) return "scope-summary is-dropped";
  return "scope-summary";
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
      <p className={summaryClass(diff)}>{summary}</p>
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

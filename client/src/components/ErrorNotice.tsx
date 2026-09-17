import type { TeachingError } from "../types";

/** A real OAuth/FHIR error from the server, shown with the concept it illustrates. */
export function ErrorNotice({ error }: { error: TeachingError }) {
  const details = (
    [
      ["HTTP", error.status],
      ["error", error.error],
      ["error_description", error.error_description],
      ["endpoint", error.endpoint],
    ] as const
  ).filter(([, value]) => value !== undefined && value !== "");

  return (
    <div className="notice-error" role="alert">
      <p className="notice-title">
        {error.step}: {error.message}
      </p>
      {details.length > 0 && (
        <dl className="kv">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {error.concept && <p className="notice-concept">Concept: {error.concept}</p>}
    </div>
  );
}

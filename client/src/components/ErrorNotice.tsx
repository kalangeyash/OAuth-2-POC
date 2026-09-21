import type { TeachingError } from "../types";

interface Props {
  error: TeachingError;
  /** Offered only when the server said re-authentication is required. */
  onReconnect?: () => void;
  onRetry?: () => void;
}

/** A failure, stated plainly, next to the provider's own words. */
export function ErrorNotice({ error, onReconnect, onRetry }: Props) {
  const details = (
    [
      ["HTTP", error.status],
      ["error", error.error],
      ["error_description", error.error_description],
      ["endpoint", error.endpoint],
    ] as const
  ).filter(([, value]) => value !== undefined && value !== "");

  return (
    <div className="notice-error">
      <p className="notice-title">
        {error.step}: {error.message}
      </p>
      {details.length > 0 && (
        <dl className="kv">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {error.concept && <p className="notice-concept">Concept: {error.concept}</p>}
      {(onReconnect || onRetry) && (
        <div className="notice-actions">
          {onReconnect && (
            <button type="button" className="button small" onClick={onReconnect}>
              Reconnect
            </button>
          )}
          {onRetry && (
            <button type="button" className="button small" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

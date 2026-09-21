/*
 * Small shared pieces. Every panel speaks the same visual language: an actor is
 * always the same chip, a channel always the same badge, a secret always the same
 * hatched "redacted" mark, and any OAuth value can be clicked to explain it.
 */
import type { ReactNode } from "react";
import { ACTORS, CHANNELS } from "../../../server/src/timeline";
import { redact } from "../../../server/src/redaction";
import { glossaryFor } from "../glossary";
import type { Stage, StageStatus } from "../model";
import { usePresenter } from "../presenter";
import type { ActorId, Channel, SourceRef } from "../types";

export function ActorChip({ actor, short = false }: { actor: ActorId; short?: boolean }) {
  return <span className={`actor-chip actor-${actor}`}>{short ? ACTORS[actor].short : ACTORS[actor].name}</span>;
}

export function ChannelBadge({ channel }: { channel: Channel }) {
  return (
    <span className={`channel-badge channel-${channel}`} title={CHANNELS[channel].description}>
      {CHANNELS[channel].label}
    </span>
  );
}

/** A value name that opens its "Explain this value" card, if the glossary knows it. */
export function Term({ name, children }: { name: string; children?: ReactNode }) {
  const { explain } = usePresenter();
  if (!glossaryFor(name)) return <>{children ?? name}</>;
  return (
    <button type="button" className="term" onClick={() => explain(name)} title={`Explain ${name}`}>
      {children ?? name}
    </button>
  );
}

const STAGE_GLYPH: Record<StageStatus, string> = { done: "✓", failed: "✕", pending: "·", "not-needed": "–" };

/** A vertical chain of stages (A ↓ B ↓ C), each tied to the event that proved it. */
export function Chain({ stages, label }: { stages: Stage[]; label: string }) {
  const { select } = usePresenter();
  return (
    <ol className="chain" aria-label={label}>
      {stages.map((stage) => (
        <li key={stage.id} className={`chain-stage is-${stage.status}`}>
          <span className="chain-glyph" aria-hidden="true">
            {STAGE_GLYPH[stage.status]}
          </span>
          <span className="chain-body">
            <span className="chain-label">
              {stage.label}
              <span className="visually-hidden"> ({stage.status})</span>
            </span>
            <span className="chain-meta">
              <ActorChip actor={stage.actor} short />
              {stage.note && <span className="chain-note">{stage.note}</span>}
              {stage.status === "not-needed" && <span className="chain-note">has not happened in this run</span>}
            </span>
          </span>
          {stage.entryId !== null && (
            <button type="button" className="link-button" onClick={() => select(stage.entryId)}>
              #{stage.entryId}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The real files behind a step. Shown only when the presenter has source references on. */
export function SourceList({ refs, env = [] }: { refs: SourceRef[]; env?: string[] }) {
  if (refs.length === 0 && env.length === 0) return <p className="absent">Happens at the authorization server: no code in this repository.</p>;
  return (
    <div className="source-list">
      {refs.length > 0 && (
        <ul>
          {refs.map((ref) => (
            <li key={`${ref.file}#${ref.symbol}`}>
              <code className="source-file">{ref.file}</code>
              <code className="source-symbol">{ref.symbol}</code>
            </li>
          ))}
        </ul>
      )}
      {env.length > 0 && (
        <p className="source-env">
          Configuration:{" "}
          {env.map((name) => (
            <code key={name}>{name}</code>
          ))}
        </p>
      )}
    </div>
  );
}

/** A key/value table. Keys that are OAuth values open their explanation. Secrets render as hatched marks. */
export function KeyValues({ values, explainKeys = true }: { values: Record<string, unknown>; explainKeys?: boolean }) {
  const entries = Object.entries(values);
  if (entries.length === 0) return <p className="absent">(empty)</p>;
  return (
    <dl className="kv">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{explainKeys ? <Term name={key} /> : key}</dt>
          <dd>
            <Value value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Value({ value }: { value: unknown }) {
  const safe = redact(value);
  if (typeof safe === "string") {
    const hidden = safe.startsWith("[REDACTED") || safe.endsWith("(truncated)");
    return hidden ? <span className="redacted">{safe}</span> : <>{safe}</>;
  }
  if (Array.isArray(safe) && safe.every((item) => typeof item !== "object" || item === null)) {
    return <>{safe.join(" ")}</>;
  }
  if (typeof safe === "object" && safe !== null) {
    return <pre>{JSON.stringify(safe, null, 2)}</pre>;
  }
  return <>{String(safe)}</>;
}

/** A section heading with an optional note, used by every dock panel. */
export function PanelHead({ title, note, children }: { title: string; note?: string; children?: ReactNode }) {
  return (
    <header className="panel-head">
      <div>
        <h2>{title}</h2>
        {note && <p className="lede">{note}</p>}
      </div>
      {children && <div className="panel-actions">{children}</div>}
    </header>
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

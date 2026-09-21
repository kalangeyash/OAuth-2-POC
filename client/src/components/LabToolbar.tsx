import { CHANNELS, LAB_MODES, type Channel, type LabMode } from "../../../server/src/timeline";
import { usePresenter } from "../presenter";
import { SCENARIOS, type Scenario } from "../scenarios";
import type { LabState } from "../types";

/*
 * The debugger's controls. Execution (Pause / Resume / Next step / Stop) acts on
 * the real Node server: Pause makes the backend stop before its next stage, Next
 * step releases exactly one stage. "Freeze display" only freezes this screen.
 */

interface Props {
  lab: LabState;
  scenario: Scenario;
  onScenario: (scenario: Scenario) => void;
  onRun: () => void;
  runDisabledReason: string | null;
  onMode: (mode: LabMode) => void;
  onDecide: (action: "send" | "run" | "abort") => void;
  onReset: (all: boolean) => void;
  bufferedCount: number;
  streamStatus: string;
}

export function LabToolbar({ lab, scenario, onScenario, onRun, runDisabledReason, onMode, onDecide, onReset, bufferedCount, streamStatus }: Props) {
  const presenter = usePresenter();
  const paused = lab.breakpoint !== null;

  return (
    <div className="labbar" role="toolbar" aria-label="Protocol lab controls">
      <div className="labbar-row">
        <label className="scenario-select">
          <span className="visually-hidden">Scenario</span>
          <select
            value={scenario.id}
            onChange={(event) => onScenario(SCENARIOS.find((item) => item.id === event.target.value) ?? SCENARIOS[0])}
          >
            {SCENARIOS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.n}. {item.title}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button primary"
          onClick={onRun}
          disabled={runDisabledReason !== null}
          title={runDisabledReason ?? "Run this scenario (R)"}
        >
          ▶ Run scenario
        </button>

        <div className="segmented" role="group" aria-label="Execution mode">
          {(Object.keys(LAB_MODES) as LabMode[]).map((mode) => (
            <button key={mode} type="button" aria-pressed={lab.mode === mode} title={LAB_MODES[mode].description} onClick={() => onMode(mode)}>
              {LAB_MODES[mode].label}
            </button>
          ))}
        </div>

        <div className="debug-buttons" role="group" aria-label="Debugger">
          {lab.mode === "run" ? (
            <button type="button" className="button" onClick={() => onMode("step")} title="Pause: the backend stops before its next stage (Space)">
              ⏸ Pause
            </button>
          ) : (
            <button type="button" className="button" onClick={() => onMode("run")} title="Resume: stop pausing and finish the flow (Space)">
              ▶ Resume
            </button>
          )}
          <button
            type="button"
            className="button primary"
            disabled={!paused}
            onClick={() => onDecide("send")}
            title={paused ? "Run exactly one stage (→)" : "Nothing is paused"}
          >
            ⏭ Next step
          </button>
          <button type="button" className="button danger" disabled={!paused} onClick={() => onDecide("abort")} title="Stop the flow at this breakpoint">
            ■ Stop
          </button>
        </div>

        <div className="debug-buttons" role="group" aria-label="Reset">
          <button type="button" className="button" onClick={() => onReset(false)} title="Release any pause, forget the last scenario result, clear the log">
            ⟲ Reset
          </button>
          <button type="button" className="button" onClick={() => onReset(true)} title="Reset, and also log out (discard the stored tokens)">
            Reset all
          </button>
        </div>

        <span className={`stream-status is-${streamStatus}`}>
          <span className="stream-dot" aria-hidden="true" />
          {streamStatus === "live" ? "Live" : streamStatus === "reconnecting" ? "Reconnecting…" : "Connecting…"}
        </span>
        <button type="button" className="button small" onClick={() => presenter.setShortcutsOpen(true)} title="Keyboard shortcuts (?)">
          ?
        </button>
      </div>

      <div className="labbar-row labbar-secondary">
        <div className="legend" aria-label="Legend">
          {(Object.keys(CHANNELS) as Channel[]).map((channel) => (
            <span key={channel} className={`legend-item legend-${channel}`} title={CHANNELS[channel].description}>
              <span className="legend-swatch" aria-hidden="true" />
              {CHANNELS[channel].label}
            </span>
          ))}
          <span className="legend-item legend-held">
            <span className="legend-swatch" aria-hidden="true" />
            HELD BY DEBUGGER (NOT SENT)
          </span>
        </div>
        <div className="toggles">
          <div className="segmented" role="group" aria-label="How much to show (E)">
            <button
              type="button"
              aria-pressed={presenter.detailLevel === "essentials"}
              title="Real messages, security checks, failures and deliberate changes (E)"
              onClick={() => presenter.setDetailLevel("essentials")}
            >
              Essentials
            </button>
            <button
              type="button"
              aria-pressed={presenter.detailLevel === "everything"}
              title="Every recorded step, including routine steps inside Node (E)"
              onClick={() => presenter.setDetailLevel("everything")}
            >
              Everything
            </button>
          </div>
          {presenter.frozen && (
            <Toggle label={`Frozen${bufferedCount ? ` (+${bufferedCount})` : ""}`} on onClick={() => presenter.setFrozen(false)} />
          )}
          {/* Everything else is one click away, not on screen all the time. */}
          <details className="view-menu">
            <summary className="button small">View options</summary>
            <div className="view-menu-body" role="group" aria-label="View options">
              <Toggle label="Inspector (I)" on={presenter.inspectorOpen} onClick={() => presenter.toggle("inspectorOpen")} />
              <Toggle label="Technical details: headers, bodies (D)" on={presenter.showDetails} onClick={() => presenter.toggle("showDetails")} />
              <Toggle label="Security explanations (S)" on={presenter.showSecurity} onClick={() => presenter.toggle("showSecurity")} />
              <Toggle label="Source code references" on={presenter.showSource} onClick={() => presenter.toggle("showSource")} />
              <Toggle label="Inspector follows new messages" on={presenter.followLive} onClick={() => presenter.toggle("followLive")} />
              <Toggle label="Failure injection at breakpoints" on={presenter.failureInjection} onClick={() => presenter.toggle("failureInjection")} />
              <Toggle label="Login in a popup window" on={presenter.popupMode} onClick={() => presenter.toggle("popupMode")} />
              <Toggle label="Freeze the display" on={presenter.frozen} onClick={() => presenter.setFrozen(!presenter.frozen)} />
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className="toggle" aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}

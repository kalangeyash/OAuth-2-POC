import { useEffect, useRef, type ReactNode } from "react";
import { glossaryFor } from "../glossary";
import { usePresenter } from "../presenter";
import { SourceList } from "./bits";

/** A modal dialog on the native <dialog> element: focus trapping and Escape come for free. */
function Dialog({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={label}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      {open && children}
    </dialog>
  );
}

/** "Explain this value": what it is, who makes and uses it, whether it is secret, what it protects, and the real code. */
export function GlossaryDialog() {
  const { glossaryTerm, explain, showSource } = usePresenter();
  const entry = glossaryTerm ? glossaryFor(glossaryTerm) : null;
  return (
    <Dialog open={entry !== null} onClose={() => explain(null)} label={entry ? `Explain ${entry.term}` : "Explain value"}>
      {entry && (
        <>
          <header className="dialog-head">
            <h2>
              <code>{entry.term}</code>
            </h2>
            <span className={`secret-tag secret-${entry.secret.split(" ")[0].toLowerCase()}`}>{entry.secret}</span>
            <button type="button" className="button small" onClick={() => explain(null)} autoFocus>
              Close
            </button>
          </header>
          <p className="dialog-lede">{entry.what}</p>
          <dl className="facts-list">
            {entry.required && (
              <div>
                <dt>Required?</dt>
                <dd>{entry.required}</dd>
              </div>
            )}
            <div>
              <dt>Who creates it</dt>
              <dd>{entry.createdBy}</dd>
            </div>
            <div>
              <dt>Who consumes it</dt>
              <dd>{entry.consumedBy}</dd>
            </div>
            <div>
              <dt>Where it travels</dt>
              <dd>{entry.travels}</dd>
            </div>
            <div>
              <dt>How long it is valid</dt>
              <dd>{entry.lifetime}</dd>
            </div>
            <div>
              <dt>What attack it helps prevent</dt>
              <dd>{entry.protects}</dd>
            </div>
            <div>
              <dt>If it is modified</dt>
              <dd>{entry.ifModified}</dd>
            </div>
          </dl>
          {showSource && (
            <>
              <h3>Handled by</h3>
              <SourceList refs={entry.source} />
            </>
          )}
        </>
      )}
    </Dialog>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Space", "Pause / resume the backend (debugger)"],
  ["→", "Next step at a breakpoint; otherwise the next message"],
  ["←", "Previous message"],
  ["R", "Restart (run) the selected scenario"],
  ["F", "Open the failure lab"],
  ["I", "Show / hide the message inspector"],
  ["S", "Show / hide security explanations"],
  ["D", "Show / hide technical details"],
  ["E", "Essentials / Everything (hide or show routine steps inside Node)"],
  ["T", "Open the timeline"],
  ["Esc", "Close a dialog, leave a replay"],
  ["?", "This list"],
];

export function ShortcutsDialog() {
  const { shortcutsOpen, setShortcutsOpen } = usePresenter();
  return (
    <Dialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} label="Keyboard shortcuts">
      <header className="dialog-head">
        <h2>Presenter shortcuts</h2>
        <button type="button" className="button small" onClick={() => setShortcutsOpen(false)} autoFocus>
          Close
        </button>
      </header>
      <dl className="shortcuts">
        {SHORTCUTS.map(([key, action]) => (
          <div key={key}>
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
      <p className="lede">Shortcuts never touch token security: they drive the same buttons you can click.</p>
    </Dialog>
  );
}

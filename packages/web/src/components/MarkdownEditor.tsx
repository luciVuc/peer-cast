import { useId, useState } from "react";
import { ABOUT_MAX } from "@peer-cast/shared";
import { Markdown } from "./Markdown";

const TABS = [
  { id: "write", label: "Write" },
  { id: "preview", label: "Preview" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export interface MarkdownEditorProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** Called on every keystroke so the page can track unsaved changes. */
  onDirty?: () => void;
  /** Server-side limit. Mirrors the same field on the API so the user sees
   *  the cap before saving, not as a 400 afterwards. Input is deliberately not
   *  hard-capped — silently dropping keystrokes loses text, so the counter
   *  turns red instead and the server has the final say. */
  maxLength?: number;
  rows?: number;
  placeholder?: string;
  /** Shown under the label — keep it to the syntax actually supported. */
  hint?: string;
}

/**
 * Markdown editor with Write / Preview tabs and a live character counter.
 * Used for the profile "about" field on the settings page.
 */
export function MarkdownEditor({
  label,
  value,
  onChange,
  onDirty,
  maxLength = ABOUT_MAX,
  rows = 5,
  placeholder = "Tell people about yourself…",
  hint,
}: MarkdownEditorProps) {
  const [tab, setTab] = useState<TabId>("write");
  const panelId = useId();

  const overBy = value.length - maxLength;
  const over = overBy > 0;

  return (
    <div>
      <label className="label" htmlFor={`${panelId}-input`}>
        {label}
      </label>

      <div className="mb-1 flex items-center gap-1 border-b border-white/10">
        {TABS.map(({ id, label: tabLabel }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${panelId}-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={panelId}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-2.5 py-1.5 text-xs font-semibold transition ${
              tab === id
                ? "border-brand-500 text-slate-100"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {tabLabel}
          </button>
        ))}
        <span
          className={`ml-auto pb-1.5 pl-2 text-xs tabular-nums ${
            over ? "font-semibold text-red-400" : "text-slate-500"
          }`}
        >
          {value.length} / {maxLength}
        </span>
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${panelId}-tab-${tab}`}
      >
        {tab === "write" ? (
          <textarea
            id={`${panelId}-input`}
            className="input font-mono"
            rows={rows}
            value={value}
            placeholder={placeholder}
            onChange={(e) => {
              onChange(e.target.value);
              onDirty?.();
            }}
          />
        ) : (
          <div className="input block min-h-11 bg-ink-900/40">
            {value.trim() ? (
              <Markdown>{value}</Markdown>
            ) : (
              <p className="text-sm text-slate-500">Nothing to preview yet.</p>
            )}
          </div>
        )}
      </div>

      {over && (
        <p className="mt-1 text-xs text-red-400">
          {overBy} character{overBy === 1 ? "" : "s"} over the limit — trim it
          before saving.
        </p>
      )}
      {hint && !over && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

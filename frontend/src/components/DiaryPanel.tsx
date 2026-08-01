import { useEffect, useRef, useState } from "react";
import { api } from "../api";

/* Minimal diary editor: one markdown file per day ("<date> diary.md") in the
   folder configured in Settings. Loaded only when opened — browsing history
   happens in Obsidian. Saves are debounced, flushed on blur and unmount;
   nothing else ever writes into the textarea while you type. */
export default function DiaryPanel({ date, folder }: { date: string; folder: string }) {
  const path = `${folder.replace(/\/+$/, "")}/${date} diary.md`;
  const [content, setContent] = useState<string | null>(null); // null = loading
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const lastSaved = useRef("");
  const contentRef = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api.readNote(path)
      .then((r) => {
        if (cancelled) return;
        setContent(r.content);
        lastSaved.current = r.content;
        contentRef.current = r.content;
      })
      .catch(() => {
        // No entry for this day yet
        if (cancelled) return;
        setContent("");
        lastSaved.current = "";
        contentRef.current = "";
      });
    return () => { cancelled = true; };
  }, [path]);

  const save = async () => {
    const v = contentRef.current;
    if (v === lastSaved.current) return;
    if (!v.trim() && !lastSaved.current.trim()) return; // never create empty files
    setStatus("saving");
    try {
      await api.writeNote(path, v);
      lastSaved.current = v;
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 1200);
    } catch {
      setStatus("idle");
    }
  };

  const onChange = (v: string) => {
    setContent(v);
    contentRef.current = v;
    clearTimeout(timer.current);
    timer.current = setTimeout(save, 1500);
  };

  // Flush pending edits when the diary closes or the day changes
  useEffect(() => () => { clearTimeout(timer.current); void save(); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  /* No viewport maths here: WeekPlan sizes the panel to what the keyboard
     leaves visible, and the box below fills it. One owner for the geometry
     — measuring it from two places is what put this window mid-screen on
     Android with the keyboard over its bottom half. */
  const taRef = useRef<HTMLTextAreaElement>(null);

  /* Open at the END of the day's entry. autoFocus puts the caret at the
     start, which is the wrong end of a diary: you come back to it to add to
     what's there, not to write above it. Once per date — after that the
     caret is yours. */
  const landedOn = useRef<string>("");
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || content === null || landedOn.current === date) return;
    landedOn.current = date;
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
    ta.scrollTop = ta.scrollHeight;
  }, [content, date]);

  return (
    <div className="rounded-lg p-3 space-y-2 max-md:h-full max-md:flex max-md:flex-col max-md:min-h-0" style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: "var(--text)" }}>📔 Diary — {date}</h3>
        <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : ""}
        </span>
      </div>
      {content === null ? (
        <p className="text-xs py-4 text-center" style={{ color: "var(--text-tertiary)" }}>Loading…</p>
      ) : (
        /* Uncontrolled — see AutoFocusInput for the Samsung IME rationale;
           the key remounts with fresh content when the date changes */
        <textarea
          ref={taRef}
          key={`diary-${date}`}
          defaultValue={content}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onBlur={save}
          placeholder="Write today's diary…"
          autoFocus
          className="w-full md:min-h-[50vh] max-md:flex-1 max-md:min-h-0 text-sm p-2.5 rounded resize-y outline-none focus:ring-1 focus:ring-purple-400 leading-relaxed"
          style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}
        />
      )}
      <p className="text-[10px] font-mono truncate" style={{ color: "var(--text-tertiary)" }} title={path}>{path}</p>
    </div>
  );
}

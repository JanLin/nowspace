/* ── The ambient slate (funnel stage 5) ─────────────────────────
   A read-only surface showing the questions being carried, filtered
   by time of day server-side: solve questions before the evening
   cutoff, rehearse questions after. One capture box is permitted;
   no editing, no completion, no judgment — by design (see the
   funnel brief's non-goals). */

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { renderWikiText } from "./Bucket";

type SlateData = { evening: boolean; cutoff: string; items: { question: string; label: string; mode: string }[] };

/** [[Note|Display]] → Display, plain text — rehearse questions must not
    offer a one-tap path to the answer; the effort of recall is the value. */
function flattenWikiLinks(text: string): string {
  return text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, name, display) => display || name);
}

export default function Slate({ active, onOpenNote }: {
  active: boolean; onOpenNote: (path: string, name: string) => void;
}) {
  const [data, setData] = useState<SlateData | null>(null);
  const [captured, setCaptured] = useState<string[]>([]); // this session, for quiet confirmation
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => api.getSlate().then(setData).catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));

  useEffect(() => { if (active) { load(); setError(""); } }, [active]);
  // The tab can sit open across the cutoff — refresh every few minutes
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [active]);

  const capture = async () => {
    const v = (inputRef.current?.value || "").trim();
    if (!v) return;
    try {
      await api.slateCapture(v);
      setCaptured((p) => [...p, v]);
      if (inputRef.current) inputRef.current.value = "";
      window.dispatchEvent(new CustomEvent("bucket-changed"));
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't capture"); }
  };

  if (!data) {
    return <p className="text-center py-12 text-sm" style={{ color: "var(--text-tertiary)" }}>{error || "…"}</p>;
  }

  return (
    <div className="max-w-md mx-auto pt-8 pb-16 px-3 space-y-6">
      <div className="text-center space-y-1">
        <p className="text-2xl">{data.evening ? "🌒" : "🌅"}</p>
        <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
          {data.evening
            ? `After ${data.cutoff} — rehearsal only. Open problems are asleep until morning.`
            : "The questions you're carrying. Nothing to do here — just hold them."}
        </p>
      </div>

      <div className="space-y-4">
        {data.items.length === 0 && (
          <p className="text-center text-sm py-8" style={{ color: "var(--text-tertiary)" }}>
            {data.evening ? "Nothing to rehearse. Good night." : "Nothing carried right now. The bucket can wait."}
          </p>
        )}
        {data.items.map((it, i) => (
          <div key={i} className="text-center space-y-0.5">
            <p className="text-base leading-snug" style={{ color: "var(--text)" }}>
              {flattenWikiLinks(it.question || it.label)}
            </p>
            {/* Solve questions link to their notes (clarifying is daywork);
                rehearse shows names only — recall first, look up never */}
            <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
              {it.mode === "solve" ? renderWikiText(it.label, onOpenNote) : flattenWikiLinks(it.label)}
            </p>
          </div>
        ))}
      </div>

      {data.evening && data.items.length > 0 && (
        <p className="text-center text-[10px]" style={{ color: "var(--text-tertiary)" }}>
          Recall before you look anything up — the effort is the value. Don't take these to an AI chat.
        </p>
      )}

      {/* The one write this surface allows */}
      <div className="pt-4 space-y-1.5" style={{ borderTop: "1px solid var(--border)" }}>
        <input ref={inputRef} type="text" autoComplete="off" autoCorrect="off" spellCheck={false}
          placeholder={data.evening ? "Anything on your mind? Put it down here and let it go." : "Capture a thought…"}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) capture(); }}
          className="w-full text-sm px-3 py-2 rounded-lg outline-none focus:ring-1 focus:ring-blue-400"
          style={{ background: "var(--bg-secondary)", color: "var(--text)", border: "1px solid var(--border)" }} />
        {captured.length > 0 && (
          <p className="text-[10px] text-center" style={{ color: "var(--text-tertiary)" }}>
            ✓ {captured.length} captured — it's in the inbox now, not in your head
          </p>
        )}
      </div>
    </div>
  );
}

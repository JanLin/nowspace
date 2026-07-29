import { useEffect, useState } from "react";

// First-run guided tour: steps through the tabs with an arrow pointing at
// each one. Replayable from the ? help button. Marking as seen lives with
// the caller (App) so skip and finish behave the same.

type Step = {
  target: string | null; // data-tour id to point at; null = centered card
  title: string;
  body: string;
};

const STEPS: Step[] = [
  {
    target: null,
    title: "Welcome to Nowspace",
    body: "Calm daily planning on top of plain markdown files. Everything you see here lives in your vault as readable notes that stay yours — Nowspace is just a friendly window onto them.",
  },
  {
    target: "week",
    title: "Plan — your week, one day at a time",
    body: "Tick tasks done, drag them around, and click a task's priority badge (A–D) for the quick menu: change priority, move it to another weekday, or park it back in the bucket. Each day also has notes and a diary.",
  },
  {
    target: "bucket",
    title: "Bucket — everything for later",
    body: "Capture anything you might do someday, grouped so it stays tidy. Give tasks a horizon — n (this week), nw (next week), m (next month) — and pull them into your plan when their time comes.",
  },
  {
    target: "habits",
    title: "Habits — gentle rhythms",
    body: "Recurring habits for body, mind and soul. Tick them through the week; a small strip on the Plan tab keeps them in view without nagging.",
  },
  {
    target: "time",
    title: "Time — one timer, honest logs",
    body: "Start a timer on what you're doing, edit entries by clicking them, and see where the week went in the distribution chart — by company or life area.",
  },
  {
    target: "settings",
    title: "Settings — your setup",
    body: "Vault location, contexts, reference folders and the diary folder. Settings live in the vault itself, so every device sees the same configuration.",
  },
  {
    target: "settings",
    title: "That's the tour!",
    body: "Take it again anytime from Settings, under Appearance & help — that's also where the full guide lives, for a longer read on priorities, horizons, epics and more.",
  },
];

export default function Tour({ onClose, onOpenGuide }: { onClose: () => void; onOpenGuide: () => void }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const s = STEPS[step];

  useEffect(() => {
    const measure = () => {
      if (!s.target) { setRect(null); return; }
      const el = document.querySelector(`[data-tour="${s.target}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [s.target]);

  const CARD_W = 320;
  const centered = !s.target || !rect;
  const cardLeft = centered
    ? Math.max(8, (window.innerWidth - CARD_W) / 2)
    : Math.min(Math.max(8, rect.left + rect.width / 2 - CARD_W / 2), window.innerWidth - CARD_W - 8);
  const cardTop = centered ? Math.max(60, window.innerHeight * 0.3) : rect.bottom + 14;
  const arrowLeft = rect ? rect.left + rect.width / 2 - cardLeft - 8 : 0;

  return (
    <div className="fixed inset-0 z-[100]" style={{ backgroundColor: "rgb(0 0 0 / 0.55)" }} onClick={onClose}>
      {/* Highlight ring around the target tab */}
      {rect && (
        <div
          className="fixed rounded-lg pointer-events-none"
          style={{
            top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8,
            boxShadow: "0 0 0 3px var(--accent), 0 0 0 6px rgb(255 255 255 / 0.25)",
          }}
        />
      )}

      <div
        className="fixed rounded-xl shadow-2xl p-4"
        style={{ top: cardTop, left: cardLeft, width: CARD_W, backgroundColor: "var(--card)", border: "1px solid var(--card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Arrow pointing up at the highlighted tab */}
        {!centered && (
          <div
            className="absolute -top-2 w-4 h-4 rotate-45"
            style={{ left: arrowLeft, backgroundColor: "var(--card)", borderTop: "1px solid var(--card-border)", borderLeft: "1px solid var(--card-border)" }}
          />
        )}

        <h3 className="text-sm font-semibold mb-1.5" style={{ color: "var(--text)" }}>{s.title}</h3>
        <p className="text-xs leading-relaxed mb-3" style={{ color: "var(--text-secondary)" }}>{s.body}</p>

        <div className="flex items-center gap-1 mb-3">
          {STEPS.map((_, i) => (
            <span key={i} className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: i === step ? "var(--accent)" : "var(--border-strong)" }} />
          ))}
        </div>

        <div className="flex items-center gap-2">
          {step > 0 && (
            <button onClick={() => setStep(step - 1)}
              className="px-2.5 py-1 rounded-lg text-xs font-medium"
              style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button onClick={() => setStep(step + 1)}
              className="px-2.5 py-1 rounded-lg text-xs font-semibold text-white"
              style={{ backgroundColor: "var(--accent)" }}>
              Next
            </button>
          ) : (
            <>
              <button onClick={onClose}
                className="px-2.5 py-1 rounded-lg text-xs font-semibold text-white"
                style={{ backgroundColor: "var(--accent)" }}>
                Done
              </button>
              <button onClick={onOpenGuide}
                className="px-2.5 py-1 rounded-lg text-xs font-medium"
                style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
                Open the full guide
              </button>
            </>
          )}
          <button onClick={onClose} className="ml-auto text-xs" style={{ color: "var(--text-tertiary)" }}>
            Skip tour
          </button>
        </div>
      </div>
    </div>
  );
}

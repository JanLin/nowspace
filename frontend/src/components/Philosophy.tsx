// The Nowspace philosophy — why the app is shaped the way it is. Mirrors
// docs/philosophy.md (the source for the future website); keep the two in
// step when editing. Opened from the ? help menu.

const SECTIONS: { title: string; body: string[] }[] = [
  {
    title: "Write it down, then let go",
    body: [
      "A thought that is written down is a thought acknowledged — and parked. It might be a task, or something deeper that needs real thinking through some other day. In the age of AI it might be an idea at 3 a.m. that suddenly seems possible. The intention is never to spend time on the thought in the moment: capture it in seconds, trust that it's recorded, and return to your life.",
      "That trust is the whole trick. Once your mind believes the system, it stops rehearsing the list at night.",
    ],
  },
  {
    title: "Nowspace is for now — your vault is for knowledge",
    body: [
      "Nowspace deliberately does one thing: it manages now — this day, this week, this timer, this habit. The deeper organization of information belongs outside it, in your notes, where a second brain can grow at its own pace. Nowspace just gives that second brain a place to live day to day: the same plain files, the same folder, two views of one life.",
    ],
  },
  {
    title: "When you're stuck, lean on the tools",
    body: [
      "Getting started, staying focused, and ignoring the rest are skills — and Nowspace carries small tools for each.",
      "🎺 The focus horn and the pomodoro tomato: pick the one thing, bold it, start the timer. One task, one stretch of time.",
      "🕶 Ultra-focus: everything except the task at hand disappears behind curtains until you're done. What you can't see can't tempt you.",
      "🏷 Contexts: separate work, volunteer and private life — and during work hours, show only work. If you work from home, this is the fence that keeps private things from creeping into the workday.",
      "📌 The pin: some private things genuinely must happen during work hours. Pin them — deliberate exceptions instead of an open gate.",
      "🐘 The white elephant: when something feels too tough to start, break it into baby steps. The first step is usually laughably small. That's the point.",
    ],
  },
  {
    title: "Big things shrink when you split them",
    body: [
      "A task that turns out to be a project doesn't have to loom. Split it with the white elephant, and when it deserves it, make it an epic: every step you finish is recorded as its own completed task on the day you did it. Progress becomes visible daily — the honest antidote to \"I worked all day and finished nothing.\"",
    ],
  },
  {
    title: "Horizons, not deadlines",
    body: [
      "Nowspace intentionally puts no dates on tasks. Dates manufacture stress and then expire into guilt. Instead, tasks live on gentle horizons — this week, next week, someday — and carry a simple priority: A must happen today, B should, C can, D is optional.",
      "Protect your A's, and don't let the rest creep in. A day with three finished A-tasks is a good day, whatever else happened.",
    ],
  },
  {
    title: "Balance is a practice",
    body: [
      "Habits in Nowspace are subtle reminders, not chores — a nudge to give good habits a chance and bad ones a challenge.",
      "And beyond the app: listen to your body. Don't let the desk, or the AI, overrule your life. The point of recording everything is to be able to stop thinking about it — take the mental break; the system will still know everything when you return.",
    ],
  },
  {
    title: "Sovereign by design",
    body: [
      "Everything Nowspace knows lives in plain, readable files on a disk you control. No accounts, no cloud you can't leave, no lock-in — open the folder in any editor and it's all just there, yours. This was a founding motivation, not an afterthought: a second brain you don't own is someone else's brain.",
    ],
  },
  {
    title: "Where it came from",
    body: [
      "Nowspace grew out of my own Obsidian vault. The knowledge lived happily there, but managing time on top of it became too complex — and the zen moment I was chasing (not worrying, because it's recorded for later) kept slipping away. So I built the missing surface: the calm, daily view onto files I already owned.",
    ],
  },
  {
    title: "If you want to read more",
    body: [
      "Getting Things Done — David Allen. The origin of capture-everything, horizons and the trusted system.",
      "Building a Second Brain — Tiago Forte. Why your notes deserve a life outside your head, and how to give them one.",
    ],
  },
];

export default function Philosophy({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[110] flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
      style={{ backgroundColor: "rgb(0 0 0 / 0.55)" }} onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl shadow-2xl p-5 sm:p-6 my-4"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--card-border)" }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>The Nowspace philosophy</h2>
          <button onClick={onClose} className="text-lg leading-none" style={{ color: "var(--text-tertiary)" }} aria-label="Close">✕</button>
        </div>
        <p className="text-xs leading-relaxed mb-4" style={{ color: "var(--text-secondary)" }}>
          Nowspace exists so that <em>now</em> can be calm. Everything in it serves one
          goal: to let you enjoy life — and sleep — because whatever is on your mind
          has a place to live that isn't your head.
        </p>
        <div className="space-y-5">
          {SECTIONS.map((sec) => (
            <section key={sec.title}>
              <h3 className="text-sm font-semibold mb-1.5" style={{ color: "var(--text)" }}>{sec.title}</h3>
              {sec.body.map((p, i) => (
                <p key={i} className="text-xs leading-relaxed mb-1.5" style={{ color: "var(--text-secondary)" }}>{p}</p>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

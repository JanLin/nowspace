// The longer companion to the quick tour — one scrollable page describing
// each tab and the small language Nowspace uses (priorities, horizons,
// tokens). Opened from the ? help menu or the tour's last step.

const SECTIONS: { title: string; body: string[] }[] = [
  {
    title: "Your vault — plain files you own",
    body: [
      "Everything in Nowspace is stored as readable markdown files in your vault folder: a week plan, a bucket list, habits, a time log, notes and diary entries. You can open the same folder in Obsidian or any editor — Nowspace reads and writes the exact same files, and nothing is locked in.",
    ],
  },
  {
    title: "Plan — the week, one day at a time",
    body: [
      "The Plan tab shows one day (or a grid of days) with tasks grouped the way you group them. Tick the circle to complete a task; double-click empty space to add one; drag to reorder or move between days.",
      "Every task has a priority badge — A, B, C or D, with a number for ordering. Click the badge for the quick menu: change priority, send the task back to the bucket (plain, or parked at a horizon), or move it to another weekday.",
      "Carry forward brings unfinished tasks along from earlier days whenever you're ready. Notes and a per-day diary live beside the task list, and the 🎺 focus horn starts a pomodoro — with an ultra-focus mode that curtains off every other task while you work.",
      "Long task that turned out to be a project? Break it into steps with the 🐘 elephant, then mark it as an epic in the badge menu: from then on, ticking a step records it as its own completed task for today, and the epic completes itself when the last step is done.",
    ],
  },
  {
    title: "Bucket — everything for later",
    body: [
      "The bucket holds anything you might do someday, organised into groups. Add quickly from the top bar (\"Group: task\" files it under the group), set priorities, and give tasks a horizon: n means this week, nw next week, m next month — written into the file as nA:, nwB:, mC: prefixes.",
      "The Board view lays the same tasks out as horizon columns — This week, Next week, Next month, Someday — so you can sweep through and park things where they belong. Tasks show how long they've been in the bucket; nothing leaves until you pick a weekday in a task's badge menu.",
      "Steps under a bucket task can be promoted to standalone tasks with the ↑ arrow, inheriting the parent's group, priority and horizon.",
    ],
  },
  {
    title: "Habits — gentle rhythms",
    body: [
      "Recurring habits for body, mind and soul, ticked through the week. A small strip on the Plan tab keeps them visible without turning them into chores.",
    ],
  },
  {
    title: "Time — one timer, honest logs",
    body: [
      "Start the timer on whatever you're doing; stop it from the bar at the bottom of the Plan tab or from the Time tab. Entries are edited in place — click a time, duration or description and type. Past entries can be added manually with a start and end or a duration.",
      "The distribution chart at the bottom shows where the period went, by company or life area. Tap a slice to filter the log to it; week, month and custom periods are a click away.",
    ],
  },
  {
    title: "Settings — your setup, everywhere",
    body: [
      "Vault location, reference folders, contexts and the diary folder. Shared settings live inside the vault itself, so if you sync the vault between machines, every install sees the same configuration.",
      "Contexts (work / volunteer / personal) let you filter the whole app to one part of life. Tag a task with @w, @v or @p to override its group's context, and @pin surfaces a personal task even while Work is selected.",
    ],
  },
  {
    title: "Safety nets",
    body: [
      "Everything autosaves a moment after you stop editing. If the file changed on disk meanwhile — another device, or an editor like Obsidian — Nowspace never overwrites silently: a banner offers Compare (see exactly what differs), Keep mine, or Reload.",
      "When a new version of Nowspace is deployed, a pill appears offering a restart. Your data is never touched by updates — it's all in the vault files.",
    ],
  },
];

export default function HelpGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[110] flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
      style={{ backgroundColor: "rgb(0 0 0 / 0.55)" }} onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl shadow-2xl p-5 sm:p-6 my-4"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--card-border)" }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>The Nowspace guide</h2>
          <button onClick={onClose} className="text-lg leading-none" style={{ color: "var(--text-tertiary)" }} aria-label="Close">✕</button>
        </div>
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

// The longer companion to the quick tour — one scrollable page describing
// each tab and the small language Nowspace uses (priorities, horizons,
// tokens), with annotated screenshots. Opened from the ? help menu or the
// tour's last step. Screenshots live in public/help/ (regenerate from a
// staged demo vault with hover icons forced visible).

type Item = { icon: string; text: string };

const TASK_ICONS: Item[] = [
  { icon: "○", text: "The circle marks a task done (and undone). Done tasks stay on the day — they are your history." },
  { icon: "A1", text: "The priority badge: A–D plus an order number. Click it for the quick menu — change priority, move the task to another weekday, or park it back in the bucket (plain or at a horizon)." },
  { icon: "⏳", text: "Mark the task as waiting on someone. A waiting task shows the hourglass in front of its name until you clear it." },
  { icon: "▶", text: "Start the time tracker on this task (pauses whatever was running)." },
  { icon: "📌", text: "Pin — only with contexts enabled: keeps a personal or volunteer task visible while Work is selected." },
  { icon: "🎺", text: "Focus: bolds the task and offers a pomodoro. Ultra-focus curtains every other task off while it runs." },
  { icon: "🐘", text: "Break the task into steps, or expand existing ones. An amber count means the task is an epic — ticking a step then records it as its own completed task for today." },
  { icon: "🔗", text: "Link a vault note to the task (or open its linked notes). A small number shows how many notes are linked." },
  { icon: "📂", text: "Move the task to another group." },
  { icon: "✕", text: "Delete the task." },
];

const CORNER_ICONS: Item[] = [
  { icon: "📁", text: "Vault browser — a side panel with your vault's folders and notes; open any note in the built-in editor, or drag one onto a task to link it." },
  { icon: "⏩", text: "Carry forward — the badge counts open tasks from earlier days. Open it to pull them into the day you're planning, mark them done after the fact, or send them to the bucket. A second ⏩ appears when last week left tasks behind." },
  { icon: "🪣", text: "Bucket panel — a slice of your bucket beside the plan (the badge is its size). Horizon chips filter it (n by default); tap a task to add it to the day, or drag it onto the plan." },
];

const SECTIONS: { title: string; img?: string; imgAlt?: string; imgClass?: string; items?: Item[]; body: string[] }[] = [
  {
    title: "Your vault — plain files you own",
    body: [
      "Everything in Nowspace is stored as readable markdown files in your vault folder: a week plan, a bucket list, habits, a time log, notes and diary entries. You can open the same folder in Obsidian or any editor — Nowspace reads and writes the exact same files, and nothing is locked in.",
    ],
  },
  {
    title: "Plan — the week, one day at a time",
    img: "/help/plan.png",
    imgAlt: "The Plan tab: day view with grouped tasks, notes panel and toolbar",
    body: [
      "The Plan tab shows one day (or a grid of days) with tasks grouped the way you group them. The toolbar filters by context (Tag), by group (Filter), and switches layouts (View). Tick the circle to complete a task; double-click empty space to add one; drag to reorder or move between days.",
      "Carry forward brings unfinished tasks along from earlier days whenever you're ready. Notes and a per-day diary live beside the task list.",
      "Long task that turned out to be a project? Break it into steps with the 🐘 elephant, then mark it as an epic in the badge menu: from then on, ticking a step records it as its own completed task for today, and the epic completes itself when the last step is done.",
    ],
  },
  {
    title: "Anatomy of a task",
    img: "/help/task-row.png",
    imgAlt: "A task row with all its action icons visible",
    items: TASK_ICONS,
    body: [
      "Every task row carries the same small toolkit. On a computer the action icons appear when you hover the row; on phones and tablets they are always faintly visible, on their own line under the title.",
    ],
  },
  {
    title: "Moving tasks — drag, or tap",
    items: [
      { icon: "↕", text: "Drag a task up or down to reorder the day, or drop it on another group to refile it. Groups themselves reorder by their ≡ handle." },
      { icon: "📅", text: "In the multi-day views (3 Day, Mon–Fri, Full week), drag tasks straight between day columns. In Day view, the badge menu's weekday row makes the same jump — tap the badge, tap a day." },
      { icon: "🪣", text: "Drag a task onto the bucket button in the corner to send it back to the bucket. The badge menu does the same with more control: park it plain, or at a horizon (n / nw / m), in two taps." },
      { icon: "⏩", text: "From the carry-forward and bucket panels, drag an item onto any day button in the week strip to file it into that exact day — or simply tap it to add it to the day you're viewing." },
      { icon: "🐘", text: "Drag a step out of an elephant breakdown to promote it to a full task (the ↑ arrow does the same on touch); drop a task onto another task's steps to demote it into one." },
      { icon: "🔗", text: "Drag a note from the vault browser onto a task to link it, or into the notes area to insert a [[wiki link]]." },
    ],
    body: [
      "Where a task lives — its position, day, group, or whether it's in the plan at all — can always be changed two ways: by dragging on a computer, or through the priority-badge menu, which works everywhere and is the path on phones and tablets. Nothing is drag-only.",
    ],
  },
  {
    title: "The corner buttons",
    img: "/help/corner.png",
    imgAlt: "The floating buttons in the bottom-right corner",
    imgClass: "max-w-[220px]",
    items: CORNER_ICONS,
    body: [
      "The floating buttons in the bottom-right corner of the Plan tab open side panels. The bar along the very bottom shows autosave state, undo/redo, and the running timer with its stop button.",
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
    title: "Bucket stages — the funnel",
    body: [
      "Everything you capture lands in Captured. Nothing is judged there and nothing is required — capture stays fast on purpose, because an inbox you hesitate to use is an inbox you stop trusting.",
      "Once a week you promote a few items into Binding. This is the small set of topics you're actively carrying — at most four, because the limit is what makes it a priority list rather than a pile. Each one holds a question rather than a title, since your mind works on questions and ignores nouns.",
      "An item leaves Binding when it has one concrete next action and a size. That's what Ready means, and only Ready items can be scheduled in the Plan tab. This is deliberate: an unbounded topic can't be scheduled honestly, and pretending otherwise is how weeks quietly fail.",
      "Dormant is a decision, not a failure. A dormant item has a wake date and stays silent until then. Parking something on purpose feels completely different from carrying it undecided, and most of the weight you feel in a task list comes from items in the second category.",
      "Discarded items record why they were dropped — no agency, already decided, or not yours. The reason is what stops the same topic reappearing next month.",
    ],
  },
  {
    title: "Solve and rehearse — the Slate",
    body: [
      "Binding items are marked solve or rehearse. Solve items are open problems: they generate loops, so the Slate shows them in the morning and hides them after your evening cutoff. Rehearse items are practice on things you already know — a question you got wrong, a form you keep misusing. They resolve nothing and start nothing, which makes them safe to look at before sleep.",
      "One rule worth keeping: don't take rehearse items to an AI chat. The value is in the effort of recalling; being handed the answer removes the part that makes it stick.",
      "The Slate also has a capture box, so the pre-sleep ritual becomes read-then-write: glance at what you're rehearsing, put down whatever surfaced, let it go. If you like a morning trigger, add an \"open the slate\" habit — opening it may be tracked; thinking may not.",
    ],
  },
  {
    title: "The weekly review",
    body: [
      "Five minutes, once a week — the 🧭 Review button on the Bucket tab. You reconcile what slipped, check whether your Binding items produced anything new, refill empty slots, and set one line for the week.",
      "If an item slips three weeks running, you'll be asked one question: was it too big, or was it not actually important? Too big sends it back to Binding to be re-scoped. Not important sends it to Dormant. Those are the only two honest answers, and the system would rather you gave one than carried it a fourth week.",
    ],
  },
  {
    title: "Handing work to an agent",
    body: [
      "A Bucket item can be handed to an agent for the area it belongs to (the 🤝 Handoff button, or \"agent\" in an item's badge menu). You attach the notes the agent should read, name what you expect back — a diagnosis, a patch, some options, a critique — and Nowspace checks that everything you named stays inside that one area.",
      "If a note reaches outside the area, through a link or an embed, the handoff isn't available. That isn't strictness for its own sake: the whole point of separating areas is that one customer's material never reaches an agent working for another, and a check you can click past isn't a check.",
      "Captured items can't be handed off. Neither can rehearse items — the value of practice is the effort of recalling, and an answer removes it.",
      "What comes back arrives in the Returned lane and lands in your inbox as Captured, exactly like anything else you write down. It doesn't become a scheduled task, and nothing is promoted on your behalf. The agent can help you answer a question; deciding which questions you carry stays yours.",
      "Why only three at once? The same reason there are only four Binding items. Agent work is fast, satisfying and visible, which makes it the easiest thing in your week to do instead of the work that was actually due. Three in flight, and a fourth asks you which one is finished.",
    ],
  },
  {
    title: "Why Nowspace never notifies you about overdue work",
    body: [
      "It doesn't, and it won't. See the principles (Philosophy in the help menu).",
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
        <div className="space-y-6">
          {SECTIONS.map((sec) => (
            <section key={sec.title}>
              <h3 className="text-sm font-semibold mb-1.5" style={{ color: "var(--text)" }}>{sec.title}</h3>
              {sec.body.map((p, i) => (
                <p key={i} className="text-xs leading-relaxed mb-1.5" style={{ color: "var(--text-secondary)" }}>{p}</p>
              ))}
              {sec.img && (
                <img src={sec.img} alt={sec.imgAlt || sec.title}
                  className={`w-full ${sec.imgClass || ""} rounded-lg my-2`}
                  style={{ border: "1px solid var(--border-strong)" }} />
              )}
              {sec.items && (
                <ul className="space-y-1.5 mt-2">
                  {sec.items.map((it) => (
                    <li key={it.icon} className="flex items-start gap-2 text-xs leading-relaxed">
                      <span className="shrink-0 w-8 text-center font-semibold rounded px-1"
                        style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text)" }}>{it.icon}</span>
                      <span style={{ color: "var(--text-secondary)" }}>{it.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

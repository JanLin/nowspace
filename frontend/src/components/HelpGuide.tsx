import { useEffect } from "react";

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
  { icon: "🔗", text: "Tap to open the task's linked note. Hold it (or right-click) to manage the links instead — open, remove one that no longer applies, or point it at a different note. A small number shows how many notes are linked; with more than one, a tap opens the list." },
  { icon: "📂", text: "Move the task to another group." },
  { icon: "✕", text: "Delete the task." },
];

const CORNER_ICONS: Item[] = [
  { icon: "📁", text: "Vault browser — a side panel with your vault's folders and notes. Search by name, open any note in the built-in editor, drag one onto a task to link it, and make a new note, call note or folder in whichever folder you have open — anywhere in the vault, not just your starred ones. It sits in the Plan, Bucket and Notes tabs." },
  { icon: "⏩", text: "Carry forward — the badge counts open tasks from earlier days. Open it to pull them into the day you're planning, mark them done after the fact, or send them to the bucket. A second ⏩ appears when last week left tasks behind." },
  { icon: "🪣", text: "Bucket panel — a slice of your bucket beside the plan (the badge is its size). Horizon chips filter it (n by default); tap a task to add it to the day, or drag it onto the plan." },
];

const SECTIONS: { id?: string; title: string; img?: string; imgAlt?: string; imgClass?: string; items?: Item[]; body: string[]; diagram?: "funnel" }[] = [
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
    title: "Basic or Advanced",
    body: [
      "Settings › How you work decides how much of Nowspace is switched on. Basic is plain GTD: groups, priorities, horizons (n / nw / m) and weekdays — capture something, give it a priority, put it on a day.",
      "Advanced doesn't switch anything on by itself — it reveals two options, each with a ? that opens the right part of this guide. The Funnel adds stages, the shaping question, t-shirt sizes, the weekly review and the Slate: a way of refusing to schedule work you haven't thought about yet, since nothing reaches a weekday until it's Ready. Agent handoff is the second, and stays off unless you ask for it.",
      "With the Funnel off — whether you're on Basic, or on Advanced without it — none of its marks are written into your vault, and marks already there are never touched. Your stages, sizes and shaping questions stay in the files, ignored; switch the Funnel back on and they're as you left them.",
    ],
  },
  {
    title: "Bucket — everything for later",
    body: [
      "The bucket holds anything you might do someday, organised into groups. Add quickly from the top bar (\"Group: task\" files it under the group), set priorities, and give tasks a horizon: n means this week, nw next week, m next month — written into the file as nA:, nwB:, mC: prefixes.",
      "The Board view lays the same tasks out as horizon columns — This week, Next week, Next month, Someday — so you can sweep through and park things where they belong. Tasks show how long they've been in the bucket; nothing leaves until you pick a weekday in a task's badge menu.",
      "Steps under a bucket task can be promoted to standalone tasks with the ↑ arrow, inheriting the parent's group, priority and horizon.",
      "When you've set up tags (Work / Volunteer / Personal in Settings), the bucket splits into a lane per tag — a hairline, the tag's name, and how much sits under it — so you can review one area at a time. Clicking a lane's bar folds every group in it. Groups with no tag land under Personal.",
      "Each group header carries a ≡ handle: drag it onto another group to reorder, or onto a tag's bar to move the whole group to that tag (which updates the group's tag in Settings, so the Plan tab agrees). \"Sort by tag\" then reorders the file so the groups sit in lane order — task order inside a group is left alone.",
    ],
  },
  {
    id: "funnel",
    title: "Bucket stages — the funnel",
    diagram: "funnel",
    body: [
      "The funnel is optional: Settings › How you work › Advanced, then the Funnel switch. With it off, the Bucket is plain GTD and none of what follows appears — nor is any of it written into your vault.",
      "Everything you capture lands in Captured. Nothing is judged there and nothing is required — capture stays fast on purpose, because an inbox you hesitate to use is an inbox you stop trusting.",
      "Once a week you promote a few items into Shaping. This is the small set of topics you're actively carrying — at most four, because the limit is what makes it a priority list rather than a pile. Each one holds a question rather than a title, since your mind works on questions and ignores nouns.",
      "Ready means bounded: the item has a size (s/m/l), and steps if it needed breaking down — a task that is itself the action just gets a size (on a captured item, tapping a size in the badge menu marks it Ready in one tap). Only Ready items can be scheduled in the Plan tab. This is deliberate: an unbounded topic can't be scheduled honestly, and pretending otherwise is how weeks quietly fail.",
      "Dormant is a decision, not a failure. A dormant item has a wake date and stays silent until then. Parking something on purpose feels completely different from carrying it undecided, and most of the weight you feel in a task list comes from items in the second category.",
      "Discarded items record why they were dropped — no agency, already decided, or not yours. The reason is what stops the same topic reappearing next month.",
      "The Stage chips filter the bucket by stage. \"Open\" is the one you'll sit in: Captured plus Ready — everything actually in play. It leaves out Shaping (which has its own strip above the list), Dormant (silent until its wake date) and Discarded (kept only as a record). The other chips are for when you want exactly one stage: what's waiting to be judged, what's parked, what you dropped and why.",
    ],
  },
  {
    title: "Notes — several open at once",
    body: [
      "Opening a note from a task's 🔗, or from a [[link]], adds it to the Notes tab as a sub-tab. Tap a sub-tab to read that note; the tabs stay put while you work in Plan or Bucket, so you can carry a few notes through a session instead of losing one each time you open another.",
      "Settings decides how many stay open — five by default. Past that, opening another closes the note you've left unread longest. 📌 pins a note so it's never the one closed, which means pinning more than the limit simply grows the strip. Drag a sub-tab to reorder, × closes one, and \"Clear all\" closes everything including the pinned ones.",
      "The open set lives in the shared settings file, so the same notes are open on the Mac app, the mini and your phone.",
      "The 📁 button opens the vault beside what you're reading: browse or search, and anything you open joins the strip as another sub-tab. New notes and folders can be made in whatever folder you're looking at, which is how a call note gets filed somewhere you hadn't set up in advance.",
    ],
  },
  {
    title: "Solve and rehearse — the Slate",
    body: [
      "Shaping items are marked solve or rehearse. Solve items are open problems: they generate loops, so the Slate shows them in the morning and hides them after your evening cutoff. Rehearse items are practice on things you already know — a question you got wrong, a form you keep misusing. They resolve nothing and start nothing, which makes them safe to look at before sleep.",
      "One rule worth keeping: don't take rehearse items to an AI chat. The value is in the effort of recalling; being handed the answer removes the part that makes it stick.",
      "The Slate opens from the Nowspace compass in the top-left corner — tap the logo, at any hour; tap it again to leave. It has no tab on purpose: it's a pause, not a destination. After your evening cutoff a small half-moon appears beside the logo — a quiet state signal, never a badge.",
      "The Slate also has a capture box, so the pre-sleep ritual becomes read-then-write: glance at what you're rehearsing, put down whatever surfaced, let it go. If you like a morning trigger, add an \"open the slate\" habit — opening it may be tracked; thinking may not.",
    ],
  },
  {
    title: "The weekly review",
    body: [
      "Five minutes, once a week — the 🧭 Review button on the Bucket tab. You reconcile what slipped, check whether your Shaping items produced anything new, refill empty slots, and set one line for the week.",
      "If an item slips three weeks running, you'll be asked one question: was it too big, or was it not actually important? Too big sends it back to Shaping to be re-scoped. Not important sends it to Dormant. Those are the only two honest answers, and the system would rather you gave one than carried it a fourth week.",
    ],
  },
  {
    id: "handoff",
    title: "Handing work to an agent",
    body: [
      "Optional, and off unless you ask for it: Settings › How you work › Advanced, then the Agent handoff switch.",
      "A Bucket item can be handed to an agent for the area it belongs to (the 🤝 Handoff button, or \"agent\" in an item's badge menu). You attach the notes the agent should read, name what you expect back — a diagnosis, a patch, some options, a critique — and Nowspace checks that everything you named stays inside that one area.",
      "If a note reaches outside the area, through a link or an embed, the handoff isn't available. That isn't strictness for its own sake: the whole point of separating areas is that one customer's material never reaches an agent working for another, and a check you can click past isn't a check.",
      "Captured items can't be handed off. Neither can rehearse items — the value of practice is the effort of recalling, and an answer removes it.",
      "What comes back arrives in the Returned lane and lands in your inbox as Captured, exactly like anything else you write down. It doesn't become a scheduled task, and nothing is promoted on your behalf. The agent can help you answer a question; deciding which questions you carry stays yours.",
      "Why only three at once? The same reason there are only four Shaping items. Agent work is fast, satisfying and visible, which makes it the easiest thing in your week to do instead of the work that was actually due. Three in flight, and a fourth asks you which one is finished.",
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
      "Vault location, reference folders, contexts and the diary folder — plus the theme and this guide, under Appearance & help. Shared settings live inside the vault itself, so if you sync the vault between machines, every install sees the same configuration (the theme is per device).",
      "Contexts (work / volunteer / personal) let you filter the whole app to one part of life. Tag a task with @w, @v or @p to override its group's context, and @pin surfaces a personal task even while Work is selected.",
    ],
  },
  {
    title: "Finding a task",
    body: [
      "The \u{1F50D} in the header (or \u2318K / Ctrl-K) searches the current Plan week and the Bucket together \u2014 or either alone with the scope chips. Results show where each task lives (day of the week, or bucket stage) and its group; picking one jumps to that tab, opens the group and flashes the task. Group names match too, so searching a group lists everything in it.",
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

/** The funnel as a picture: where a captured thing can go, and what each
    move costs you in thinking. Drawn with currentColor and CSS variables so
    it reads in both themes, and scaled by viewBox so it survives a phone. */
function FunnelDiagram() {
  const box = { fill: "var(--bg-tertiary)", stroke: "var(--border-strong)" };
  const label = { fill: "var(--text)", fontSize: 11, fontWeight: 600 };
  const sub = { fill: "var(--text-tertiary)", fontSize: 8.5 };
  return (
    <svg viewBox="0 0 520 200" className="w-full my-2" role="img"
      aria-label="Capture, shaping, ready, then a weekday — with dormant and discarded as exits">
      <defs>
        <marker id="fa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--text-tertiary)" />
        </marker>
      </defs>
      {[["Captured", 8, "anything, unjudged"], ["Shaping", 138, "one question at a time"],
        ["Ready", 268, "next action + size"], ["A weekday", 398, "it leaves the bucket"]].map(([name, x, hint], i) => (
        <g key={name as string}>
          <rect x={x as number} y={20} width={114} height={44} rx={8} {...box} strokeWidth={1} />
          <text x={(x as number) + 57} y={40} textAnchor="middle" {...label}>{name}</text>
          <text x={(x as number) + 57} y={54} textAnchor="middle" {...sub}>{hint}</text>
          {i < 3 && <line x1={(x as number) + 116} y1={42} x2={(x as number) + 128} y2={42}
            stroke="var(--text-tertiary)" strokeWidth={1.5} markerEnd="url(#fa)" />}
        </g>
      ))}
      {/* the two exits, reachable from anywhere on the left of the line */}
      {[["Dormant", 138, "wakes on a date"], ["Discarded", 268, "with a reason"]].map(([name, x, hint]) => (
        <g key={name as string}>
          <line x1={(x as number) + 57} y1={66} x2={(x as number) + 57} y2={116}
            stroke="var(--text-tertiary)" strokeWidth={1.2} strokeDasharray="3 3" markerEnd="url(#fa)" />
          <rect x={x as number} y={120} width={114} height={44} rx={8} {...box} strokeWidth={1} />
          <text x={(x as number) + 57} y={140} textAnchor="middle" {...label}>{name}</text>
          <text x={(x as number) + 57} y={154} textAnchor="middle" {...sub}>{hint}</text>
        </g>
      ))}
      <text x={8} y={188} {...sub}>Only Ready reaches a weekday. Dormant and Discarded are exits, not failures.</text>
    </svg>
  );
}

export default function HelpGuide({ onClose, initialSection }: { onClose: () => void; initialSection?: string }) {
  // Land on the section the ? came from. The guide's screenshots load late
  // and move everything below them, so a single scroll on mount aims at a
  // layout that no longer exists a moment later — keep nudging until the
  // heading is actually at the top, then stop.
  useEffect(() => {
    if (!initialSection) return;
    let tries = 0;
    const id = setInterval(() => {
      const el = document.getElementById(`guide-${initialSection}`);
      const scroller = el?.closest<HTMLElement>(".overflow-y-auto");
      if (el && scroller) {
        const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
        if (Math.abs(delta) < 4) { clearInterval(id); return; }
        scroller.scrollTop += delta;
      }
      if (++tries > 12) clearInterval(id);   // ~1s, then leave it alone
    }, 80);
    return () => clearInterval(id);
  }, [initialSection]);

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
            <section key={sec.title} id={sec.id ? `guide-${sec.id}` : undefined} style={{ scrollMarginTop: 8 }}>
              <h3 className="text-sm font-semibold mb-1.5" style={{ color: "var(--text)" }}>{sec.title}</h3>
              {sec.body.map((p, i) => (
                <p key={i} className="text-xs leading-relaxed mb-1.5" style={{ color: "var(--text-secondary)" }}>{p}</p>
              ))}
              {sec.diagram === "funnel" && <FunnelDiagram />}
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

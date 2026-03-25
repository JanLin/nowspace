import { useState, useEffect } from "react";
import { api, type CoachResponse, type Task, type PillarBalance } from "../api";

const PRIORITY_BADGE: Record<string, string> = {
  A: "bg-red-100 text-red-700",
  B: "bg-amber-100 text-amber-700",
  C: "bg-green-100 text-green-700",
  D: "bg-gray-100 text-gray-500",
};

const PRIORITIES = ["A", "B", "C", "D"] as const;

const PILLAR_ICONS: Record<string, { symbol: string; title: string; description: string }> = {
  social: { symbol: "\u{1F91D}", title: "Social connection", description: "Meaningful interactions with friends, family, and community. Includes catching up, helping others, and nurturing relationships." },
  recovery: { symbol: "\u{1F9D8}", title: "Recovery (without guilt)", description: "Rest, exercise, sauna, walks, and activities that recharge energy. Taking breaks without feeling guilty about not being productive." },
  play: { symbol: "\u{1F3AE}", title: "Purposeful play / tinkering", description: "Creative exploration, side projects, and learning new things for fun. Building things without pressure — like this coaching agent." },
  progress: { symbol: "\u{1F4CA}", title: "Structured progress", description: "Focused work on business goals, client projects, and career milestones. Moving the needle on things that matter professionally." },
  longterm: { symbol: "\u{1F3AF}", title: "Long term goals", description: "Strategic investments in the future — planning, big decisions, financial goals, and vision work that compounds over time." },
};

// Map full pillar names to short keys for icon lookup
const PILLAR_NAME_TO_KEY: Record<string, string> = {
  "social connection": "social",
  "recovery (without guilt)": "recovery",
  "purposeful play / tinkering": "play",
  "structured progress": "progress",
  "long term goals": "longterm",
};

function sortByPriority(tasks: Task[]): Task[] {
  const order: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
  return [...tasks].sort(
    (a, b) => (order[a.priority] ?? 4) - (order[b.priority] ?? 4)
  );
}

interface Message {
  role: "assistant" | "user";
  text: string;
}

function FormattedText({ text }: { text: string }) {
  // Remove --- separators, then split into paragraphs on blank lines
  const cleaned = text.replace(/\n?---\n?/g, "\n\n");
  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className="space-y-2">
      {paragraphs.map((para, pi) => {
        // Bold: **text**
        const parts = para.split(/(\*\*[^*]+\*\*)/g);
        return (
          <p key={pi}>
            {parts.map((part, i) => {
              if (part.startsWith("**") && part.endsWith("**")) {
                return (
                  <strong key={i} className="font-semibold">
                    {part.slice(2, -2)}
                  </strong>
                );
              }
              return <span key={i}>{part}</span>;
            })}
          </p>
        );
      })}
    </div>
  );
}

export default function Coaching({
  sessionId,
  tasks,
  onTasksChanged,
}: {
  sessionId: string | null;
  tasks: Task[];
  onTasksChanged: (tasks: Task[]) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [complete, setComplete] = useState(false);
  const [priorityMenuIdx, setPriorityMenuIdx] = useState<number | null>(null);
  const [pillars, setPillars] = useState<PillarBalance[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [logContent, setLogContent] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);

  useEffect(() => {
    api.getMemory().then((m) => setPillars(m.pillar_balance)).catch(() => {});
  }, []);

  const fetchLog = async () => {
    setLogLoading(true);
    try {
      const mem = await api.getMemory();
      // Extract today's entry from weekly log
      const today = new Date().toISOString().slice(0, 10);
      const heading = `### ${today}`;
      const idx = mem.weekly_log.indexOf(heading);
      if (idx >= 0) {
        const afterHeading = mem.weekly_log.slice(idx + heading.length);
        const nextEntry = afterHeading.indexOf("\n### ");
        const todayLog = nextEntry >= 0 ? afterHeading.slice(0, nextEntry) : afterHeading;
        setLogContent(todayLog.trim());
      } else {
        setLogContent("No log entry for today yet.");
      }
    } catch {
      setLogContent("Could not load log.");
    } finally {
      setLogLoading(false);
    }
  };

  const toggleLog = async () => {
    if (!showLog) {
      await fetchLog();
    }
    setShowLog(!showLog);
  };

  const focusTasks = tasks.filter((t) => t.priority === "A" || t.priority === "B");

  const changePriority = (taskText: string, newPriority: string) => {
    const updated = tasks.map((t) =>
      t.text === taskText ? { ...t, priority: newPriority } : t
    );
    onTasksChanged(sortByPriority(updated));
    setPriorityMenuIdx(null);
  };

  const startSession = async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const res: CoachResponse = await api.startCoach(sessionId);
      setMessages([{ role: "assistant", text: res.message }]);
      setStarted(true);
    } catch {
      setMessages([
        {
          role: "assistant",
          text: "Could not start coaching. Make sure the plan is approved first.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || !sessionId) return;
    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text: userMsg }]);
    setLoading(true);
    try {
      const res = await api.respondCoach(sessionId, userMsg);
      setMessages((prev) => [...prev, { role: "assistant", text: res.message }]);
      if (res.session_complete) {
        setComplete(true);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "Something went wrong. Try again." },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const pillarPanel = pillars.length > 0 && (
    <div className="mb-4 border border-gray-100 rounded-lg p-3 bg-gray-50">
      <p className="text-xs font-medium text-gray-500 mb-2">Pillar balance</p>
      <div className="grid grid-cols-2 gap-y-1.5 gap-x-4">
        {pillars.map((p) => {
          const key = PILLAR_NAME_TO_KEY[p.name.toLowerCase()] || "";
          const icon = PILLAR_ICONS[key];
          return (
            <div key={p.name} className="relative group flex items-center gap-1.5 text-xs cursor-help">
              {icon && <span>{icon.symbol}</span>}
              <span className="text-gray-500 min-w-0 truncate">{p.name}</span>
              <div className="flex gap-0.5 shrink-0 ml-auto">
                {[1, 2, 3, 4, 5].map((n) => (
                  <div
                    key={n}
                    className={`w-1.5 h-3 rounded-sm ${
                      n <= p.score
                        ? p.score <= 2
                          ? "bg-red-400"
                          : p.score <= 3
                            ? "bg-amber-400"
                            : "bg-green-400"
                        : "bg-gray-200"
                    }`}
                  />
                ))}
              </div>
              {icon?.description && (
                <div className="absolute left-0 top-full mt-1 z-50 hidden group-hover:block w-56 p-2 rounded-lg bg-gray-800 text-white text-xs leading-relaxed shadow-lg">
                  <p className="font-medium mb-0.5">{icon.title}</p>
                  <p className="text-gray-300">{icon.description}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  const focusPanel = focusTasks.length > 0 && (
    <div className="mb-4 border border-gray-100 rounded-lg p-3 bg-gray-50">
      <p className="text-xs font-medium text-gray-500 mb-2">Today's focus</p>
      <div className="space-y-1">
        {focusTasks.map((task, i) => (
          <div key={task.text} className="flex items-center gap-2 text-sm">
            <div className="relative shrink-0">
              <button
                onClick={() => setPriorityMenuIdx(priorityMenuIdx === i ? null : i)}
                className={`px-1.5 py-0.5 rounded text-xs font-bold cursor-pointer hover:opacity-70 transition-opacity ${PRIORITY_BADGE[task.priority]}`}
              >
                {task.priority}
              </button>
              {priorityMenuIdx === i && (
                <div className="absolute left-0 top-full mt-1 flex gap-0.5 z-10 bg-white rounded shadow-md p-1">
                  {PRIORITIES.filter((p) => p !== task.priority).map((p) => (
                    <button
                      key={p}
                      onClick={() => changePriority(task.text, p)}
                      className={`px-1.5 py-0.5 rounded text-xs font-bold cursor-pointer hover:opacity-70 transition-opacity ${PRIORITY_BADGE[p]}`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className="text-gray-800">{task.text}</span>
            {task.pillars?.length > 0 && (
              <span className="shrink-0" title={task.pillars.map((p) => PILLAR_ICONS[p]?.title || p).join(", ")}>
                {task.pillars.map((p) => PILLAR_ICONS[p]?.symbol || p).join("")}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  if (!sessionId) {
    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900">Coaching</h2>
          <button
            onClick={toggleLog}
            disabled={logLoading}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            {logLoading ? "Loading..." : showLog ? "Hide log" : "View log"}
          </button>
        </div>
        {showLog && logContent && (
          <div className="mb-4 bg-gray-50 border border-gray-200 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200">
              <span className="text-xs font-medium text-gray-500">Today's log</span>
              <button
                onClick={fetchLog}
                disabled={logLoading}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                {logLoading ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            <div className="p-3 text-xs text-gray-700 whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
              {logContent}
            </div>
          </div>
        )}
        {pillarPanel}
        {focusPanel}
        <div className="py-8 text-center text-gray-400">
          <p className="text-lg">No active session</p>
          <p className="text-sm mt-1">
            Generate and approve a plan first
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-900">Coaching</h2>
        <button
          onClick={toggleLog}
          disabled={logLoading}
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
        >
          {logLoading ? "Loading..." : showLog ? "Hide log" : "View log"}
        </button>
      </div>

      {showLog && logContent && (
        <div className="mb-4 bg-gray-50 border border-gray-200 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200">
            <span className="text-xs font-medium text-gray-500">Today's log</span>
            <button
              onClick={fetchLog}
              disabled={logLoading}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              {logLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          <div className="p-3 text-xs text-gray-700 whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
            {logContent}
          </div>
        </div>
      )}

      {pillarPanel}
      {focusPanel}

      {!started && (
        <div className="flex-1 flex items-center justify-center">
          <button
            onClick={startSession}
            disabled={loading}
            className="px-6 py-3 bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            {loading ? "Starting..." : "Start Coaching Session"}
          </button>
        </div>
      )}

      {started && (
        <>
          <div className="flex-1 space-y-3 overflow-y-auto mb-4">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`p-3 rounded-lg text-sm ${
                  msg.role === "assistant"
                    ? "bg-gray-50 text-gray-800"
                    : "bg-blue-50 text-blue-900 ml-8"
                }`}
              >
                <FormattedText text={msg.text} />
              </div>
            ))}
            {loading && (
              <div className="p-3 bg-gray-50 rounded-lg text-sm text-gray-400">
                Thinking...
              </div>
            )}
          </div>

          {complete ? (
            <div>
              <div className="p-3 bg-green-50 text-green-700 rounded-lg text-sm font-medium">
                Session complete — summary saved to memory.
              </div>
              <button
                onClick={toggleLog}
                disabled={logLoading}
                className="mt-2 px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                {logLoading ? "Loading..." : showLog ? "Hide Log" : "View Log"}
              </button>
              {showLog && logContent && (
                <div className="mt-2 bg-gray-50 border border-gray-200 rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200">
                    <span className="text-xs font-medium text-gray-500">Today's log</span>
                    <button
                      onClick={fetchLog}
                      disabled={logLoading}
                      className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      {logLoading ? "Refreshing..." : "Refresh"}
                    </button>
                  </div>
                  <div className="p-3 text-xs text-gray-700 whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
                    {logContent}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !loading && sendMessage()}
                placeholder="Type your response..."
                className="flex-1 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                disabled={loading}
              />
              <button
                onClick={sendMessage}
                disabled={loading || !input.trim()}
                className="px-4 py-2.5 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
              >
                Send
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

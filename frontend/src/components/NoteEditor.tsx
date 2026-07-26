import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import MDEditor from "@uiw/react-md-editor";
import { api } from "../api";
import { findOpenAPs, markHarvested, defaultSections, canonicalGroup } from "../actionPoints";

const VAULT_NAME = "Home";
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function obsidianUri(path: string): string {
  return `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`;
}

/* ── Wiki link autocomplete dropdown ─────────────────────── */

function WikiSuggestions({
  query,
  position,
  onSelect,
}: {
  query: string;
  position: { top: number; left: number };
  onSelect: (name: string) => void;
}) {
  const [results, setResults] = useState<{ name: string; path: string }[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (query.length < 2) { setResults([]); return; }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api.vaultSearch(query, 8);
        setResults(res.results.map((r) => ({ name: r.name, path: r.path })));
      } catch { setResults([]); }
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  if (results.length === 0) return null;

  return (
    <div
      className="fixed z-[60] bg-white rounded-lg shadow-xl border p-1 min-w-[220px] max-h-48 overflow-y-auto"
      style={{ top: position.top, left: position.left }}
    >
      {results.map((r) => (
        <button
          key={r.path}
          onMouseDown={(e) => { e.preventDefault(); onSelect(r.name); }}
          className="w-full text-left px-2 py-1 text-xs rounded hover:bg-blue-50 hover:text-blue-700 text-gray-700 truncate"
        >
          {r.name}
          <span className="text-[10px] text-gray-400 ml-1">
            {r.path.split("/").slice(0, -1).join("/")}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ── Conflict diff: LCS line diff, capped for huge files ──── */

type DiffRow = { type: "same" | "mine" | "disk"; text: string };

function lineDiff(mine: string, disk: string): DiffRow[] | null {
  const a = mine.split("\n");
  const b = disk.split("\n");
  if (a.length * b.length > 250000) return null; // too big — panel falls back
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { rows.push({ type: "same", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ type: "mine", text: a[i] }); i++; }
    else { rows.push({ type: "disk", text: b[j] }); j++; }
  }
  while (i < m) { rows.push({ type: "mine", text: a[i] }); i++; }
  while (j < n) { rows.push({ type: "disk", text: b[j] }); j++; }
  return rows;
}

/* ── Navigation history entry ────────────────────────────── */

interface HistoryEntry {
  path: string;
  name: string;
}

/* ── Main NoteEditor component ───────────────────────────── */

export interface NoteEditorProps {
  initialPath: string;
  initialName?: string;
  onClose: () => void;
  /** Render inline (e.g. in the Notes tab) instead of as a full-screen modal. */
  embedded?: boolean;
}

export default function NoteEditor({ initialPath, initialName, onClose, embedded = false }: NoteEditorProps) {
  // Small screens can't afford the split live view — each half ends up too
  // narrow to read. Below the breakpoint the editor is single-pane: write
  // in "edit", flip to "preview" when done (toggle in the header).
  const [narrow, setNarrow] = useState(() => window.innerWidth < 768);
  const [mobilePreview, setMobilePreview] = useState(false);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [lastModified, setLastModified] = useState("");
  const [hasUnsaved, setHasUnsaved] = useState(false);
  // External-change conflict: hold BOTH versions and let the user choose —
  // the buffer is never replaced without an explicit decision
  const [conflict, setConflict] = useState<{ disk: string; diskModified: string } | null>(null);
  const conflictRef = useRef<typeof conflict>(null);
  conflictRef.current = conflict;
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [currentName, setCurrentName] = useState(initialName || pathToName(initialPath));

  // Navigation history
  const [history, setHistory] = useState<HistoryEntry[]>([{ path: initialPath, name: initialName || pathToName(initialPath) }]);
  const [historyIdx, setHistoryIdx] = useState(0);

  // Wiki autocomplete state
  const [wikiQuery, setWikiQuery] = useState("");
  const [wikiPos, setWikiPos] = useState({ top: 0, left: 0 });
  const [showWiki, setShowWiki] = useState(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const editorRef = useRef<HTMLDivElement>(null);
  const serverContentRef = useRef("");

  // Action points in the open note (see actionPoints.ts for the AP convention)
  const [showAPs, setShowAPs] = useState(false);
  const [apSelected, setApSelected] = useState<Set<number>>(new Set());
  const [apBusy, setApBusy] = useState(false);
  const [refLinks, setRefLinks] = useState<Record<string, string>>({});
  const openAPs = useMemo(() => (loading ? [] : findOpenAPs(content)), [content, loading]);

  useEffect(() => {
    api.referenceLinks().then((r) => setRefLinks(r.links)).catch(() => {});
  }, []);
  useEffect(() => { setShowAPs(false); }, [currentPath]);

  // Pre-select only the newest call's APs — long histories stay opt-in
  const openAPPanel = () => {
    const defaults = defaultSections(openAPs);
    setApSelected(new Set(openAPs.filter((a) => defaults.has(a.section)).map((a) => a.line)));
    setShowAPs(true);
  };

  const harvestAPs = async () => {
    const picked = openAPs.filter((a) => apSelected.has(a.line));
    if (picked.length === 0) return;
    setApBusy(true);
    try {
      const bucket = await api.getBucket();
      const rawGroup = Object.entries(refLinks).find(([, folder]) => currentPath.startsWith(folder))?.[0] || "";
      const group = canonicalGroup(rawGroup, bucket.tasks.map((t) => t.text));
      const newTasks = [...bucket.tasks];
      picked.forEach((a) => {
        newTasks.push({
          text: `${group ? `${group}: ` : ""}${a.text} [[${currentName}]]`,
          priority: "C", focused: false, waiting: false, subtasks: [],
        });
      });
      // Writing the marked content also flushes any unsaved edits
      clearTimeout(saveTimerRef.current);
      const marked = markHarvested(content, picked.map((a) => a.line));
      const res = await api.writeNote(currentPath, marked);
      setContent(marked);
      serverContentRef.current = marked;
      setLastModified(res.modified);
      setHasUnsaved(false);
      await api.saveBucket(newTasks, bucket.pinned_groups);
      window.dispatchEvent(new CustomEvent("bucket-changed"));
      setShowAPs(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to harvest action points");
    }
    setApBusy(false);
  };

  function pathToName(p: string): string {
    return p.replace(/\.md$/, "").split("/").pop() || p;
  }

  // Load file content
  const loadFile = useCallback(async (path: string) => {
    setLoading(true);
    setError("");
    setHasUnsaved(false);
    setConflict(null);
    try {
      const res = await api.readNote(path);
      setContent(res.content);
      serverContentRef.current = res.content;
      setLastModified(res.modified);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load note");
      setContent("");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on path change
  useEffect(() => {
    loadFile(currentPath);
  }, [currentPath, loadFile]);

  // Auto-save with 2s debounce
  const autoSave = useCallback(async (text: string) => {
    if (conflictRef.current) return; // resolve the open conflict first
    setSaving(true);
    try {
      // Conflict check: re-read before writing
      const check = await api.readNote(currentPath);
      if (check.modified !== lastModified && check.content !== serverContentRef.current) {
        if (check.content === text) {
          // Disk already holds exactly what we were about to write — adopt it
          setLastModified(check.modified);
          serverContentRef.current = text;
          setHasUnsaved(false);
          setSaving(false);
          return;
        }
        // Genuine divergence: keep the buffer untouched, offer a choice
        setConflict({ disk: check.content, diskModified: check.modified });
        setSaving(false);
        return;
      }
      const res = await api.writeNote(currentPath, text);
      setLastModified(res.modified);
      serverContentRef.current = text;
      setHasUnsaved(false);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [currentPath, lastModified]);

  // ── Conflict resolution — every path is explicit and loss-free ──
  const resolveKeepMine = async () => {
    try {
      const res = await api.writeNote(currentPath, content);
      setLastModified(res.modified);
      serverContentRef.current = content;
      setHasUnsaved(false);
      setConflict(null);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to save"); }
  };
  const resolveTakeDisk = () => {
    if (!conflict) return;
    setContent(conflict.disk);
    serverContentRef.current = conflict.disk;
    setLastModified(conflict.diskModified);
    setHasUnsaved(false);
    setConflict(null);
    setError("");
  };
  const resolveKeepBoth = async () => {
    if (!conflict) return;
    const merged = `${content.trimEnd()}\n\n---\n\n> Version from disk, kept during conflict:\n\n${conflict.disk.trimEnd()}\n`;
    try {
      const res = await api.writeNote(currentPath, merged);
      setContent(merged);
      serverContentRef.current = merged;
      setLastModified(res.modified);
      setHasUnsaved(false);
      setConflict(null);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to save"); }
  };

  const handleChange = (val: string | undefined) => {
    const text = val ?? "";
    setContent(text);
    setHasUnsaved(text !== serverContentRef.current);
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (text !== serverContentRef.current) {
        autoSave(text);
      }
    }, 2000);
  };

  // Cleanup timer on unmount
  useEffect(() => {
    return () => clearTimeout(saveTimerRef.current);
  }, []);

  // Navigate to a linked note
  const navigateTo = useCallback(async (name: string) => {
    // Save current content first if unsaved
    if (hasUnsaved) {
      clearTimeout(saveTimerRef.current);
      await autoSave(content);
    }
    // Resolve wiki link to path
    try {
      const res = await api.vaultSearch(name, 1);
      if (res.results.length > 0) {
        const target = res.results[0];
        const entry: HistoryEntry = { path: target.path, name: target.name };
        // Trim forward history if we navigated back then branch
        const newHistory = history.slice(0, historyIdx + 1);
        newHistory.push(entry);
        setHistory(newHistory);
        setHistoryIdx(newHistory.length - 1);
        setCurrentPath(target.path);
        setCurrentName(target.name);
      }
    } catch { /* ignore */ }
  }, [hasUnsaved, content, autoSave, history, historyIdx]);

  const canGoBack = historyIdx > 0;
  const canGoForward = historyIdx < history.length - 1;

  const goBack = () => {
    if (!canGoBack) return;
    const idx = historyIdx - 1;
    setHistoryIdx(idx);
    setCurrentPath(history[idx].path);
    setCurrentName(history[idx].name);
  };

  const goForward = () => {
    if (!canGoForward) return;
    const idx = historyIdx + 1;
    setHistoryIdx(idx);
    setCurrentPath(history[idx].path);
    setCurrentName(history[idx].name);
  };

  // Intercept wiki link clicks in preview
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "A" && target.dataset.wikiLink) {
        e.preventDefault();
        e.stopPropagation();
        navigateTo(target.dataset.wikiLink);
      }
    };
    editorRef.current?.addEventListener("click", handler);
    return () => editorRef.current?.removeEventListener("click", handler);
  }, [navigateTo]);

  // Detect [[ in editor textarea for wiki autocomplete
  const handleEditorKeyUp = (e: React.KeyboardEvent) => {
    const textarea = editorRef.current?.querySelector("textarea");
    if (!textarea) return;
    const val = textarea.value;
    const cursor = textarea.selectionStart;
    const before = val.slice(0, cursor);
    const bracketIdx = before.lastIndexOf("[[");
    if (bracketIdx >= 0 && !before.slice(bracketIdx).includes("]]")) {
      const query = before.slice(bracketIdx + 2);
      if (query.length >= 2) {
        // Approximate position from textarea
        const rect = textarea.getBoundingClientRect();
        setWikiQuery(query);
        setWikiPos({ top: rect.top + 24, left: rect.left + 20 });
        setShowWiki(true);
        return;
      }
    }
    setShowWiki(false);
  };

  const handleWikiSelect = (name: string) => {
    const textarea = editorRef.current?.querySelector("textarea");
    if (!textarea) return;
    const val = textarea.value;
    const cursor = textarea.selectionStart;
    const before = val.slice(0, cursor);
    const bracketIdx = before.lastIndexOf("[[");
    if (bracketIdx >= 0) {
      const newVal = val.slice(0, bracketIdx) + `[[${name}]]` + val.slice(cursor);
      handleChange(newVal);
      // Restore cursor position
      const newCursor = bracketIdx + name.length + 4;
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(newCursor, newCursor);
      }, 0);
    }
    setShowWiki(false);
  };

  // Handle bullet continuation, empty-bullet exit, and tab indent
  // Attached via useEffect in capture phase so it fires before MDEditor's own handlers
  const handleEditorKeyDownRef = useRef<(e: KeyboardEvent) => void>(() => {});
  handleEditorKeyDownRef.current = (e: KeyboardEvent) => {
    const textarea = editorRef.current?.querySelector("textarea");
    if (!textarea || document.activeElement !== textarea) return;

    const val = textarea.value;
    const cursor = textarea.selectionStart;
    const selEnd = textarea.selectionEnd;
    const lineStart = val.lastIndexOf("\n", cursor - 1) + 1;
    const line = val.slice(lineStart, val.indexOf("\n", cursor) === -1 ? undefined : val.indexOf("\n", cursor));

    // Tab: indent current line with a tab character (matches Obsidian behavior)
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        // Outdent: remove one leading tab or up to 4 leading spaces
        const match = line.match(/^(\t| {1,4})/);
        if (match) {
          const remove = match[1].length;
          const newVal = val.slice(0, lineStart) + line.slice(remove) + val.slice(lineStart + line.length);
          handleChange(newVal);
          setTimeout(() => {
            textarea.focus();
            textarea.setSelectionRange(Math.max(lineStart, cursor - remove), Math.max(lineStart, selEnd - remove));
          }, 0);
        }
      } else {
        // Indent: add tab at line start
        const newVal = val.slice(0, lineStart) + "\t" + val.slice(lineStart);
        handleChange(newVal);
        setTimeout(() => {
          textarea.focus();
          textarea.setSelectionRange(cursor + 1, selEnd + 1);
        }, 0);
      }
      return;
    }

    // Enter: bullet continuation / exit
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      const bulletMatch = line.match(/^(\s*)([-*+]|\d+\.)\s/);
      if (bulletMatch) {
        const [fullPrefix, indent, marker] = bulletMatch;
        const textAfterBullet = line.slice(fullPrefix.length);

        // Empty bullet line → remove bullet and exit list
        if (textAfterBullet.trim() === "") {
          e.preventDefault();
          const newVal = val.slice(0, lineStart) + "\n" + val.slice(lineStart + line.length);
          handleChange(newVal);
          setTimeout(() => {
            textarea.focus();
            textarea.setSelectionRange(lineStart + 1, lineStart + 1);
          }, 0);
          return;
        }

        // Non-empty bullet → continue with same marker
        e.preventDefault();
        const nextMarker = /^\d+\./.test(marker)
          ? `${parseInt(marker) + 1}.`
          : marker;
        const insert = `\n${indent}${nextMarker} `;
        const newVal = val.slice(0, cursor) + insert + val.slice(selEnd);
        handleChange(newVal);
        const newCursor = cursor + insert.length;
        setTimeout(() => {
          textarea.focus();
          textarea.setSelectionRange(newCursor, newCursor);
        }, 0);
        return;
      }
    }
  };

  // Attach keydown in capture phase on the textarea so it fires before MDEditor
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => handleEditorKeyDownRef.current(e);
    el.addEventListener("keydown", handler, true); // capture phase
    return () => el.removeEventListener("keydown", handler, true);
  }, [loading]); // re-attach after loading completes (textarea mounts)

  // Custom preview: render wiki links in paragraphs and list items
  const previewOptions = {
    components: {
      p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => {
        return <p {...props}>{processWikiLinks(children)}</p>;
      },
      li: ({ children, ...props }: React.HTMLAttributes<HTMLLIElement>) => {
        return <li {...props}>{processWikiLinks(children)}</li>;
      },
    },
  };

  function processWikiLinks(children: React.ReactNode): React.ReactNode {
    if (typeof children === "string") {
      return renderWikiLinksInText(children);
    }
    if (Array.isArray(children)) {
      return children.map((child, i) => {
        if (typeof child === "string") return <React.Fragment key={i}>{renderWikiLinksInText(child)}</React.Fragment>;
        return child;
      });
    }
    return children;
  }

  function renderWikiLinksInText(text: string): React.ReactNode {
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    const re = new RegExp(WIKI_LINK_RE);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index));
      const name = match[1].trim();
      const display = match[2]?.trim() || name;
      parts.push(
        <a
          key={match.index}
          href="#"
          data-wiki-link={name}
          className="inline-flex items-center gap-0.5 px-1.5 py-0 bg-blue-50 text-blue-700 rounded text-xs font-medium hover:bg-blue-100 transition-colors cursor-pointer"
        >
          {display}
        </a>
      );
      lastIdx = re.lastIndex;
    }
    if (lastIdx < text.length) parts.push(text.slice(lastIdx));
    if (parts.length === 0) return text;
    return <>{parts}</>;
  }

  // Breadcrumb from path
  const pathParts = currentPath.replace(/\.md$/, "").split("/");

  return (
    <div
      className={embedded ? "flex justify-center" : "fixed inset-0 z-50 flex items-stretch justify-center bg-black/30"}
      onClick={embedded ? undefined : onClose}
    >
      <div
        className={embedded
          ? "bg-white w-full max-w-4xl rounded-xl shadow border border-gray-200 flex flex-col overflow-hidden h-[calc(100vh-7.5rem)]"
          : "bg-white w-full max-w-4xl m-4 rounded-xl shadow-2xl flex flex-col overflow-hidden"}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50">
          {/* Nav buttons */}
          <button onClick={goBack} disabled={!canGoBack}
            className={`text-sm px-1.5 py-0.5 rounded ${canGoBack ? "text-gray-600 hover:bg-gray-200" : "text-gray-300"}`}
            title="Back">&larr;</button>
          <button onClick={goForward} disabled={!canGoForward}
            className={`text-sm px-1.5 py-0.5 rounded ${canGoForward ? "text-gray-600 hover:bg-gray-200" : "text-gray-300"}`}
            title="Forward">&rarr;</button>

          {/* Breadcrumbs */}
          <div className="flex items-center gap-1 text-xs text-gray-400 flex-1 min-w-0 overflow-hidden">
            {pathParts.map((part, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="text-gray-300">/</span>}
                <span className={i === pathParts.length - 1 ? "text-gray-700 font-medium truncate" : "truncate"}>
                  {part}
                </span>
              </React.Fragment>
            ))}
          </div>

          {/* Status */}
          <div className="flex items-center gap-2 shrink-0">
            {openAPs.length > 0 && (
              <button onClick={() => (showAPs ? setShowAPs(false) : openAPPanel())}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200 transition-colors"
                title="Open action points — harvest them into the bucket">
                <span>⚡</span>
                <span>{openAPs.length} AP{openAPs.length !== 1 ? "s" : ""}</span>
              </button>
            )}
            {narrow && (
              <button onClick={() => setMobilePreview((p) => !p)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                  mobilePreview ? "bg-blue-50 text-blue-700 border-blue-200" : "text-gray-500 border-gray-200"
                }`}
                title={mobilePreview ? "Back to editing" : "Preview the rendered note"}>
                {mobilePreview ? "✎ Edit" : "👁 Preview"}
              </button>
            )}
            {saving && <span className="text-[10px] text-blue-500">Saving...</span>}
            {hasUnsaved && !saving && <span className="text-[10px] text-amber-500">Unsaved</span>}
            {!hasUnsaved && !saving && !loading && <span className="text-[10px] text-green-500">Saved</span>}
            <a href={obsidianUri(currentPath)} className="text-[10px] text-gray-400 hover:text-blue-600" title="Open in Obsidian">
              Obsidian &rarr;
            </a>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
          </div>
        </div>

        {/* Action-point harvest panel */}
        {showAPs && openAPs.length > 0 && (
          <div className="px-4 py-2 border-b border-amber-200 bg-amber-50/60 max-h-52 overflow-y-auto">
            {[...new Set(openAPs.map((a) => a.section))].map((sec) => (
              <div key={sec || "(top)"} className="mb-1">
                {sec && <div className="text-[10px] font-medium text-amber-800/70 mb-0.5">{sec}</div>}
                {openAPs.filter((a) => a.section === sec).map((a) => (
                  <label key={a.line} className="flex items-start gap-1.5 py-0.5 px-1 rounded hover:bg-amber-100/60 cursor-pointer">
                    <input type="checkbox" checked={apSelected.has(a.line)}
                      onChange={() => setApSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(a.line)) next.delete(a.line); else next.add(a.line);
                        return next;
                      })}
                      className="mt-0.5 accent-amber-600" />
                    <span className="text-[11px] text-gray-700 leading-snug">{a.text}</span>
                  </label>
                ))}
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <button onClick={harvestAPs} disabled={apBusy || apSelected.size === 0}
                className="px-2 py-1 rounded text-[11px] font-medium bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 transition-colors">
                {apBusy ? "Adding..." : `→ Add ${apSelected.size} to bucket`}
              </button>
              <span className="text-[9px] text-amber-700/60">harvested lines become AP→ in the note</span>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="px-4 py-1 bg-red-50 text-red-600 text-xs flex items-center gap-2">
            <span>{error}</span>
          </div>
        )}

        {/* External-change conflict: compare and choose, nothing is lost */}
        {conflict && (() => {
          const rows = lineDiff(content, conflict.disk);
          return (
            <div className="px-4 py-2 bg-amber-50 border-y border-amber-200 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold text-amber-800">
                  ⚠ This note changed on disk while you were editing.
                </span>
                <span className="text-[10px] text-amber-700">
                  <span className="px-1 rounded bg-green-100 text-green-800">green = only in your version</span>{" "}
                  <span className="px-1 rounded bg-red-100 text-red-700">red = only on disk</span>
                </span>
              </div>
              {rows ? (
                <div className="max-h-56 overflow-auto rounded border border-amber-200 bg-white font-mono text-[11px] leading-snug">
                  {rows.map((r, i) => (
                    <div key={i} className={`px-2 whitespace-pre-wrap ${
                      r.type === "mine" ? "bg-green-50 text-green-900" :
                      r.type === "disk" ? "bg-red-50 text-red-800 line-through decoration-red-300" : "text-gray-500"
                    }`}>
                      {r.type === "mine" ? "+ " : r.type === "disk" ? "− " : "  "}{r.text || " "}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="max-h-56 overflow-auto rounded border border-amber-200 bg-white p-2 text-[11px] font-mono whitespace-pre-wrap text-gray-600">
                  {conflict.disk}
                </div>
              )}
              <div className="flex items-center gap-2">
                <button onClick={resolveKeepMine}
                  className="px-2.5 py-1 rounded bg-green-600 text-white text-[11px] font-medium hover:bg-green-700">
                  Keep mine
                </button>
                <button onClick={resolveTakeDisk}
                  className="px-2.5 py-1 rounded bg-white border border-amber-300 text-amber-800 text-[11px] font-medium hover:bg-amber-100">
                  Take disk version
                </button>
                <button onClick={resolveKeepBoth}
                  className="px-2.5 py-1 rounded bg-white border border-amber-300 text-amber-800 text-[11px] font-medium hover:bg-amber-100">
                  Keep both
                </button>
                <span className="text-[10px] text-amber-700">Your text stays in the editor until you choose.</span>
              </div>
            </div>
          );
        })()}

        {/* Editor */}
        <div ref={editorRef} className="flex-1 overflow-hidden" onKeyUp={handleEditorKeyUp} data-color-mode="light">
          {loading ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">Loading...</div>
          ) : (
            <MDEditor
              value={content}
              onChange={handleChange}
              height="100%"
              preview={narrow ? (mobilePreview ? "preview" : "edit") : "live"}
              hideToolbar={narrow && mobilePreview}
              previewOptions={previewOptions}
              visibleDragbar={false}
            />
          )}
        </div>

        {/* Wiki autocomplete overlay */}
        {showWiki && (
          <WikiSuggestions query={wikiQuery} position={wikiPos} onSelect={handleWikiSelect} />
        )}
      </div>
    </div>
  );
}

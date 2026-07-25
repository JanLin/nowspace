import React, { useState, useEffect, useRef, useCallback } from "react";
import MDEditor from "@uiw/react-md-editor";
import { api } from "../api";

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
}

export default function NoteEditor({ initialPath, initialName, onClose }: NoteEditorProps) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [lastModified, setLastModified] = useState("");
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [, setCurrentName] = useState(initialName || pathToName(initialPath));

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

  function pathToName(p: string): string {
    return p.replace(/\.md$/, "").split("/").pop() || p;
  }

  // Load file content
  const loadFile = useCallback(async (path: string) => {
    setLoading(true);
    setError("");
    setHasUnsaved(false);
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
    setSaving(true);
    try {
      // Conflict check: re-read modified timestamp
      const check = await api.readNote(currentPath);
      if (check.modified !== lastModified && check.content !== serverContentRef.current) {
        setError("File was modified externally. Reload to see changes.");
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
  const handleEditorKeyUp = (_e: React.KeyboardEvent) => {
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
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/30" onClick={onClose}>
      <div
        className="bg-white w-full max-w-4xl m-4 rounded-xl shadow-2xl flex flex-col overflow-hidden"
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
            {saving && <span className="text-[10px] text-blue-500">Saving...</span>}
            {hasUnsaved && !saving && <span className="text-[10px] text-amber-500">Unsaved</span>}
            {!hasUnsaved && !saving && !loading && <span className="text-[10px] text-green-500">Saved</span>}
            <a href={obsidianUri(currentPath)} className="text-[10px] text-gray-400 hover:text-blue-600" title="Open in Obsidian">
              Obsidian &rarr;
            </a>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-1 bg-red-50 text-red-600 text-xs flex items-center gap-2">
            <span>{error}</span>
            {error.includes("externally") && (
              <button onClick={() => loadFile(currentPath)} className="text-red-700 underline text-[10px]">Reload</button>
            )}
          </div>
        )}

        {/* Editor */}
        <div ref={editorRef} className="flex-1 overflow-hidden" onKeyUp={handleEditorKeyUp} data-color-mode="light">
          {loading ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">Loading...</div>
          ) : (
            <MDEditor
              value={content}
              onChange={handleChange}
              height="100%"
              preview="live"
              hideToolbar={false}
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

import React, { useState, useEffect, useRef, useCallback } from "react";
import MDEditor from "@uiw/react-md-editor";
import { api } from "../api";

const VAULT_NAME = "Home";
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function obsidianUri(path: string): string {
  return `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`;
}

/* ── Wiki link chip rendering ─────────────────────────────── */

function renderNoteContent(text: string, onOpenNote?: (name: string) => void) {
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  const re = new RegExp(WIKI_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push(<span key={`t-${match.index}`}>{text.slice(lastIdx, match.index)}</span>);
    const name = match[1].trim();
    const display = match[2]?.trim() || name;
    parts.push(
      <a
        key={`wl-${match.index}`}
        href="#"
        onClick={(e) => {
          e.preventDefault();
          if (onOpenNote) {
            onOpenNote(name);
          } else {
            api.vaultSearch(name, 1).then((res) => {
              if (res.results.length > 0) {
                window.open(obsidianUri(res.results[0].path), "_blank");
              }
            });
          }
        }}
        className="inline-flex items-center gap-0.5 px-1.5 py-0 bg-blue-50 text-blue-700 rounded text-[11px] font-medium hover:bg-blue-100 transition-colors"
        title={onOpenNote ? `Open ${name}` : `Open ${name} in Obsidian`}
      >
        {display}
      </a>
    );
    lastIdx = re.lastIndex;
  }
  if (lastIdx < text.length) parts.push(<span key="end">{text.slice(lastIdx)}</span>);
  if (parts.length === 0) return <>{text}</>;
  return <>{parts}</>;
}

/* ── Wiki link click handler (for MDEditor.Markdown output) ── */

function WikiLinkHandler({ onOpenNote }: { onOpenNote?: (path: string, name: string) => void }) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest("a.wiki-link") as HTMLAnchorElement | null;
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const href = link.getAttribute("href") || "";
      const name = decodeURIComponent(href.replace("#wiki:", ""));
      if (!name) return;
      api.vaultSearch(name, 1).then((res) => {
        if (res.results.length > 0) {
          if (onOpenNote) onOpenNote(res.results[0].path, res.results[0].name);
          else window.open(obsidianUri(res.results[0].path), "_blank");
        }
      });
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [onOpenNote]);
  return null;
}

/* ── Relative time helper ─────────────────────────────────── */

function relativeTime(isoDate: string): string {
  if (!isoDate) return "";
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/* ── Scratchpad ───────────────────────────────────────────── */

interface ScratchpadProps {
  dayName: string;
  weekOffset: number;
  isArchive?: boolean;
  onOpenNote?: (path: string, name: string) => void;
  insertRef: React.MutableRefObject<((text: string) => void) | null>;
}

function Scratchpad({ dayName, weekOffset, isArchive, onOpenNote, insertRef }: ScratchpadProps) {
  const [content, setContent] = useState("");
  const [lastSaved, setLastSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const cursorPosRef = useRef<number>(0);

  const fetchNotes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getNotes(dayName, weekOffset);
      const c = res.content || "";
      setContent(c);
      setLastSaved(c);
    } catch {
      setContent("");
      setLastSaved("");
    } finally {
      setLoading(false);
    }
  }, [dayName, weekOffset]);

  useEffect(() => { fetchNotes(); }, [fetchNotes]);

  // Auto-save with debounce
  const save = useCallback(async (text: string) => {
    if (text === lastSaved) return;
    setSaving(true);
    try {
      await api.putNotes(dayName, text, weekOffset);
      setLastSaved(text);
    } catch { /* silent */ }
    finally { setSaving(false); }
  }, [dayName, weekOffset, lastSaved]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setContent(val);
    cursorPosRef.current = e.target.selectionStart;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => save(val), 1500);
  };

  const handleBlur = () => {
    setFocused(false);
    clearTimeout(debounceRef.current);
    save(content);
  };

  // Expose insertAtCursor
  insertRef.current = (text: string) => {
    const ta = textareaRef.current;
    if (ta && focused) {
      const pos = ta.selectionStart;
      const before = content.slice(0, pos);
      const after = content.slice(pos);
      const sep = before.length > 0 && !before.endsWith("\n") && !before.endsWith(" ") ? " " : "";
      const newContent = before + sep + text + after;
      setContent(newContent);
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => save(newContent), 1500);
      // Restore cursor after text
      requestAnimationFrame(() => {
        const newPos = pos + sep.length + text.length;
        ta.selectionStart = ta.selectionEnd = newPos;
        ta.focus();
      });
    } else {
      // Append on new line
      const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      const newContent = content + sep + text;
      setContent(newContent);
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => save(newContent), 1500);
    }
  };

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta && focused) {
      ta.style.height = "auto";
      ta.style.height = Math.max(80, ta.scrollHeight) + "px";
    }
  }, [content, focused]);

  if (loading) return <div className="text-[10px] text-gray-400 text-center py-4">Loading notes...</div>;

  return (
    <div className="relative">
      {/* Save indicator */}
      {saving && <span className="absolute top-0 right-0 text-[9px] text-gray-400">Saving...</span>}
      {!saving && content !== lastSaved && <span className="absolute top-0 right-0 text-[9px] text-orange-400">Unsaved</span>}

      {focused || isArchive ? (
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
          readOnly={isArchive}
          placeholder="Add notes..."
          className="w-full text-xs font-mono px-2 py-2 border border-gray-200 rounded-lg bg-white outline-none focus:ring-1 focus:ring-blue-400 placeholder:text-gray-300 resize-none min-h-[45vh]"
          style={{ height: "auto" }}
        />
      ) : (
        <div
          onClick={(e) => {
            // Don't enter edit mode when clicking a wiki link
            if ((e.target as HTMLElement).closest("a.wiki-link")) return;
            setFocused(true);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
          className="w-full text-xs px-2 py-2 border border-gray-200 rounded-lg bg-white cursor-text min-h-[45vh] hover:border-blue-300 transition-colors scratchpad-preview"
          data-color-mode="light"
        >
          {content ? (
            <>
              <MDEditor.Markdown
                source={content
                  .replace(WIKI_LINK_RE, (_match, name: string, display?: string) =>
                    `<a class="wiki-link" href="#wiki:${encodeURIComponent(name.trim())}">${(display || name).trim()}</a>`
                  )
                  // Single newlines are markdown hard breaks — typed lines stay lines
                  .replace(/([^\n])\n(?!\n)/g, "$1  \n")
                  // Preserve blank lines as visible gaps in preview
                  .replace(/\n\n/g, "\n\n&#8203;\n\n")
                }
                style={{ fontSize: 12, background: "transparent" }}
              />
              {/* Handle wiki link clicks */}
              <WikiLinkHandler onOpenNote={onOpenNote} />
            </>
          ) : (
            <span className="text-gray-300">Add notes...</span>
          )}
          {/* Hidden textarea for focus management */}
          <textarea ref={textareaRef} value={content} onChange={handleChange}
            className="absolute opacity-0 pointer-events-none w-0 h-0" tabIndex={-1} />
        </div>
      )}
    </div>
  );
}

/* ── Reference Folder ─────────────────────────────────────── */

interface VaultFile {
  name: string;
  path: string;
  type: string;
  modified: string;
}

interface ReferenceFolderProps {
  label: string;
  folderPath: string;
  onInsertLink: (name: string) => void;
  onOpenNote?: (path: string, name: string) => void;
}

function ReferenceFolder({ label, folderPath, onInsertLink, onOpenNote }: ReferenceFolderProps) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [breadcrumbs, setBreadcrumbs] = useState<{ name: string; path: string }[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const currentPath = breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].path : folderPath;

  const loadFolder = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const res = await api.vaultFolder(path);
      setFiles(res.files);
    } catch { setFiles([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (expanded) loadFolder(currentPath);
  }, [expanded, currentPath, loadFolder]);

  const handleExpand = () => {
    setExpanded(!expanded);
    setShowAll(false);
    setBreadcrumbs([]);
  };

  const navigateInto = (folder: VaultFile) => {
    setBreadcrumbs([...breadcrumbs, { name: folder.name, path: folder.path }]);
    setShowAll(false);
  };

  const navigateBack = (index: number) => {
    if (index < 0) {
      setBreadcrumbs([]);
    } else {
      setBreadcrumbs(breadcrumbs.slice(0, index + 1));
    }
    setShowAll(false);
  };

  const handleCreate = async () => {
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      const res = await api.createNote(currentPath, newName.trim());
      onInsertLink(newName.trim());
      setShowCreate(false);
      setNewName("");
      loadFolder(currentPath);
    } catch { /* silent */ }
    finally { setCreating(false); }
  };

  const handleFileClick = (file: VaultFile) => {
    if (file.type === "folder") {
      navigateInto(file);
    } else {
      onInsertLink(file.name);
    }
  };

  // Sort files: folders first, then files by modified desc
  const sortedFiles = [...files].sort((a, b) => {
    if (a.type === "folder" && b.type !== "folder") return -1;
    if (a.type !== "folder" && b.type === "folder") return 1;
    if (a.type !== "folder" && b.type !== "folder" && a.modified && b.modified) {
      return new Date(b.modified).getTime() - new Date(a.modified).getTime();
    }
    return a.name.localeCompare(b.name);
  });

  const folders = sortedFiles.filter(f => f.type === "folder");
  const fileItems = sortedFiles.filter(f => f.type !== "folder");
  const recentFiles = showAll ? fileItems : fileItems.slice(0, 5);

  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <button onClick={handleExpand}
        className="w-full flex items-center gap-1.5 px-1 py-1.5 text-xs text-gray-700 hover:bg-gray-50 rounded transition-colors">
        <span className="text-[10px] text-gray-400">{expanded ? "v" : ">"}</span>
        <span className="text-[10px]">{expanded ? "📂" : "📁"}</span>
        <span className="font-medium capitalize flex-1 text-left">{label}</span>
        {!expanded && files.length > 0 && <span className="text-[10px] text-gray-400">{files.length}</span>}
      </button>

      {expanded && (
        <div className="pl-3 pb-2">
          {/* Breadcrumbs */}
          {breadcrumbs.length > 0 && (
            <div className="flex items-center gap-1 text-[10px] text-gray-400 mb-1 flex-wrap">
              <button onClick={() => navigateBack(-1)} className="hover:text-blue-500">{label}</button>
              {breadcrumbs.map((bc, i) => (
                <React.Fragment key={i}>
                  <span>/</span>
                  <button onClick={() => navigateBack(i)} className="hover:text-blue-500 truncate max-w-[80px]">{bc.name}</button>
                </React.Fragment>
              ))}
            </div>
          )}

          {loading && <div className="text-[10px] text-gray-400 py-1">Loading...</div>}

          {!loading && (
            <>
              {/* Create new note */}
              {!showCreate ? (
                <button onClick={() => {
                    setShowCreate(true);
                    if (!newName) setNewName(`${new Date().toISOString().slice(0, 10)} `);
                  }}
                  className="text-[10px] text-blue-500 hover:text-blue-700 mb-1 block"
                  title="Create a note here and link it into today's notes">
                  + New note (links into today)
                </button>
              ) : (
                <div className="flex gap-1 mb-1">
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") { setShowCreate(false); setNewName(""); } }}
                    placeholder="Note name..."
                    autoFocus
                    className="flex-1 text-[11px] px-1.5 py-0.5 border border-gray-200 rounded outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <button onClick={handleCreate} disabled={!newName.trim() || creating}
                    className="text-[10px] px-1.5 py-0.5 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50">
                    {creating ? "..." : "Create"}
                  </button>
                </div>
              )}

              {/* Subfolders */}
              {folders.map((f) => (
                <button key={f.path} onClick={() => navigateInto(f)}
                  className="w-full text-left flex items-center gap-1.5 px-1 py-0.5 text-[11px] rounded hover:bg-blue-50 hover:text-blue-700 text-gray-600 truncate">
                  <span className="text-[10px]">📂</span>
                  <span className="truncate flex-1">{f.name}</span>
                </button>
              ))}

              {/* Files */}
              {recentFiles.map((f) => {
                const touchedToday = f.modified && new Date(f.modified).toDateString() === new Date().toDateString();
                return (
                <div key={f.path} className="flex items-center gap-1 group/file">
                  <button onClick={() => handleFileClick(f)}
                    className={`flex-1 text-left flex items-center gap-1.5 px-1 py-0.5 text-[11px] rounded hover:bg-blue-50 hover:text-blue-700 truncate min-w-0 ${touchedToday ? "text-blue-700 bg-blue-50/60" : "text-gray-600"}`}
                    title={`Insert [[${f.name}]] into today's notes${touchedToday ? " — touched today" : ""}`}>
                    <span className="text-[10px]">📄</span>
                    <span className="truncate flex-1">{f.name}</span>
                    {touchedToday && <span className="text-[8px] font-semibold text-blue-500 shrink-0">today</span>}
                    <span className="text-[9px] text-gray-400 shrink-0">{relativeTime(f.modified)}</span>
                  </button>
                  {onOpenNote && (
                    <button onClick={() => onOpenNote(f.path, f.name)}
                      className="text-[9px] text-gray-300 hover:text-blue-500 shrink-0 opacity-0 group-hover/file:opacity-100"
                      title="Open in editor">
                      Open
                    </button>
                  )}
                </div>
                );
              })}

              {/* Show all toggle */}
              {!showAll && fileItems.length > 5 && (
                <button onClick={() => setShowAll(true)}
                  className="text-[10px] text-blue-500 hover:text-blue-700 mt-0.5">
                  Show all ({fileItems.length} files)...
                </button>
              )}
              {showAll && fileItems.length > 5 && (
                <button onClick={() => setShowAll(false)}
                  className="text-[10px] text-gray-400 hover:text-gray-600 mt-0.5">
                  Show less
                </button>
              )}

              {!loading && files.length === 0 && (
                <div className="text-[10px] text-gray-400 py-1">Empty folder</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Reference Browser ────────────────────────────────────── */

interface ReferenceBrowserProps {
  onInsertLink: (name: string) => void;
  onOpenNote?: (path: string, name: string) => void;
}

function ReferenceBrowser({ onInsertLink, onOpenNote }: ReferenceBrowserProps) {
  const [links, setLinks] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    api.referenceLinks().then((res) => setLinks(res.links))
      .catch(() => setLinks({}))
      .finally(() => setLoading(false));
  }, []);

  const entries = Object.entries(links);

  if (loading) return null;
  if (entries.length === 0) return null;

  return (
    <div className="mt-3 border-t border-gray-200 pt-2">
      <button onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[10px] font-semibold text-gray-500 uppercase tracking-wide hover:text-gray-700 mb-1">
        {expanded ? "v" : ">"} Reference Files
      </button>
      {expanded && (
        <div>
          {entries.map(([name, path]) => (
            <ReferenceFolder
              key={name}
              label={name}
              folderPath={path}
              onInsertLink={onInsertLink}
              onOpenNote={onOpenNote}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main NotesPanel ──────────────────────────────────────── */

interface NotesPanelProps {
  dayName: string;
  weekOffset: number;
  isArchive?: boolean;
  onOpenNote?: (path: string, name: string) => void;
}

export default function NotesPanel({ dayName, weekOffset, isArchive, onOpenNote }: NotesPanelProps) {
  const insertRef = useRef<((text: string) => void) | null>(null);
  const dayLabel = dayName.charAt(0).toUpperCase() + dayName.slice(1);

  const handleInsertLink = (name: string) => {
    insertRef.current?.(`[[${name}]]`);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-700">Notes — {dayLabel}</h3>
      </div>

      {/* Scratchpad */}
      <Scratchpad
        dayName={dayName}
        weekOffset={weekOffset}
        isArchive={isArchive}
        onOpenNote={onOpenNote}
        insertRef={insertRef}
      />

      {/* Reference File Browser */}
      {!isArchive && (
        <ReferenceBrowser
          onInsertLink={handleInsertLink}
          onOpenNote={onOpenNote}
        />
      )}
    </div>
  );
}

/* ── Export helper: check if a group has notes for a day ──── */

export function useGroupNotesIndicator(dayName: string, weekOffset: number) {
  const [groupsWithNotes, setGroupsWithNotes] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.getNotes(dayName, weekOffset).then((res) => {
      if (res.groups) {
        setGroupsWithNotes(new Set(Object.keys(res.groups)));
      }
    }).catch(() => {});
  }, [dayName, weekOffset]);

  return groupsWithNotes;
}

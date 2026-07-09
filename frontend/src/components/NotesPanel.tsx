import React, { useState, useEffect, useRef, useCallback } from "react";
import MDEditor from "@uiw/react-md-editor";
import { api } from "../api";
import { findOpenAPs, markHarvested, type FoundAP } from "../actionPoints";

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
      window.dispatchEvent(new CustomEvent("notes-saved"));
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
  const [createMode, setCreateMode] = useState<"note" | "call">("note");
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
      // Call notes live in the group's coms subfolder (created if missing);
      // reuse an existing coms/comms folder's casing when present.
      let target = currentPath;
      if (createMode === "call") {
        const existing = files.find((f) => f.type === "folder" && /^comm?s$/i.test(f.name));
        target = existing ? existing.path : `${currentPath}/coms`;
      }
      const res = await api.createNote(target, newName.trim());
      onInsertLink(newName.trim());
      setShowCreate(false);
      setNewName("");
      loadFolder(currentPath);
      // Jump straight into the editor to type the minutes
      if (createMode === "call" && onOpenNote) onOpenNote(res.path, newName.trim());
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
                <div className="flex items-center gap-2 mb-1">
                  <button onClick={() => {
                      setCreateMode("note");
                      setShowCreate(true);
                      if (!newName) setNewName(`${new Date().toISOString().slice(0, 10)} `);
                    }}
                    className="text-[10px] text-blue-500 hover:text-blue-700"
                    title="Create a note here and link it into today's notes">
                    + New note
                  </button>
                  <button onClick={() => {
                      setCreateMode("call");
                      setShowCreate(true);
                      if (!newName) setNewName(`${new Date().toISOString().slice(0, 10)} call `);
                    }}
                    className="text-[10px] text-green-600 hover:text-green-800"
                    title="Create call minutes in this group's coms folder, link into today's notes, and open the editor">
                    📞 Call note
                  </button>
                </div>
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

/* ── Action-point harvest (quiet hint) ────────────────────── */

interface APFile { name: string; path: string; content: string; aps: FoundAP[]; group: string }

function APHarvest({ dayName, weekOffset }: { dayName: string; weekOffset: number }) {
  const [files, setFiles] = useState<APFile[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const scan = useCallback(async () => {
    try {
      const notes = await api.getNotes(dayName, weekOffset);
      const linkNames = [...new Set(
        [...(notes.content || "").matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim())
      )];
      if (linkNames.length === 0) { setFiles([]); return; }
      const refLinks = await api.referenceLinks().then((r) => r.links).catch(() => ({} as Record<string, string>));
      const found: APFile[] = [];
      for (const name of linkNames) {
        try {
          const res = await api.vaultSearch(name, 1);
          if (res.results.length === 0) continue;
          const { path } = res.results[0];
          const note = await api.readNote(path);
          const aps = findOpenAPs(note.content);
          if (aps.length === 0) continue;
          // Infer the customer group from which reference folder holds the file
          const group = Object.entries(refLinks).find(([, folder]) => path.startsWith(folder))?.[0] || "";
          found.push({ name, path, content: note.content, aps, group });
        } catch { /* skip unreadable */ }
      }
      setFiles(found);
      setSelected(new Set(found.flatMap((f) => f.aps.map((a) => `${f.path}|${a.line}`))));
    } catch { setFiles([]); }
  }, [dayName, weekOffset]);

  useEffect(() => {
    scan();
    window.addEventListener("notes-saved", scan);
    window.addEventListener("focus", scan);
    return () => {
      window.removeEventListener("notes-saved", scan);
      window.removeEventListener("focus", scan);
    };
  }, [scan]);

  const total = files.reduce((n, f) => n + f.aps.length, 0);
  if (total === 0) return null;

  const toggle = (key: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const harvest = async () => {
    setBusy(true);
    try {
      const bucket = await api.getBucket();
      const newTasks = [...bucket.tasks];
      for (const f of files) {
        const lines = f.aps.filter((a) => selected.has(`${f.path}|${a.line}`)).map((a) => a.line);
        if (lines.length === 0) continue;
        f.aps.filter((a) => lines.includes(a.line)).forEach((a) => {
          newTasks.push({
            text: `${f.group ? `${f.group}: ` : ""}${a.text} [[${f.name}]]`,
            priority: "C", focused: false, waiting: false, subtasks: [],
          });
        });
        await api.writeNote(f.path, markHarvested(f.content, lines));
      }
      await api.saveBucket(newTasks, bucket.pinned_groups);
      window.dispatchEvent(new CustomEvent("bucket-changed"));
      setOpen(false);
      scan();
    } catch { /* leave hint for retry */ }
    setBusy(false);
  };

  return (
    <div className="mt-2">
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors border border-amber-200">
        <span>⚡</span>
        <span className="flex-1 text-left">{total} action point{total !== 1 ? "s" : ""} in linked notes</span>
        <span className="text-[9px]">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1 border border-amber-200 rounded-lg p-2 space-y-1.5 bg-white">
          {files.map((f) => (
            <div key={f.path}>
              <div className="text-[10px] font-medium text-gray-500 mb-0.5">
                📄 {f.name}{f.group && <span className="ml-1 text-gray-400">→ {f.group}</span>}
              </div>
              {f.aps.map((a) => {
                const key = `${f.path}|${a.line}`;
                return (
                  <label key={key} className="flex items-start gap-1.5 text-[11px] py-0.5 cursor-pointer text-gray-700">
                    <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} className="mt-0.5" />
                    <span className="flex-1">{a.text}</span>
                  </label>
                );
              })}
            </div>
          ))}
          <button onClick={harvest} disabled={busy || selected.size === 0}
            className="w-full px-2 py-1 bg-amber-500 text-white rounded text-[10px] font-medium hover:bg-amber-600 disabled:opacity-50">
            {busy ? "Creating…" : `🪣 ${selected.size} to Bucket (marks AP→ in the notes)`}
          </button>
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

      {/* Action points found in today's linked call notes */}
      {!isArchive && <APHarvest dayName={dayName} weekOffset={weekOffset} />}

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

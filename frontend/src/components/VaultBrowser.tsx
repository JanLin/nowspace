import React, { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api";

// ─── Types ──────────────────────────────────────────────────────────

interface VaultFile {
  name: string;
  path: string;
  type: "file" | "folder";
  modified: string;
}

interface RecentNote {
  path: string;
  name: string;
  timestamp: number;
}

export interface VaultBrowserState {
  expandedFolders: Set<string>;
  previewPath: string | null;
  previewName: string | null;
  scrollTop: number;
  currentFolder: string;
}

interface Props {
  onClose: () => void;
  stateRef: React.MutableRefObject<VaultBrowserState | null>;
  onOpenNote: (path: string, name: string) => void;
  /** Insert a [[link]] to a note into whatever is being written (day view) */
  onInsertLink?: (name: string) => void;
  /** Harvest action points out of a note — day view only, it owns the strip */
  onScanAPs?: (path: string, name: string) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────

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

const RECENTS_KEY = "vault-browser-recents";
const MAX_RECENTS = 8;

function loadRecents(): RecentNote[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
  } catch { return []; }
}

function saveRecents(recents: RecentNote[]) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, MAX_RECENTS)));
}

function addToRecents(path: string, name: string) {
  const recents = loadRecents().filter(r => r.path !== path);
  recents.unshift({ path, name, timestamp: Date.now() });
  saveRecents(recents);
}

// ─── Main Component ─────────────────────────────────────────────────

export default function VaultBrowser({ onClose, stateRef, onOpenNote, onInsertLink, onScanAPs }: Props) {
  // Restore state from ref or use defaults
  const saved = stateRef.current;

  // Track last opened note for state persistence
  const [lastOpenedPath] = useState<string | null>(saved?.previewPath || null);
  const [lastOpenedName] = useState<string | null>(saved?.previewName || null);
  const [currentFolder, setCurrentFolder] = useState(saved?.currentFolder || "");
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(saved?.expandedFolders || new Set());
  const [folderCache, setFolderCache] = useState<Map<string, VaultFile[]>>(new Map());
  const [loading, setLoading] = useState(false);

  const [pinnedNotes, setPinnedNotes] = useState<string[]>([]);
  const [recents, setRecents] = useState<RecentNote[]>(loadRecents());
  const [referenceLinks, setReferenceLinks] = useState<Record<string, string>>({});

  // Drag state
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Delete confirmation
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Save state on unmount
  useEffect(() => {
    return () => {
      stateRef.current = {
        expandedFolders,
        previewPath: lastOpenedPath,
        previewName: lastOpenedName,
        scrollTop: scrollRef.current?.scrollTop || 0,
        currentFolder,
      };
    };
  });

  // Load pinned notes and reference links on mount
  useEffect(() => {
    api.getPinnedNotes().then(r => setPinnedNotes(r.pinned)).catch(() => {});
    api.referenceLinks().then(r => setReferenceLinks(r.links)).catch(() => {});
  }, []);

  // Load root folder
  useEffect(() => {
    loadFolder(currentFolder);
  }, [currentFolder]);

  // Restore scroll position
  useEffect(() => {
    if (saved?.scrollTop && scrollRef.current) {
      scrollRef.current.scrollTop = saved.scrollTop;
    }
  }, []);

  const loadFolder = useCallback(async (path: string) => {
    if (folderCache.has(path)) {
      setFiles(folderCache.get(path)!);
      return;
    }
    setLoading(true);
    try {
      const res = await api.vaultFolder(path || "");
      setFiles(res.files);
      setFolderCache(prev => new Map(prev).set(path, res.files));
    } catch {
      setFiles([]);
    }
    setLoading(false);
  }, [folderCache]);

  // Breadcrumb is derived from the current path — every segment is a jump target
  const crumbs = currentFolder
    ? currentFolder.split("/").map((seg, i, arr) => ({ name: seg, path: arr.slice(0, i + 1).join("/") }))
    : [];

  // ─── Search ─────────────────────────────────────────────────────
  // Filename search, straight off the index the [[link]] autocomplete uses.
  // It does not read file contents — a phrase inside a note won't match.

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<VaultFile[]>([]);
  const [searching, setSearching] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout>>();

  const runSearch = (q: string) => {
    setQuery(q);
    clearTimeout(searchDebounce.current);
    if (q.trim().length < 2) { setHits([]); setSearching(false); return; }
    setSearching(true);
    searchDebounce.current = setTimeout(async () => {
      try {
        const res = await api.vaultSearch(q.trim(), 25);
        setHits(res.results.map((r) => ({ name: r.name, path: r.path, type: "file" as const, modified: "" })));
      } catch { setHits([]); }
      finally { setSearching(false); }
    }, 220);
  };

  // ─── Creating ───────────────────────────────────────────────────
  // Both land in whatever folder is open, so anywhere in the vault is
  // reachable — the old reference-folder scoping is what made a call note
  // impossible to file outside a configured folder.

  const [creating, setCreating] = useState<null | "note" | "call" | "folder">(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState("");

  const CALL_TEMPLATE = (name: string) =>
    `# ${name}\n\n**When:** \n**With:** \n\n## Notes\n\n\n## Action points\n\n- [ ] \n`;

  const invalidateFolder = (path: string) => {
    setFolderCache((prev) => { const next = new Map(prev); next.delete(path); return next; });
  };

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name || busy || !creating) return;
    setBusy(true);
    setCreateError("");
    try {
      if (creating === "folder") {
        const target = currentFolder ? `${currentFolder}/${name}` : name;
        await api.vaultCreateFolder(target);
        invalidateFolder(currentFolder);
        await loadFolderFresh(currentFolder);
      } else {
        const res = await api.createNote(currentFolder, name, creating === "call" ? CALL_TEMPLATE(name) : "");
        invalidateFolder(currentFolder);
        await loadFolderFresh(currentFolder);
        openNote(res.path, name);
      }
      setCreating(null);
      setNewName("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCreateError(/already exists/i.test(msg) ? "That name is taken in this folder" : "Could not create that");
    } finally { setBusy(false); }
  };

  const loadFolderFresh = async (path: string) => {
    try {
      const res = await api.vaultFolder(path || "");
      setFiles(res.files);
      setFolderCache((prev) => new Map(prev).set(path, res.files));
    } catch { /* leave the stale list rather than blanking it */ }
  };

  // ─── Preview ────────────────────────────────────────────────────

  const openNote = (path: string, name: string) => {
    addToRecents(path, name);
    setRecents(loadRecents());
    onOpenNote(path, name);
  };

  // ─── Pinning ────────────────────────────────────────────────────

  const isPinned = (path: string) => pinnedNotes.includes(path);

  const togglePin = async (path: string) => {
    const next = isPinned(path)
      ? pinnedNotes.filter(p => p !== path)
      : [...pinnedNotes, path].slice(0, 10);
    setPinnedNotes(next);
    await api.savePinnedNotes(next).catch(() => {});
  };

  // ─── Drag and Drop ──────────────────────────────────────────────

  const handleDragStart = (e: React.DragEvent, path: string) => {
    e.dataTransfer.setData("vault-path", path);
    // Also set note name (filename without extension) for linking
    const name = path.split("/").pop()?.replace(/\.md$/, "") || path;
    e.dataTransfer.setData("vault-note-name", name);
    e.dataTransfer.effectAllowed = "move";
    setDragPath(path);
  };

  const handleDragOver = (e: React.DragEvent, folderPath: string) => {
    if (!e.dataTransfer.types.includes("vault-path")) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(folderPath);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.stopPropagation();
    setDropTarget(null);
  };

  // Force-fetch a folder, updating both caches and (if it's the folder on
  // screen) the visible listing. loadFolder() consults the cache through a
  // stale closure, so after a mutation it must not be trusted to refetch.
  const reloadFolder = async (path: string) => {
    try {
      const res = await api.vaultFolder(path || "");
      setFolderCache(prev => new Map(prev).set(path, res.files));
      setSubFiles(prev => (prev.has(path) ? new Map(prev).set(path, res.files) : prev));
      if (path === currentFolder) setFiles(res.files);
    } catch { /* keep old listing */ }
  };

  const handleDrop = async (e: React.DragEvent, targetFolder: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    setDragPath(null);

    const sourcePath = e.dataTransfer.getData("vault-path");
    if (!sourcePath || sourcePath === targetFolder) return;
    // Don't drop into self
    if (targetFolder.startsWith(sourcePath + "/")) return;

    try {
      await api.vaultMove(sourcePath, targetFolder);
      // Refresh every listing the move touched: source's parent, the
      // target, and whatever is on screen (incl. expanded subtrees).
      const sourceParent = sourcePath.includes("/") ? sourcePath.substring(0, sourcePath.lastIndexOf("/")) : "";
      await Promise.all([...new Set([sourceParent, targetFolder, currentFolder])].map(reloadFolder));
    } catch (err) {
      console.error("Move failed:", err);
    }
  };

  // ─── Delete ─────────────────────────────────────────────────────

  const deleteFile = async (path: string) => {
    try {
      await api.vaultDelete(path);
      setConfirmDelete(null);
      // Remove from pinned if it was pinned
      if (isPinned(path)) togglePin(path);
      const parent = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
      await Promise.all([...new Set([parent, currentFolder])].map(reloadFolder));
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  // ─── Reference links ───────────────────────────────────────────

  const [refNameInput, setRefNameInput] = useState<{ folderPath: string; name: string } | null>(null);

  const isReference = (folderPath: string): string | null => {
    for (const [name, refPath] of Object.entries(referenceLinks)) {
      if (refPath === folderPath) return name;
    }
    return null;
  };

  const addReference = async (folderPath: string, name: string) => {
    if (!name.trim()) return;
    try {
      const res = await api.addReferenceLink(name.trim(), folderPath);
      setReferenceLinks(res.reference_links);
      setRefNameInput(null);
      window.dispatchEvent(new CustomEvent("reference-links-changed"));
    } catch (err) {
      console.error("Failed to add reference:", err);
    }
  };

  const removeReference = async (name: string) => {
    try {
      const res = await api.deleteReferenceLink(name);
      setReferenceLinks(res.reference_links);
      window.dispatchEvent(new CustomEvent("reference-links-changed"));
    } catch (err) {
      console.error("Failed to remove reference:", err);
    }
  };

  const handleStarClick = (folderPath: string) => {
    const existingRef = isReference(folderPath);
    if (existingRef) {
      removeReference(existingRef);
    } else {
      // Pre-fill with folder name
      const folderName = folderPath.split("/").pop() || "";
      // Strip common prefixes like "c " from folder names
      const cleanName = folderName.replace(/^[a-z]\s+/i, "");
      setRefNameInput({ folderPath, name: cleanName });
    }
  };

  // ─── Expand/collapse for tree view ─────────────────────────────

  const [subFiles, setSubFiles] = useState<Map<string, VaultFile[]>>(new Map());

  const toggleExpand = async (folderPath: string) => {
    const next = new Set(expandedFolders);
    if (next.has(folderPath)) {
      next.delete(folderPath);
    } else {
      next.add(folderPath);
      if (!subFiles.has(folderPath)) {
        try {
          const res = await api.vaultFolder(folderPath);
          setSubFiles(prev => new Map(prev).set(folderPath, res.files));
        } catch {
          setSubFiles(prev => new Map(prev).set(folderPath, []));
        }
      }
    }
    setExpandedFolders(next);
  };

  // ─── Render: Browser View ──────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b flex items-center justify-between" style={{ borderColor: "var(--border-strong)" }}>
        <h3 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
          {"\uD83D\uDCC1"} Vault
        </h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">&times;</button>
      </div>

      {/* Search + create. Both act on the folder that's open, so a note or a
          missing folder can be made anywhere — not only inside a reference. */}
      <div className="px-3 pt-2 pb-1.5 border-b space-y-1.5" style={{ borderColor: "var(--border)" }}>
        <input
          value={query}
          onChange={(e) => runSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") runSearch(""); }}
          placeholder="Search notes by name…"
          autoComplete="off"
          className="w-full text-xs px-2 py-1 rounded outline-none focus:ring-1 focus:ring-blue-400"
          style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}
        />
        {creating ? (
          <div className="space-y-1">
            <div className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
              New {creating === "folder" ? "folder" : creating === "call" ? "call note" : "note"} in{" "}
              <span className="font-mono">{currentFolder || "vault root"}</span>
            </div>
            <div className="flex gap-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCreate();
                  if (e.key === "Escape") { setCreating(null); setNewName(""); setCreateError(""); }
                }}
                placeholder={creating === "folder" ? "Folder name…" : "Note name…"}
                className="flex-1 min-w-0 text-xs px-2 py-1 rounded outline-none focus:ring-1 focus:ring-blue-400"
                style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}
              />
              <button onClick={submitCreate} disabled={!newName.trim() || busy}
                className="px-2 py-1 rounded text-xs font-medium text-white disabled:opacity-50 shrink-0"
                style={{ backgroundColor: "var(--accent)" }}>
                {busy ? "…" : "Create"}
              </button>
              <button onClick={() => { setCreating(null); setNewName(""); setCreateError(""); }}
                className="px-1 text-xs shrink-0" style={{ color: "var(--text-tertiary)" }}>
                ✕
              </button>
            </div>
            {createError && <div className="text-[10px] text-red-500">{createError}</div>}
          </div>
        ) : (
          <div className="flex gap-1 flex-wrap">
            {([["note", "+ Note"], ["call", "+ Call note"], ["folder", "+ Folder"]] as const).map(([mode, label]) => (
              <button key={mode} onClick={() => { setCreating(mode); setCreateError(""); }}
                className="text-[10px] px-1.5 py-0.5 rounded transition-colors"
                style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
                title={`Create in ${currentFolder || "the vault root"}`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {query.trim().length >= 2 ? (
        /* Search results replace the tree until the box is cleared */
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <div className="flex items-center justify-between mb-1">
            <h4 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
              {searching ? "Searching…" : `${hits.length} match${hits.length === 1 ? "" : "es"}`}
            </h4>
            <button onClick={() => runSearch("")} className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>Clear</button>
          </div>
          {!searching && hits.length === 0 && (
            <p className="text-[10px] py-2" style={{ color: "var(--text-tertiary)" }}>
              Nothing by that name. Search matches note names, not what's written inside them.
            </p>
          )}
          {hits.map((h) => {
            const folder = h.path.split("/").slice(0, -1).join("/");
            return (
            <div key={h.path} className="group/hit flex items-center gap-1">
              <div className="flex-1 min-w-0">
                <button onClick={() => openNote(h.path, h.name)}
                  className="w-full text-left text-[11px] pt-1 px-1 rounded hover:bg-blue-50 transition-colors truncate"
                  style={{ color: "var(--text)" }} title={`Open ${h.name}`}>
                  {h.name}
                </button>
                {/* The folder line is its own target: sometimes the point of
                    the search is to get to where the note lives, not to read it */}
                <button onClick={() => { runSearch(""); setCurrentFolder(folder); }}
                  className="w-full text-left text-[9px] pb-1 px-1 rounded hover:bg-blue-50 hover:underline transition-colors truncate"
                  style={{ color: "var(--text-tertiary)" }} title={`Open folder ${folder || "vault root"}`}>
                  {folder || "vault root"}
                </button>
              </div>
              {onInsertLink && (
                <button onClick={() => onInsertLink(h.name)} title="Insert a [[link]] into the note you're writing"
                  className="text-[10px] px-1 opacity-0 group-hover/hit:opacity-100 shrink-0" style={{ color: "var(--text-secondary)" }}>
                  🔗
                </button>
              )}
            </div>
            );
          })}
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto" ref={scrollRef}>
        {/* Reference groups — the starred folders. They used to be their own
            browser in the notes panel; here they're jumps into this one, so
            the folders you live in stay one tap away without a second tree. */}
        {Object.keys(referenceLinks).length > 0 && (
          <div className="px-3 pt-2 pb-1">
            <h4 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">{"★"} Reference groups</h4>
            <div className="flex flex-wrap gap-1">
              {Object.entries(referenceLinks).map(([name, path]) => (
                <button
                  key={name}
                  onClick={() => { runSearch(""); setCurrentFolder(path); }}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    currentFolder === path ? "bg-blue-100 text-blue-700" : ""
                  }`}
                  style={currentFolder !== path ? { background: "var(--bg-tertiary)", color: "var(--text-secondary)" } : undefined}
                  title={path}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Pinned notes */}
        {pinnedNotes.length > 0 && (
          <div className="px-3 pt-2 pb-1">
            <h4 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">{"\u2605"} Pinned</h4>
            <div className="space-y-0.5">
              {pinnedNotes.map(path => {
                const name = path.includes("/") ? path.split("/").pop()!.replace(/\.md$/, "") : path.replace(/\.md$/, "");
                return (
                  <div key={path} className="group/pin flex items-center gap-1">
                    <button
                      onClick={() => openNote(path, name)}
                      className="flex-1 text-left text-[11px] py-0.5 px-1 rounded hover:bg-blue-50 truncate transition-colors"
                      style={{ color: "var(--text)" }}
                    >
                      {name}
                    </button>
                    <button
                      onClick={() => togglePin(path)}
                      className="text-yellow-400 hover:text-yellow-600 text-[10px] opacity-0 group-hover/pin:opacity-100 shrink-0"
                      title="Unpin"
                    >
                      {"\u2605"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Recent notes */}
        {recents.length > 0 && (
          <div className="px-3 pt-2 pb-1 border-t" style={{ borderColor: pinnedNotes.length > 0 ? "var(--border)" : "transparent" }}>
            <h4 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Recent</h4>
            <div className="space-y-0.5">
              {recents.slice(0, 5).map(r => (
                <div key={r.path} className="group/recent flex items-center gap-1">
                  <button
                    onClick={() => openNote(r.path, r.name)}
                    className="flex-1 text-left text-[11px] py-0.5 px-1 rounded hover:bg-blue-50 truncate transition-colors"
                    style={{ color: "var(--text)" }}
                  >
                    {r.name}
                  </button>
                  <span className="text-[9px] text-gray-400 shrink-0">
                    {relativeTime(new Date(r.timestamp).toISOString())}
                  </span>
                  {!isPinned(r.path) && (
                    <button
                      onClick={() => togglePin(r.path)}
                      className="text-gray-300 hover:text-yellow-400 text-[10px] opacity-0 group-hover/recent:opacity-100 shrink-0"
                      title="Pin"
                    >
                      {"\u2606"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Breadcrumb */}
        <div className="px-3 pt-2 pb-1 border-t" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-1 text-[10px] text-gray-400 flex-wrap">
            <button onClick={() => setCurrentFolder("")} className="hover:text-blue-500 transition-colors font-medium">
              Vault
            </button>
            {crumbs.map((b, i) => (
              <React.Fragment key={b.path}>
                <span>/</span>
                {i < crumbs.length - 1 ? (
                  <button onClick={() => setCurrentFolder(b.path)} className="hover:text-blue-500 transition-colors">
                    {b.name}
                  </button>
                ) : (
                  <span className="font-medium" style={{ color: "var(--text)" }}>{b.name}</span>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* File list */}
        <div className="px-2 pb-2">
          {loading ? (
            <p className="text-xs text-gray-400 text-center py-4">Loading...</p>
          ) : files.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">Empty folder</p>
          ) : (
            <div className="space-y-0">
              {/* Folders first, then files */}
              {files.filter(f => f.type === "folder").map(f => {
                const refName = isReference(f.path);
                return (
                  <FolderRow
                    key={f.path}
                    file={f}
                    refName={refName}
                    isDropTarget={dropTarget === f.path}
                    expandedFolders={expandedFolders}
                    subFilesMap={subFiles}
                    refNameInput={refNameInput}
                    onNavigateTo={setCurrentFolder}
                    onToggleExpand={toggleExpand}
                    onStarClick={handleStarClick}
                    onRefNameChange={(name) => setRefNameInput(prev => prev ? { ...prev, name } : null)}
                    onRefNameSubmit={addReference}
                    onRefNameCancel={() => setRefNameInput(null)}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onOpenFile={openNote}
                    onDeleteFile={(path) => setConfirmDelete(path)}
                    isPinned={isPinned}
                    onTogglePin={togglePin}
                  />
                );
              })}
              {files.filter(f => f.type === "file").map(f => (
                <FileRow
                  key={f.path}
                  file={f}
                  isPinned={isPinned(f.path)}
                  onOpen={() => openNote(f.path, f.name)}
                  onDragStart={handleDragStart}
                  onDelete={() => setConfirmDelete(f.path)}
                  onTogglePin={() => togglePin(f.path)}
                  isDragging={dragPath === f.path}
                  onInsertLink={onInsertLink && (() => onInsertLink(f.name))}
                  onScanAPs={onScanAPs && (() => onScanAPs(f.path, f.name))}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      )}

      {/* Delete confirmation dialog */}
      {confirmDelete && (
        <div className="absolute inset-0 bg-black/20 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg p-4 mx-4 max-w-xs">
            <p className="text-xs font-medium mb-1" style={{ color: "var(--text)" }}>Delete file?</p>
            <p className="text-[10px] text-gray-500 mb-3 break-all">
              {confirmDelete.split("/").pop()?.replace(/\.md$/, "")}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-3 py-1 text-[10px] rounded border border-gray-200 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteFile(confirmDelete)}
                className="px-3 py-1 text-[10px] rounded bg-red-500 text-white hover:bg-red-600"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────

interface FolderRowProps {
  file: VaultFile;
  refName: string | null;
  isDropTarget: boolean;
  expandedFolders: Set<string>;
  subFilesMap: Map<string, VaultFile[]>;
  refNameInput: { folderPath: string; name: string } | null;
  onNavigateTo: (path: string) => void;
  onToggleExpand: (path: string) => void;
  onStarClick: (folderPath: string) => void;
  onRefNameChange: (name: string) => void;
  onRefNameSubmit: (folderPath: string, name: string) => void;
  onRefNameCancel: () => void;
  onDragStart: (e: React.DragEvent, path: string) => void;
  onDragOver: (e: React.DragEvent, path: string) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, path: string) => void;
  onOpenFile: (path: string, name: string) => void;
  onDeleteFile: (path: string) => void;
  isPinned: (path: string) => boolean;
  onTogglePin: (path: string) => void;
}

function FolderRow({ file, refName, isDropTarget, expandedFolders, subFilesMap, refNameInput, onNavigateTo, onToggleExpand, onStarClick, onRefNameChange, onRefNameSubmit, onRefNameCancel, onDragStart, onDragOver, onDragLeave, onDrop, onOpenFile, onDeleteFile, isPinned, onTogglePin }: FolderRowProps) {
  const isEditingRef = refNameInput?.folderPath === file.path;
  const isExpanded = expandedFolders.has(file.path);

  return (
    <div>
      <div
        className={`group/folder flex items-center gap-1 py-1 px-1 rounded text-[11px] cursor-pointer transition-colors ${
          isDropTarget ? "bg-blue-100 border border-blue-400" : "hover:bg-gray-100 border border-transparent"
        }`}
        draggable
        onClick={() => onNavigateTo(file.path)}
        onDragStart={e => onDragStart(e, file.path)}
        onDragOver={e => onDragOver(e, file.path)}
        onDragLeave={onDragLeave}
        onDrop={e => onDrop(e, file.path)}
        title={`Open ${file.name}`}
      >
        <button onClick={(e) => { e.stopPropagation(); onToggleExpand(file.path); }}
          className="text-[9px] text-gray-400 w-3 shrink-0" title="Peek inside">
          {isExpanded ? "\u25BC" : "\u25B6"}
        </button>
        <span className="flex-1 truncate font-medium" style={{ color: "var(--text)" }}>
          {"\uD83D\uDCC2"} {file.name}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onStarClick(file.path); }}
          className={`text-[9px] shrink-0 transition-colors ${
            refName
              ? "text-yellow-500 hover:text-yellow-600"
              : "text-gray-300 opacity-0 group-hover/folder:opacity-100 hover:text-yellow-400"
          }`}
          title={refName ? `Reference: ${refName} (click to remove)` : "Set as reference"}
        >
          {refName ? "\u2605" : "\u2606"}
        </button>
      </div>
      {/* Inline reference name input */}
      {isEditingRef && refNameInput && (
        <div className="flex items-center gap-1 ml-6 py-1 px-1">
          <input
            autoFocus
            type="text"
            value={refNameInput.name}
            onChange={e => onRefNameChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") onRefNameSubmit(file.path, refNameInput.name);
              if (e.key === "Escape") onRefNameCancel();
            }}
            placeholder="Reference name..."
            className="flex-1 text-[10px] px-1.5 py-0.5 border border-blue-300 rounded focus:outline-none focus:border-blue-500"
            style={{ color: "var(--text)" }}
          />
          <button
            onClick={() => onRefNameSubmit(file.path, refNameInput.name)}
            className="text-[9px] text-blue-500 hover:text-blue-700 font-medium"
          >
            Save
          </button>
          <button
            onClick={onRefNameCancel}
            className="text-[9px] text-gray-400 hover:text-gray-600"
          >
            Cancel
          </button>
        </div>
      )}
      {/* Expanded children \u2014 recursive, every sub-folder gets its own peek */}
      {isExpanded && subFilesMap.has(file.path) && (
        <SubTree
          files={subFilesMap.get(file.path)!}
          expandedFolders={expandedFolders}
          subFilesMap={subFilesMap}
          onNavigateTo={onNavigateTo}
          onToggleExpand={onToggleExpand}
          onOpenFile={onOpenFile}
          isPinned={isPinned}
          onTogglePin={onTogglePin}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        />
      )}
    </div>
  );
}

interface SubTreeProps {
  files: VaultFile[];
  expandedFolders: Set<string>;
  subFilesMap: Map<string, VaultFile[]>;
  onNavigateTo: (path: string) => void;
  onToggleExpand: (path: string) => void;
  onOpenFile: (path: string, name: string) => void;
  isPinned: (path: string) => boolean;
  onTogglePin: (path: string) => void;
  onDragOver: (e: React.DragEvent, path: string) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, path: string) => void;
}

function SubTree({ files, expandedFolders, subFilesMap, onNavigateTo, onToggleExpand, onOpenFile, isPinned, onTogglePin, onDragOver, onDragLeave, onDrop }: SubTreeProps) {
  return (
    <div className="ml-3 border-l border-gray-200 pl-1">
      {files.length === 0 && (
        <p className="text-[9px] text-gray-400 py-1 pl-2">Empty</p>
      )}
      {files.filter(f => f.type === "folder").map(f => (
        <div key={f.path}>
          <div
            className="flex items-center gap-1 py-0.5 px-1 text-[10px] cursor-pointer hover:bg-gray-100 rounded"
            onClick={() => onNavigateTo(f.path)}
            onDragOver={e => onDragOver(e, f.path)}
            onDragLeave={onDragLeave}
            onDrop={e => onDrop(e, f.path)}
            title={`Open ${f.name}`}
          >
            <button onClick={(e) => { e.stopPropagation(); onToggleExpand(f.path); }}
              className="text-[8px] text-gray-400 w-3 shrink-0" title="Peek inside">
              {expandedFolders.has(f.path) ? "\u25BC" : "\u25B6"}
            </button>
            <span>{"\uD83D\uDCC2"}</span>
            <span className="truncate" style={{ color: "var(--text)" }}>{f.name}</span>
          </div>
          {expandedFolders.has(f.path) && subFilesMap.has(f.path) && (
            <SubTree
              files={subFilesMap.get(f.path)!}
              expandedFolders={expandedFolders}
              subFilesMap={subFilesMap}
              onNavigateTo={onNavigateTo}
              onToggleExpand={onToggleExpand}
              onOpenFile={onOpenFile}
              isPinned={isPinned}
              onTogglePin={onTogglePin}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            />
          )}
        </div>
      ))}
      {files.filter(f => f.type === "file").map(f => (
        <div key={f.path} className="group/subfile flex items-center gap-1 py-0.5 px-1 text-[10px] rounded hover:bg-gray-50">
          <button
            onClick={() => onOpenFile(f.path, f.name)}
            className="flex-1 text-left truncate transition-colors"
            style={{ color: "var(--text)" }}
          >
            {f.name}
          </button>
          <span className="text-[8px] text-gray-400 shrink-0">{relativeTime(f.modified)}</span>
          <button
            onClick={() => onTogglePin(f.path)}
            className={`text-[9px] shrink-0 opacity-0 group-hover/subfile:opacity-100 transition-opacity ${
              isPinned(f.path) ? "text-yellow-500" : "text-gray-300 hover:text-yellow-400"
            }`}
            title={isPinned(f.path) ? "Unpin" : "Pin"}
          >
            {isPinned(f.path) ? "\u2605" : "\u2606"}
          </button>
        </div>
      ))}
    </div>
  );
}

interface FileRowProps {
  file: VaultFile;
  isPinned: boolean;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent, path: string) => void;
  onDelete: () => void;
  onTogglePin: () => void;
  isDragging: boolean;
  /** Day view only: drop a [[link]] into the note being written */
  onInsertLink?: false | (() => void);
  /** Day view only: harvest this note's action points into the bucket */
  onScanAPs?: false | (() => void);
}

function FileRow({ file, isPinned, onOpen, onDragStart, onDelete, onTogglePin, isDragging, onInsertLink, onScanAPs }: FileRowProps) {
  return (
    <div
      className={`group/file flex items-center gap-1 py-1 px-1 rounded text-[11px] transition-colors ${
        isDragging ? "opacity-40" : "hover:bg-gray-50"
      }`}
      draggable
      onDragStart={e => onDragStart(e, file.path)}
    >
      <button
        onClick={onOpen}
        className="flex-1 text-left truncate transition-colors"
        style={{ color: "var(--text)" }}
      >
        {file.name}
      </button>
      <span className="text-[9px] text-gray-400 shrink-0">{relativeTime(file.modified)}</span>
      {onInsertLink && (
        <button onClick={onInsertLink} title="Insert a [[link]] into the note you're writing"
          className="text-[10px] shrink-0 opacity-0 group-hover/file:opacity-100 transition-opacity text-gray-400 hover:text-blue-500">
          🔗
        </button>
      )}
      {onScanAPs && (
        <button onClick={onScanAPs} title="Scan this note for action points"
          className="text-[10px] shrink-0 opacity-0 group-hover/file:opacity-100 transition-opacity text-gray-400 hover:text-amber-500">
          🔍
        </button>
      )}
      <button
        onClick={onTogglePin}
        className={`text-[10px] shrink-0 opacity-0 group-hover/file:opacity-100 transition-opacity ${
          isPinned ? "text-yellow-500 opacity-100" : "text-gray-300 hover:text-yellow-400"
        }`}
        title={isPinned ? "Unpin" : "Pin"}
      >
        {isPinned ? "\u2605" : "\u2606"}
      </button>
      <button
        onClick={onDelete}
        className="text-gray-300 hover:text-red-500 text-[10px] opacity-0 group-hover/file:opacity-100 transition-opacity shrink-0"
        title="Delete"
      >
        {"\uD83D\uDDD1"}
      </button>
    </div>
  );
}

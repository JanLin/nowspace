import React, { useState, useEffect, useRef } from "react";
import { api, type TaskLink } from "../api";

const VAULT_NAME = "Home";
const DEFAULT_FOLDER = "1-Projects";

function obsidianUri(path: string): string {
  return `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`;
}

interface NoteFile {
  name: string;
  path: string;
  type: string; // "project" | "call_log" | "subfolder" | "search"
}

interface NoteFilePickerProps {
  /** Existing wiki links on the task (shown at top) */
  existingLinks?: TaskLink[];
  /** Group name for folder resolution (e.g. "iGrant", "Rotary") */
  group?: string;
  /** Position for the popup */
  position: { top: number; left: number };
  /** Called when user selects a file to open */
  onSelect: (path: string, name: string) => void;
  /** Called when user wants to add a wiki link to the task */
  onAddLink?: (name: string, path: string) => void;
  /** Called when user wants to remove a wiki link from the task */
  onRemoveLink?: (name: string) => void;
  /** Close the picker */
  onClose: () => void;
  /** Week offset for folder resolution */
  weekOffset?: number;
}

export default function NoteFilePicker({
  existingLinks,
  group,
  position,
  onSelect,
  onAddLink,
  onRemoveLink,
  onClose,
  weekOffset = 0,
}: NoteFilePickerProps) {
  const [files, setFiles] = useState<NoteFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<NoteFile[]>([]);
  const [searching, setSearching] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [showBrowse, setShowBrowse] = useState(!existingLinks || existingLinks.length === 0);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Load files: group folder if resolved, otherwise 1-Projects
  const loadProjectsFolder = () => {
    api.vaultFolder(DEFAULT_FOLDER).then((res) => {
      setFiles(res.files.map(f => ({ name: f.name, path: f.path, type: f.type === "folder" ? "subfolder" : "project" })));
      setFolderPath(DEFAULT_FOLDER);
    }).catch(() => setFiles([])).finally(() => setLoading(false));
  };

  useEffect(() => {
    setLoading(true);
    if (group) {
      api.vaultLinkedDocs(group).then((res) => {
        if (!res.folder) {
          // Group has no configured reference — show 1-Projects
          loadProjectsFolder();
          return;
        }
        const docs: NoteFile[] = [];
        for (const d of res.docs) {
          if (d.type !== "subfolder") docs.push({ name: d.name, path: d.path, type: d.type });
        }
        setFiles(docs);
        setFolderPath(res.folder || "");
        setLoading(false);
      }).catch(() => { loadProjectsFolder(); });
    } else {
      loadProjectsFolder();
    }
  }, [group, weekOffset]);

  // Search vault
  const doSearch = (q: string) => {
    setSearchQuery(q);
    if (q.length < 2) { setSearchResults([]); return; }
    clearTimeout(debounceRef.current);
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api.vaultSearch(q, 10);
        setSearchResults(res.results.map(r => ({ name: r.name, path: r.path, type: "search" })));
      } catch { setSearchResults([]); }
      finally { setSearching(false); }
    }, 250);
  };

  // Create new note
  const handleCreate = async () => {
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      const folder = folderPath || DEFAULT_FOLDER;
      const res = await api.createNote(folder, newName.trim());
      onAddLink?.(newName.trim(), res.path);
      onSelect(res.path, newName.trim());
    } catch (e) {
      // If conflict (already exists), try to open it
      const searchRes = await api.vaultSearch(newName.trim(), 1);
      if (searchRes.results.length > 0) {
        onAddLink?.(searchRes.results[0].name, searchRes.results[0].path);
        onSelect(searchRes.results[0].path, searchRes.results[0].name);
      }
    } finally {
      setCreating(false);
    }
  };

  const handleFileClick = (file: NoteFile) => {
    if (file.type === "subfolder") {
      // Navigate into subfolder
      setLoading(true);
      setSearchQuery("");
      api.vaultFolder(file.path).then((res) => {
        setFiles(res.files.map(f => ({ name: f.name, path: f.path, type: f.type === "folder" ? "subfolder" : "project" })));
        setFolderPath(file.path);
      }).catch(() => setFiles([])).finally(() => setLoading(false));
      return;
    }
    onAddLink?.(file.name.replace(/\.md$/, ""), file.path);
    onSelect(file.path, file.name.replace(/\.md$/, ""));
  };

  const displayFiles = searchQuery.length >= 2 ? searchResults : files;

  // Adjust position to stay in viewport
  const style: React.CSSProperties = {
    position: "fixed",
    top: Math.min(position.top, window.innerHeight - 400),
    left: Math.min(position.left, window.innerWidth - 300),
    zIndex: 50,
  };

  return (
    <div ref={popupRef} style={style}
      className="bg-white rounded-lg shadow-xl border border-gray-200 p-3 min-w-[260px] max-w-[340px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1 min-w-0">
          {folderPath && folderPath !== DEFAULT_FOLDER && (
            <button
              onClick={() => {
                const parent = folderPath.split("/").slice(0, -1).join("/") || DEFAULT_FOLDER;
                setLoading(true);
                api.vaultFolder(parent).then((res) => {
                  setFiles(res.files.map(f => ({ name: f.name, path: f.path, type: f.type === "folder" ? "subfolder" : "project" })));
                  setFolderPath(parent);
                }).catch(() => setFiles([])).finally(() => setLoading(false));
              }}
              className="text-[10px] text-blue-500 hover:text-blue-700 shrink-0"
              title="Go up"
            >
              ‹
            </button>
          )}
          <span className="text-xs font-semibold text-gray-700 truncate">
            {group && folderPath && folderPath !== DEFAULT_FOLDER ? `Notes — ${group}` : folderPath ? folderPath.split("/").pop() : "Project Notes"}
          </span>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xs shrink-0">&times;</button>
      </div>

      {/* Existing wiki links on this task */}
      {existingLinks && existingLinks.length > 0 && (
        <div className="mb-2 pb-2 border-b border-gray-100">
          <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Linked</div>
          {existingLinks.map((link, i) => (
            <div key={i} className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-blue-50 group/link">
              <button
                onClick={() => {
                  if (link.resolved_path) {
                    onSelect(link.resolved_path, link.display_text || link.name);
                  } else {
                    // Try to resolve by searching, create if not found
                    api.vaultSearch(link.name, 1).then((res) => {
                      if (res.results.length > 0) {
                        onSelect(res.results[0].path, link.display_text || link.name);
                      } else {
                        // Note doesn't exist in search — create or find via create API
                        const folder = folderPath || DEFAULT_FOLDER;
                        const noteName = link.display_text || link.name;
                        api.createNote(folder, noteName).then((created) => {
                          onSelect(created.path, noteName);
                        }).catch(async (err) => {
                          // 409 = file already exists, extract path from error
                          const msg = err instanceof Error ? err.message : String(err);
                          const pathMatch = msg.match(/File already exists: (.+\.md)/);
                          if (pathMatch) {
                            onSelect(pathMatch[1], noteName);
                          } else {
                            onSelect(link.name + ".md", noteName);
                          }
                        });
                      }
                    });
                  }
                }}
                className="flex items-center gap-1.5 text-left flex-1 min-w-0 text-gray-700 hover:text-blue-700"
              >
                <span className="text-[10px] shrink-0">📄</span>
                <span className="truncate flex-1">{link.display_text || link.name}</span>
                <span className="text-[10px] text-blue-500 shrink-0">Open</span>
              </button>
              {onRemoveLink && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRemoveLink(link.name); }}
                  className="text-[10px] text-red-300 hover:text-red-500 shrink-0"
                  title="Remove link"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Browse toggle when task already has links */}
      {!showBrowse && (
        <button
          onClick={() => setShowBrowse(true)}
          className="text-[10px] text-blue-500 hover:text-blue-700 mb-1"
        >
          Browse more...
        </button>
      )}

      {showBrowse && (
        <>
          {/* Search */}
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(e) => doSearch(e.target.value)}
            placeholder="Search vault..."
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded bg-white outline-none focus:ring-1 focus:ring-blue-400 mb-2"
          />

          {/* File list */}
          <div className="max-h-48 overflow-y-auto">
            {loading && <div className="text-[10px] text-gray-400 text-center py-2">Loading...</div>}
            {searching && <div className="text-[10px] text-gray-400 text-center py-1">Searching...</div>}

            {!loading && displayFiles.length === 0 && searchQuery.length < 2 && (
              <div className="text-[10px] text-gray-400 text-center py-2">
                {group ? "No notes found for this group" : "No project notes found"}
              </div>
            )}

            {displayFiles.map((file, i) => (
              <button key={`${file.path}-${i}`}
                onClick={() => handleFileClick(file)}
                className="w-full text-left flex items-center gap-1.5 px-2 py-1 text-xs rounded hover:bg-blue-50 hover:text-blue-700 text-gray-700 truncate"
              >
                <span className="text-[10px] shrink-0">
                  {file.type === "call_log" ? "📞" : file.type === "subfolder" ? "📂" : "📄"}
                </span>
                <span className="truncate flex-1">{file.name}</span>
                <span className="text-[10px] text-gray-400 shrink-0 truncate max-w-[80px]">
                  {file.path.split("/").slice(0, -1).join("/")}
                </span>
              </button>
            ))}
          </div>

          {/* Create new note */}
          {!showCreate ? (
            <button
              onClick={() => { setShowCreate(true); setTimeout(() => searchRef.current?.blur(), 0); }}
              className="mt-2 text-[10px] text-blue-500 hover:text-blue-700"
            >
              + New note{group ? ` in ${group}` : ""}...
            </button>
      ) : (
        <div className="mt-2 border-t border-gray-100 pt-2">
          <div className="text-[10px] text-gray-400 mb-1">
            Create in: {folderPath || DEFAULT_FOLDER}
          </div>
          <div className="flex gap-1">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setShowCreate(false); }}
              placeholder="Note name..."
              autoFocus
              className="flex-1 text-xs px-2 py-1 border border-gray-200 rounded outline-none focus:ring-1 focus:ring-blue-400"
            />
            <button
              onClick={handleCreate}
              disabled={!newName.trim() || creating}
              className="px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
            >
              {creating ? "..." : "Create"}
            </button>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}

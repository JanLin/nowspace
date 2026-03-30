import React, { useState, useEffect, useRef } from "react";
import { api, type TaskLink } from "../api";

const VAULT_NAME = "Home";

function obsidianUri(path: string): string {
  // Remove .md extension, URL-encode the path
  const filePath = path.replace(/\.md$/, "");
  return `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(filePath)}`;
}

/* ── Link icon with count badge ──────────────────────────── */

export function LinkIcon({
  links,
  size = "sm",
  onClick,
}: {
  links: TaskLink[];
  size?: "sm" | "xs";
  onClick: (e: React.MouseEvent) => void;
}) {
  if (links.length === 0) return null;
  const textSize = size === "xs" ? "text-[10px]" : "text-xs";
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      className={`shrink-0 ${textSize} text-blue-400 hover:text-blue-600 transition-opacity opacity-70 hover:opacity-100`}
      title={`${links.length} linked note${links.length > 1 ? "s" : ""}`}
    >
      🔗{links.length > 1 && <sup className="text-[8px] font-bold">{links.length}</sup>}
    </button>
  );
}

/* ── Search input for linking a new note ─────────────────── */

function NoteSearch({
  onSelect,
  onCancel,
}: {
  onSelect: (name: string, path: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => { ref.current?.focus(); }, []);

  const doSearch = (q: string) => {
    if (q.length < 2) { setResults([]); return; }
    setLoading(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api.vaultSearch(q, 8);
        setResults(res.results.map((r) => ({ name: r.name, path: r.path })));
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 250);
  };

  return (
    <div className="mt-2 border-t pt-2">
      <div className="text-[10px] text-gray-400 mb-1">Link a note...</div>
      <input
        ref={ref}
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); doSearch(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
        placeholder="Search vault..."
        className="w-full text-xs px-2 py-1 border border-gray-200 rounded bg-white outline-none focus:ring-1 focus:ring-blue-400"
      />
      {loading && <div className="text-[10px] text-gray-400 mt-1">Searching...</div>}
      {results.length > 0 && (
        <div className="mt-1 max-h-32 overflow-y-auto">
          {results.map((r) => (
            <button
              key={r.path}
              onClick={() => onSelect(r.name, r.path)}
              className="w-full text-left px-2 py-1 text-xs rounded hover:bg-blue-50 hover:text-blue-700 text-gray-700 truncate"
            >
              {r.name}
              <span className="text-[10px] text-gray-400 ml-1">{r.path.split("/").slice(0, -1).join("/")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main popup ──────────────────────────────────────────── */

export default function TaskLinkPopup({
  links,
  position,
  onClose,
  onAddLink,
  onOpenInApp,
}: {
  links: TaskLink[];
  position: { top: number; left: number };
  onClose: () => void;
  onAddLink?: (name: string, path: string) => void;
  onOpenInApp?: (path: string, name: string) => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [showSearch, setShowSearch] = useState(false);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Adjust position to stay in viewport
  const style: React.CSSProperties = {
    position: "fixed",
    top: Math.min(position.top, window.innerHeight - 300),
    left: Math.min(position.left, window.innerWidth - 260),
    zIndex: 50,
  };

  return (
    <div ref={popupRef} style={style}
      className="bg-white rounded-lg shadow-xl border border-gray-200 p-3 min-w-[220px] max-w-[300px]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-700">Linked Notes</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xs">&times;</button>
      </div>

      {links.length === 0 && !showSearch && (
        <p className="text-[11px] text-gray-400">No linked notes yet.</p>
      )}

      {links.map((link, i) => (
        <div key={i} className="flex items-center gap-2 py-1 group/link">
          <span className="text-[11px] text-gray-700 flex-1 truncate" title={link.resolved_path || link.name}>
            {link.display_text || link.name}
          </span>
          {link.resolved_path ? (
            <div className="flex items-center gap-1.5 shrink-0">
              {onOpenInApp && (
                <button
                  onClick={() => onOpenInApp(link.resolved_path!, link.display_text || link.name)}
                  className="text-[10px] text-blue-500 hover:text-blue-700 whitespace-nowrap"
                  title="Open in editor"
                >
                  Open
                </button>
              )}
              <a
                href={obsidianUri(link.resolved_path)}
                className="text-[10px] text-gray-400 hover:text-gray-600 whitespace-nowrap"
                title="Open in Obsidian"
              >
                {onOpenInApp ? "Obsidian" : "Open"} &rarr;
              </a>
            </div>
          ) : (
            <span className="text-[10px] text-gray-400" title="Note not found in vault">unresolved</span>
          )}
        </div>
      ))}

      {onAddLink && !showSearch && (
        <button
          onClick={() => setShowSearch(true)}
          className="mt-1 text-[10px] text-blue-500 hover:text-blue-700"
        >
          + Link note...
        </button>
      )}

      {showSearch && (
        <NoteSearch
          onSelect={(name, path) => {
            onAddLink?.(name, path);
            setShowSearch(false);
          }}
          onCancel={() => setShowSearch(false)}
        />
      )}
    </div>
  );
}

import React, { useRef, useState } from "react";
import type { NoteTab } from "../api";

/** The Notes tab strip: one sub-tab per open note.
 *
 *  Tap a tab to read it, 📌 to keep it (pinned notes are never closed to make
 *  room), × to close it, drag to reorder. "Clear all" empties the strip
 *  outright — pins included, since that's the point of asking for it. */
export default function NoteTabsStrip({
  tabs,
  activePath,
  maxOpen,
  onSelect,
  onClose,
  onTogglePin,
  onReorder,
  onClearAll,
}: {
  tabs: NoteTab[];
  activePath: string | null;
  maxOpen: number;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onTogglePin: (path: string) => void;
  onReorder: (fromPath: string, toPath: string) => void;
  onClearAll: () => void;
}) {
  const dragPath = useRef<string | null>(null);
  const [dropPath, setDropPath] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  if (tabs.length === 0) return null;

  const pinnedCount = tabs.filter((t) => t.pinned).length;

  return (
    <div className="flex items-center gap-1 mb-2 pb-1 border-b overflow-x-auto" style={{ borderColor: "var(--border)" }}>
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        return (
          <div
            key={tab.path}
            draggable
            onDragStart={(e) => {
              dragPath.current = tab.path;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", tab.path);
            }}
            onDragEnd={() => { dragPath.current = null; setDropPath(null); }}
            onDragOver={(e) => {
              if (!dragPath.current || dragPath.current === tab.path) return;
              e.preventDefault();
              setDropPath(tab.path);
            }}
            onDragLeave={() => setDropPath((p) => (p === tab.path ? null : p))}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragPath.current;
              dragPath.current = null;
              setDropPath(null);
              if (from && from !== tab.path) onReorder(from, tab.path);
            }}
            onClick={() => onSelect(tab.path)}
            title={tab.path}
            className={`group/tab shrink-0 flex items-center gap-1 pl-2 pr-1 py-1 rounded-t text-xs cursor-pointer select-none border-b-2 transition-colors ${
              active ? "border-blue-500" : "border-transparent hover:bg-white/5"
            } ${dropPath === tab.path ? "bg-blue-100/20" : ""}`}
            style={{ color: active ? "var(--text)" : "var(--text-secondary)" }}
          >
            <span className="max-w-[12rem] truncate">{tab.name}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onTogglePin(tab.path); }}
              className={`text-[10px] transition-opacity ${tab.pinned ? "opacity-100" : "opacity-0 group-hover/tab:opacity-50 hover:!opacity-100"}`}
              title={tab.pinned ? "Unpin — may be closed to make room" : "Pin — keep this note open"}
            >
              📌
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(tab.path); }}
              className="text-[11px] leading-none px-0.5 opacity-0 group-hover/tab:opacity-60 hover:!opacity-100 transition-opacity"
              title="Close this note"
            >
              ×
            </button>
          </div>
        );
      })}
      <span className="flex-1" />
      <span className="shrink-0 text-[10px] whitespace-nowrap" style={{ color: "var(--text-tertiary)" }}>
        {tabs.length}/{maxOpen}{pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ""}
      </span>
      {confirmClear ? (
        <span className="shrink-0 flex items-center gap-1">
          <button
            onClick={() => { setConfirmClear(false); onClearAll(); }}
            className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 whitespace-nowrap"
            title="Close every note, pinned ones included"
          >
            Clear {tabs.length}?
          </button>
          <button onClick={() => setConfirmClear(false)} className="text-[10px] px-1 rounded" style={{ color: "var(--text-tertiary)" }}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          onClick={() => setConfirmClear(true)}
          className="shrink-0 text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap transition-colors"
          style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
          title="Close every note, pinned ones included"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

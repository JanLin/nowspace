import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api";
import type { VaultStatus, ApiKeyStatus } from "../api";

interface FolderEntry {
  name: string;
  path: string;
}

type BrowseTarget = "vault" | "__new__" | string; // "vault" = vault path picker, "__new__" = new ref link, string = editing ref link key
type BrowseMode = "system" | "vault"; // system = absolute paths, vault = relative to vault root

// One editable row in the Contexts card (tag letter, name, group prefixes as CSV)
type CtxRow = { abbrev: string; name: string; groups: string };

function buildCtxRows(contexts: Record<string, string[]>, tags: Record<string, string>): CtxRow[] {
  const abbrevOf: Record<string, string> = {};
  Object.entries(tags).forEach(([a, n]) => { if (!(n in abbrevOf)) abbrevOf[n] = a; });
  const names = ["work", "volunteer", "personal",
    ...Object.keys(contexts).filter((n) => !["work", "volunteer", "personal"].includes(n)).sort(),
    ...Object.values(tags).filter((n) => !["work", "volunteer", "personal"].includes(n) && !(n in contexts)).sort(),
  ];
  return [...new Set(names)].map((name) => ({
    abbrev: abbrevOf[name] || "",
    name,
    groups: (contexts[name] || []).join(", "),
  }));
}

export default function Settings({ onVaultReady }: { onVaultReady?: () => void }) {
  const [vaultPath, setVaultPath] = useState("");
  const [vaultRoot, setVaultRoot] = useState("");
  const [referenceLinks, setReferenceLinks] = useState<Record<string, string>>({});
  const [diaryFolder, setDiaryFolder] = useState("");
  const [diaryFolderSaved, setDiaryFolderSaved] = useState(false);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // API key
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus | null>(null);

  // Vault validation
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    vault_path: string;
    vault_root: string;
    vault_status: VaultStatus;
    reference_links: Record<string, string>;
  } | null>(null);
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // New reference link form
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");

  // Folder browser (shared between vault picker and ref group picker)
  const [browseTarget, setBrowseTarget] = useState<BrowseTarget | null>(null);
  const [browseMode, setBrowseMode] = useState<BrowseMode>("system");
  const [browsePath, setBrowsePath] = useState("");
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseFolders, setBrowseFolders] = useState<FolderEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);

  // Editing reference link
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editPath, setEditPath] = useState("");

  // Contexts: one row per context (tag letter, name, group prefixes as CSV)
  const [ctxRows, setCtxRows] = useState<CtxRow[]>([]);
  const [ctxDirty, setCtxDirty] = useState(false);
  const [ctxSaving, setCtxSaving] = useState(false);

  const flash = useCallback((type: "ok" | "err", text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  }, []);

  const saveContexts = async (rows: CtxRow[]) => {
    // Validate: single-letter unique abbreviations, non-empty names
    const seen = new Set<string>();
    for (const r of rows) {
      const a = r.abbrev.trim().toLowerCase();
      const n = r.name.trim().toLowerCase();
      if (!n) { flash("err", "Context name cannot be empty"); return; }
      if (a && (a.length !== 1 || !/[a-z]/.test(a))) { flash("err", `Tag for "${n}" must be a single letter`); return; }
      if (a && seen.has(a)) { flash("err", `Tag @${a} is used twice`); return; }
      if (a) seen.add(a);
    }
    const contexts: Record<string, string[]> = {};
    const tags: Record<string, string> = {};
    rows.forEach((r) => {
      const name = r.name.trim().toLowerCase();
      const groups = r.groups.split(",").map((g) => g.trim().toLowerCase()).filter(Boolean);
      if (groups.length) contexts[name] = groups;
      if (r.abbrev.trim()) tags[r.abbrev.trim().toLowerCase()] = name;
    });
    setCtxSaving(true);
    try {
      const res = await api.saveContextSettings(contexts, tags);
      setCtxRows(buildCtxRows(res.contexts, res.context_tags));
      setCtxDirty(false);
      window.dispatchEvent(new CustomEvent("ctx-config-changed"));
      flash("ok", "Contexts saved");
    } catch {
      flash("err", "Failed to save contexts");
    }
    setCtxSaving(false);
  };

  // ── Load initial settings ──────────────────────────────────────────
  useEffect(() => {
    api.getSettings().then((s) => {
      setVaultPath(s.vault_path);
      setVaultRoot(s.vault_root);
      setReferenceLinks(s.reference_links);
      setVaultStatus(s.vault_status);
      setApiKeyStatus(s.api_key_status);
      setCtxRows(buildCtxRows(s.contexts || {}, s.context_tags || {}));
      setDiaryFolder(s.diary_folder || "");
      setLoading(false);
    }).catch(() => {
      flash("err", "Failed to load settings");
      setLoading(false);
    });
  }, [flash]);

  // ── Sync reference links when changed from vault browser ──────────
  useEffect(() => {
    const handler = () => {
      api.getSettings().then((s) => setReferenceLinks(s.reference_links)).catch(() => {});
    };
    window.addEventListener("reference-links-changed", handler);
    return () => window.removeEventListener("reference-links-changed", handler);
  }, []);

  // ── Live vault validation ──────────────────────────────────────────
  const validateVaultPath = useCallback((path: string) => {
    if (validateTimer.current) clearTimeout(validateTimer.current);
    if (!path.trim()) { setValidationResult(null); return; }
    validateTimer.current = setTimeout(async () => {
      setValidating(true);
      try {
        const res = await api.validateVault(path);
        setValidationResult(res);
      } catch { setValidationResult(null); }
      setValidating(false);
    }, 500);
  }, []);

  const handleVaultPathChange = (val: string) => {
    setVaultPath(val);
    validateVaultPath(val);
  };

  // ── Save vault path ────────────────────────────────────────────────
  const saveVaultPath = async (createStructure = false) => {
    setSaving(true);
    try {
      const res = await api.updateVaultPath(vaultPath, createStructure);
      setVaultRoot(res.vault_root);
      setVaultStatus(res.vault_status);
      setReferenceLinks(res.reference_links);
      setValidationResult(null);
      const parts = ["Vault connected"];
      if (res.created_folders.length > 0) parts.push(`Created folders: ${res.created_folders.join(", ")}`);
      if (Object.keys(res.reference_links).length > 0) parts.push(`Loaded ${Object.keys(res.reference_links).length} reference groups`);
      flash("ok", parts.join(". "));
      if (res.vault_status.exists && res.vault_status.has_para && apiKeyStatus?.configured) onVaultReady?.();
    } catch (e: unknown) {
      flash("err", e instanceof Error ? e.message : "Failed to save");
    }
    setSaving(false);
  };

  // ── Save API key ────────────────────────────────────────────────────
  // ── Folder browser helpers ─────────────────────────────────────────
  const openSystemBrowser = useCallback(async (target: BrowseTarget, startPath = "") => {
    setBrowseTarget(target);
    setBrowseMode("system");
    setBrowseLoading(true);
    try {
      const res = await api.browseFolders(startPath);
      setBrowsePath(res.current);
      setBrowseParent(res.parent);
      setBrowseFolders(res.folders);
    } catch {
      setBrowseFolders([]);
    }
    setBrowseLoading(false);
  }, []);

  const openVaultBrowser = useCallback(async (target: BrowseTarget, startPath = "") => {
    setBrowseTarget(target);
    setBrowseMode("vault");
    setBrowseLoading(true);
    try {
      const res = await api.listVaultFolders(startPath);
      setBrowsePath(res.current);
      setBrowseParent(startPath ? startPath.split("/").slice(0, -1).join("/") : null);
      setBrowseFolders(res.folders);
    } catch {
      setBrowseFolders([]);
    }
    setBrowseLoading(false);
  }, []);

  const navigateBrowser = useCallback(async (folderPath: string) => {
    setBrowseLoading(true);
    try {
      if (browseMode === "system") {
        const res = await api.browseFolders(folderPath);
        setBrowsePath(res.current);
        setBrowseParent(res.parent);
        setBrowseFolders(res.folders);
      } else {
        const res = await api.listVaultFolders(folderPath);
        setBrowsePath(res.current || "");
        setBrowseParent(folderPath ? folderPath.split("/").slice(0, -1).join("/") : null);
        setBrowseFolders(res.folders);
      }
    } catch {
      setBrowseFolders([]);
    }
    setBrowseLoading(false);
  }, [browseMode]);

  const selectBrowserFolder = useCallback(async (folderPath: string) => {
    if (browseTarget === "vault") {
      // For vault picker, set the path and auto-save immediately
      setVaultPath(folderPath);
      setBrowseTarget(null);
      setSaving(true);
      try {
        const res = await api.updateVaultPath(folderPath, false);
        setVaultRoot(res.vault_root);
        setVaultStatus(res.vault_status);
        setReferenceLinks(res.reference_links);
        setValidationResult(null);
        const parts = ["Vault connected"];
        if (Object.keys(res.reference_links).length > 0) parts.push(`Loaded ${Object.keys(res.reference_links).length} reference groups`);
        flash("ok", parts.join(". "));
        if (res.vault_status.exists && res.vault_status.has_para && apiKeyStatus?.configured) onVaultReady?.();
      } catch (e: unknown) {
        // Path might not exist yet — validate instead
        validateVaultPath(folderPath);
        flash("err", e instanceof Error ? e.message : "Failed to save vault path");
      }
      setSaving(false);
      return;
    } else if (browseTarget === "__new__") {
      setNewPath(folderPath);
    } else if (browseTarget) {
      setEditPath(folderPath);
    }
    setBrowseTarget(null);
  }, [browseTarget, validateVaultPath, flash, onVaultReady]);

  const closeBrowser = () => setBrowseTarget(null);

  // ── Reference link CRUD ────────────────────────────────────────────
  const addLink = async () => {
    if (!newName.trim() || !newPath.trim()) return;
    setSaving(true);
    try {
      const res = await api.addReferenceLink(newName.trim(), newPath.trim());
      setReferenceLinks(res.reference_links);
      setNewName(""); setNewPath("");
      flash("ok", `Added "${newName.trim()}"`);
    } catch (e: unknown) { flash("err", e instanceof Error ? e.message : "Failed to add"); }
    setSaving(false);
  };

  const deleteLink = async (name: string) => {
    setSaving(true);
    try {
      const res = await api.deleteReferenceLink(name);
      setReferenceLinks(res.reference_links);
      flash("ok", `Removed "${name}"`);
    } catch (e: unknown) { flash("err", e instanceof Error ? e.message : "Failed to remove"); }
    setSaving(false);
  };

  const saveEditLink = async (key: string) => {
    if (!editPath.trim()) return;
    setSaving(true);
    try {
      const updated = { ...referenceLinks, [key]: editPath.trim() };
      const res = await api.updateReferenceLinks(updated);
      setReferenceLinks(res.reference_links);
      setEditingKey(null); setEditPath("");
      flash("ok", `Updated "${key}"`);
    } catch (e: unknown) { flash("err", e instanceof Error ? e.message : "Failed to update"); }
    setSaving(false);
  };

  // ── Derived state ──────────────────────────────────────────────────
  const displayStatus = validationResult?.vault_status ?? vaultStatus;
  const hasUnsavedChanges = validationResult !== null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" style={{ color: "var(--text-secondary)" }}>
        Loading settings...
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-8">
      {/* Flash message */}
      {message && (
        <div
          className="px-4 py-3 rounded-lg text-sm font-medium flex items-center gap-2"
          style={{
            backgroundColor: message.type === "ok" ? "var(--accent-bg)" : "#fef2f2",
            color: message.type === "ok" ? "var(--accent)" : "#dc2626",
            border: `1px solid ${message.type === "ok" ? "var(--accent)" : "#fca5a5"}`,
          }}
        >
          <span>{message.type === "ok" ? "✓" : "✗"}</span>
          {message.text}
        </div>
      )}

      {/* ================================================================ */}
      {/* Vault Path                                                       */}
      {/* ================================================================ */}
      <section
        className="rounded-xl p-5 sm:p-6"
        style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}
      >
        <h2 className="text-base font-semibold mb-1" style={{ color: "var(--text)" }}>
          Obsidian Vault
        </h2>
        <p className="text-xs mb-4" style={{ color: "var(--text-secondary)" }}>
          Point to your Obsidian vault's inbox folder (e.g. ~/Obsidian/Home/0-Inbox).
          The vault root and PARA structure are derived automatically.
        </p>

        {/* Input + Browse + Save row */}
        <div className="flex flex-wrap gap-2 mb-3">
          <input
            type="text"
            value={vaultPath}
            onChange={(e) => handleVaultPathChange(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2.5 rounded-lg text-sm font-mono"
            style={{
              backgroundColor: "var(--bg)",
              color: "var(--text)",
              border: `2px solid ${
                displayStatus
                  ? displayStatus.exists
                    ? displayStatus.has_para ? "var(--accent)" : "#f59e0b"
                    : "#ef4444"
                  : "var(--border)"
              }`,
              outline: "none",
            }}
            placeholder="~/Obsidian/Home/0-Inbox"
          />
          <button
            onClick={() => {
              // Start browsing from current vault path's parent, or home
              const startDir = vaultPath
                ? vaultPath.replace(/\/[^/]*$/, "") // go up one level
                : "";
              openSystemBrowser("vault", startDir);
            }}
            className="px-3 py-2.5 rounded-lg text-sm shrink-0 transition-colors"
            style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
            title="Browse folders"
          >
            📁 Browse
          </button>
          {displayStatus?.exists ? (
            <button
              onClick={() => saveVaultPath(false)}
              disabled={saving}
              className="px-5 py-2.5 rounded-lg text-sm font-medium shrink-0 transition-colors"
              style={{ backgroundColor: "var(--accent)", color: "white", opacity: saving ? 0.6 : 1 }}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          ) : (
            <button
              onClick={() => saveVaultPath(true)}
              disabled={saving}
              className="px-4 py-2.5 rounded-lg text-sm font-medium shrink-0 transition-colors"
              style={{ backgroundColor: "var(--accent)", color: "white", opacity: saving ? 0.6 : 1 }}
            >
              {saving ? "Creating..." : "Create & Save"}
            </button>
          )}
        </div>

        {validating && (
          <p className="text-xs mb-2" style={{ color: "var(--text-tertiary)" }}>Checking...</p>
        )}

        {/* Status indicator */}
        {displayStatus && (
          <div
            className="rounded-lg p-3 mb-3 text-sm"
            style={{
              backgroundColor: displayStatus.exists
                ? displayStatus.has_para ? "var(--accent-bg)" : "#fffbeb"
                : "#fef2f2",
              border: `1px solid ${
                displayStatus.exists
                  ? displayStatus.has_para ? "var(--accent)" : "#f59e0b"
                  : "#fca5a5"
              }`,
            }}
          >
            {displayStatus.exists ? (
              <>
                <div className="flex items-center gap-2 font-medium" style={{
                  color: displayStatus.has_para ? "var(--accent)" : "#b45309"
                }}>
                  <span>{displayStatus.has_para ? "✓" : "⚠"}</span>
                  <span>
                    {displayStatus.has_para
                      ? `Vault found — ${displayStatus.file_count} notes`
                      : "Directory found but missing PARA structure"}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {["0-Inbox", "1-Projects", "2-Areas", "3-Resources", "4-Archive"].map((f) => (
                    <span
                      key={f}
                      className="px-2 py-0.5 rounded text-xs font-mono"
                      style={{
                        backgroundColor: displayStatus.para_folders.includes(f)
                          ? "var(--accent-bg)" : "var(--bg-tertiary)",
                        color: displayStatus.para_folders.includes(f)
                          ? "var(--accent)" : "var(--text-tertiary)",
                        border: `1px solid ${displayStatus.para_folders.includes(f) ? "var(--accent)" : "var(--border)"}`,
                      }}
                    >
                      {displayStatus.para_folders.includes(f) ? "✓ " : "✗ "}{f}
                    </span>
                  ))}
                </div>
                {displayStatus.has_config && (
                  <div className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                    Reference links configured — groups will be loaded automatically.
                  </div>
                )}
                {hasUnsavedChanges && validationResult && Object.keys(validationResult.reference_links).length > 0 && (
                  <div className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                    Will load {Object.keys(validationResult.reference_links).length} reference groups: {Object.keys(validationResult.reference_links).join(", ")}
                  </div>
                )}
              </>
            ) : (
              <div>
                <div className="flex items-center gap-2 font-medium" style={{ color: "#dc2626" }}>
                  <span>✗</span>
                  <span>Directory not found</span>
                </div>
                <p className="mt-1 text-xs" style={{ color: "#9a3412" }}>
                  Click "Create & Save" to create the vault with PARA folder structure (0-Inbox, 1-Projects, 2-Areas, 3-Resources, 4-Archive).
                </p>
              </div>
            )}
          </div>
        )}

        {/* Vault root info */}
        <div className="pt-2" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
            <span className="font-medium">Vault root:</span>
            <span className="font-mono">{hasUnsavedChanges ? validationResult?.vault_root : vaultRoot}</span>
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* API Key                                                          */}
      {/* ================================================================ */}
      <section
        className="rounded-xl p-5 sm:p-6"
        style={{
          backgroundColor: "var(--bg-secondary)",
          border: `1px solid ${apiKeyStatus?.configured ? "var(--border)" : "#fca5a5"}`,
        }}
      >
        <h2 className="text-base font-semibold mb-1" style={{ color: "var(--text)" }}>
          Claude API Key
        </h2>
        <p className="text-xs mb-3" style={{ color: "var(--text-secondary)" }}>
          Required for the coaching agent. Get your key from{" "}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--accent)" }}
            className="underline"
          >
            console.anthropic.com
          </a>
          . For safety the key is read from your <span className="font-mono">.env</span> file and
          isn't editable here — this page only shows whether it's set.
        </p>

        {apiKeyStatus?.configured ? (
          <div
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg"
            style={{ backgroundColor: "var(--accent-bg)", border: "1px solid var(--accent)" }}
          >
            <span style={{ color: "var(--accent)" }}>✓</span>
            <span className="text-sm font-medium" style={{ color: "var(--accent)" }}>Configured</span>
            <span className="flex-1 min-w-0 break-all text-xs font-mono" style={{ color: "var(--text-secondary)" }}>
              {apiKeyStatus.masked}
            </span>
            <span className="text-[10px] shrink-0" style={{ color: "var(--text-tertiary)" }}>
              from {apiKeyStatus.source || ".env"}
            </span>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Status: not set */}
            <div
              className="flex items-center gap-2 px-3 py-2.5 rounded-lg"
              style={{ backgroundColor: "#fef2f2", border: "1px solid #fca5a5" }}
            >
              <span style={{ color: "#dc2626" }}>✗</span>
              <span className="text-sm font-medium" style={{ color: "#dc2626" }}>Not set</span>
            </div>
            {/* How to set it (via .env, not the UI) */}
            <div className="text-xs px-1 space-y-1.5" style={{ color: "var(--text-secondary)" }}>
              <p>Add your key to the <span className="font-mono">.env</span> file, then restart Nowspace:</p>
              <pre
                className="font-mono text-[11px] px-2 py-1.5 rounded overflow-x-auto"
                style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
              >ANTHROPIC_API_KEY=sk-ant-...</pre>
              <p>
                <span className="font-mono">.env</span> lives in the project root (when running <span className="font-mono">start.sh</span>)
                or <span className="font-mono">~/.nowspace/.env</span> (desktop app). It's git-ignored and never sent to the browser.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* ================================================================ */}
      {/* Diary                                                            */}
      {/* ================================================================ */}
      <section
        className="rounded-xl p-5 sm:p-6"
        style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}
      >
        <h2 className="text-base font-semibold mb-1" style={{ color: "var(--text)" }}>
          Diary
        </h2>
        <p className="text-xs mb-3" style={{ color: "var(--text-secondary)" }}>
          Vault folder for daily diary files (<span className="font-mono">&lt;date&gt; diary.md</span>).
          Shown as a Diary button in day view; leave empty to hide the feature.
          Stored in <span className="font-mono">Plan Week Configuration.md</span>, shared by every installation.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={diaryFolder}
            onChange={(e) => { setDiaryFolder(e.target.value); setDiaryFolderSaved(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") { api.saveDiaryFolder(diaryFolder.trim()).then(() => setDiaryFolderSaved(true)).catch(() => flash("err", "Failed to save diary folder")); } }}
            placeholder="2-Areas/Personal/Diary"
            className="flex-1 min-w-0 text-sm px-3 py-2 rounded-lg font-mono outline-none focus:ring-1 focus:ring-blue-400"
            style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}
          />
          <button
            onClick={() => api.saveDiaryFolder(diaryFolder.trim()).then(() => setDiaryFolderSaved(true)).catch(() => flash("err", "Failed to save diary folder"))}
            className="px-3 py-2 rounded-lg text-sm font-medium text-white shrink-0"
            style={{ backgroundColor: "var(--accent)" }}
          >
            {diaryFolderSaved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </section>

      {/* ================================================================ */}
      {/* Reference Groups                                                 */}
      {/* ================================================================ */}
      <section
        className="rounded-xl p-5 sm:p-6"
        style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
            Reference Groups
          </h2>
          {Object.keys(referenceLinks).length > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full" style={{
              backgroundColor: "var(--accent-bg)", color: "var(--accent)"
            }}>
              {Object.keys(referenceLinks).length}
            </span>
          )}
        </div>
        <p className="text-xs mb-4" style={{ color: "var(--text-secondary)" }}>
          Stored in <span className="font-mono">Plan Week Configuration.md</span> in the vault, so every installation shares them. Map group names to vault folders for project files and notes.
        </p>

        {/* Existing links */}
        <div className="space-y-2 mb-4">
          {Object.entries(referenceLinks).map(([key, path]) => (
            <div
              key={key}
              className="flex items-center gap-2 px-3 py-2.5 rounded-lg"
              style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)" }}
            >
              <span className="font-semibold text-sm w-28 shrink-0 capitalize" style={{ color: "var(--text)" }}>
                {key}
              </span>
              {editingKey === key ? (
                <>
                  <input
                    type="text"
                    value={editPath}
                    onChange={(e) => setEditPath(e.target.value)}
                    className="flex-1 min-w-0 px-2 py-1 rounded text-xs font-mono"
                    style={{
                      backgroundColor: "var(--bg-secondary)",
                      color: "var(--text)",
                      border: "1px solid var(--border)",
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") saveEditLink(key); if (e.key === "Escape") { setEditingKey(null); setEditPath(""); } }}
                    autoFocus
                  />
                  <button
                    onClick={() => openVaultBrowser(key, editPath.split("/").slice(0, -1).join("/"))}
                    className="px-2 py-1 rounded text-xs"
                    style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
                    title="Browse vault folders"
                  >
                    📁
                  </button>
                  <button
                    onClick={() => saveEditLink(key)}
                    className="px-2.5 py-1 rounded text-xs font-medium"
                    style={{ backgroundColor: "var(--accent)", color: "white" }}
                  >
                    Save
                  </button>
                  <button
                    onClick={() => { setEditingKey(null); setEditPath(""); }}
                    className="px-2 py-1 rounded text-xs"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-xs font-mono truncate" style={{ color: "var(--text-secondary)" }}>
                    {path}
                  </span>
                  <button
                    onClick={() => { setEditingKey(key); setEditPath(path); }}
                    className="px-2 py-1 rounded text-xs transition-colors"
                    style={{ color: "var(--text-tertiary)" }}
                    title="Edit path"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={() => deleteLink(key)}
                    className="px-2 py-1 rounded text-xs transition-colors"
                    style={{ color: "#ef4444" }}
                    title="Remove"
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}
          {Object.keys(referenceLinks).length === 0 && (
            <div
              className="text-center py-6 rounded-lg"
              style={{ backgroundColor: "var(--bg)", border: "1px dashed var(--border)" }}
            >
              <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
                No reference groups configured.
              </p>
              <p className="text-xs mt-1" style={{ color: "var(--text-tertiary)" }}>
                Add groups below to map them to vault folders.
              </p>
            </div>
          )}
        </div>

        {/* Add new link */}
        <div
          className="flex items-center flex-wrap gap-2 px-3 py-2.5 rounded-lg"
          style={{ backgroundColor: "var(--bg)", border: "1px dashed var(--border)" }}
        >
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Group name"
            className="w-28 shrink-0 px-2 py-1.5 rounded text-sm"
            style={{
              backgroundColor: "var(--bg-secondary)",
              color: "var(--text)",
              border: "1px solid var(--border)",
            }}
          />
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="Vault folder path (e.g. 2-Areas/Project)"
            className="flex-1 min-w-0 px-2 py-1.5 rounded text-xs font-mono"
            style={{
              backgroundColor: "var(--bg-secondary)",
              color: "var(--text)",
              border: "1px solid var(--border)",
            }}
            onKeyDown={(e) => { if (e.key === "Enter") addLink(); }}
          />
          <button
            onClick={() => openVaultBrowser("__new__")}
            className="px-2 py-1 rounded text-xs"
            style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
            title="Browse vault folders"
          >
            📁
          </button>
          <button
            onClick={addLink}
            disabled={!newName.trim() || !newPath.trim() || saving}
            className="px-3 py-1.5 rounded text-sm font-medium transition-colors"
            style={{
              backgroundColor: newName.trim() && newPath.trim() ? "var(--accent)" : "var(--bg-tertiary)",
              color: newName.trim() && newPath.trim() ? "white" : "var(--text-tertiary)",
            }}
          >
            + Add
          </button>
        </div>
      </section>

      {/* ================================================================ */}
      {/* Contexts                                                         */}
      {/* ================================================================ */}
      <section
        className="rounded-xl p-5 sm:p-6"
        style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
            Contexts
          </h2>
          {/* One status element: the button label narrates the state */}
          <button
            onClick={() => saveContexts(ctxRows)}
            disabled={ctxSaving || !ctxDirty}
            className="px-3 py-1 rounded-lg text-xs font-medium"
            style={ctxDirty
              ? { backgroundColor: "var(--accent)", color: "white" }
              : { backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
            title={ctxDirty ? "Save changes (Enter in a field also saves)" : "All changes saved"}
          >
            {ctxSaving ? "Saving…" : ctxDirty ? "Save changes" : "Saved ✓"}
          </button>
        </div>
        <p className="text-xs mb-4" style={{ color: "var(--text-secondary)" }}>
          Stored in <span className="font-mono">Plan Week Configuration.md</span> in the vault, shared by every installation. Each context has a single-letter tag
          (used as <span className="font-mono">@w</span> in task text) and a list of task group prefixes.
          Unknown tags typed in tasks (e.g. <span className="font-mono">@f</span>) are created automatically —
          rename them here. Work, volunteer and personal are built in; ungrouped tasks are personal.
        </p>

        <div className="space-y-2 mb-3">
          <div className="flex items-center gap-2 px-3 text-[10px] uppercase tracking-wide" style={{ color: "var(--text-tertiary)" }}>
            <span className="w-10">Tag</span>
            <span className="w-28">Name</span>
            <span className="flex-1">Groups (comma-separated)</span>
          </div>
          {ctxRows.map((row, i) => {
            const isCore = ["work", "volunteer", "personal"].includes(row.name);
            const update = (patch: Partial<CtxRow>) => {
              setCtxRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
              setCtxDirty(true);
            };
            return (
              <div
                key={i}
                className="flex items-center gap-2 px-3 py-2 rounded-lg"
                style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)" }}
              >
                <div className="w-10 flex items-center">
                  <span style={{ color: "var(--text-tertiary)" }} className="text-xs">@</span>
                  <input
                    type="text"
                    value={row.abbrev}
                    maxLength={1}
                    onKeyDown={(e) => { if (e.key === "Enter") saveContexts(ctxRows); }}
                    onChange={(e) => update({ abbrev: e.target.value.toLowerCase() })}
                    className="w-6 px-1 py-1 rounded text-xs font-mono text-center"
                    style={{ backgroundColor: "var(--bg-secondary)", color: "var(--text)", border: "1px solid var(--border)" }}
                  />
                </div>
                <input
                  type="text"
                  value={row.name}
                  disabled={isCore}
                  onKeyDown={(e) => { if (e.key === "Enter") saveContexts(ctxRows); }}
                  onChange={(e) => update({ name: e.target.value.toLowerCase() })}
                  className="w-28 px-2 py-1 rounded text-xs capitalize disabled:opacity-60"
                  style={{ backgroundColor: "var(--bg-secondary)", color: "var(--text)", border: "1px solid var(--border)" }}
                />
                <input
                  type="text"
                  value={row.groups}
                  placeholder={row.name === "personal" ? "everything unmapped is personal" : "e.g. arratech, wallet"}
                  onKeyDown={(e) => { if (e.key === "Enter") saveContexts(ctxRows); }}
                  onChange={(e) => update({ groups: e.target.value })}
                  className="flex-1 min-w-0 px-2 py-1 rounded text-xs font-mono"
                  style={{ backgroundColor: "var(--bg-secondary)", color: "var(--text)", border: "1px solid var(--border)" }}
                />
                {!isCore && (
                  <button
                    onClick={() => { setCtxRows((prev) => prev.filter((_, j) => j !== i)); setCtxDirty(true); }}
                    className="text-xs px-1"
                    style={{ color: "var(--text-tertiary)" }}
                    title="Remove context"
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          onClick={() => { setCtxRows((prev) => [...prev, { abbrev: "", name: "", groups: "" }]); setCtxDirty(true); }}
          className="text-xs px-3 py-1.5 rounded-lg"
          style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
        >
          + Add context
        </button>
      </section>

      {/* ================================================================ */}
      {/* Folder Browser Modal (shared)                                    */}
      {/* ================================================================ */}
      {browseTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
          onClick={closeBrowser}
        >
          <div
            className="rounded-xl p-5 w-full max-w-lg max-h-[70vh] flex flex-col"
            style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm" style={{ color: "var(--text)" }}>
                {browseTarget === "vault" ? "Select Vault Folder" : "Select Folder"}
              </h3>
              <button
                onClick={closeBrowser}
                className="text-sm px-2 py-1 rounded"
                style={{ color: "var(--text-secondary)" }}
              >
                ✕
              </button>
            </div>

            {/* Current path + Up button */}
            <div className="flex items-center gap-2 mb-2">
              {browseParent !== null && (
                <button
                  onClick={() => navigateBrowser(browseParent!)}
                  className="px-2 py-1 rounded text-xs font-medium shrink-0"
                  style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
                >
                  ⬆ Up
                </button>
              )}
              <span className="text-xs font-mono truncate" style={{ color: "var(--text-secondary)" }}>
                {browseMode === "system" ? browsePath : (browsePath || "/ (vault root)")}
              </span>
            </div>

            {/* Select current folder */}
            <button
              onClick={() => selectBrowserFolder(browsePath)}
              className="mb-2 px-3 py-2 rounded-lg text-xs font-medium text-left"
              style={{ backgroundColor: "var(--accent)", color: "white" }}
            >
              ✓ Select this folder{browsePath ? `: ${browseMode === "system" ? browsePath.split("/").pop() : browsePath.split("/").pop() || "vault root"}` : ""}
            </button>

            {/* Folder list */}
            <div className="flex-1 overflow-y-auto space-y-1">
              {browseLoading ? (
                <p className="text-xs py-4 text-center" style={{ color: "var(--text-tertiary)" }}>Loading...</p>
              ) : browseFolders.length === 0 ? (
                <p className="text-xs py-4 text-center" style={{ color: "var(--text-tertiary)" }}>No subfolders</p>
              ) : (
                browseFolders.map((f) => (
                  <div
                    key={f.path}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors"
                    style={{ backgroundColor: "var(--bg-secondary)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-tertiary)")}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-secondary)")}
                    onClick={() => navigateBrowser(f.path)}
                  >
                    <span className="flex-1 text-sm" style={{ color: "var(--text)" }}>
                      📁 {f.name}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); selectBrowserFolder(f.path); }}
                      className="px-2 py-0.5 rounded text-xs font-medium shrink-0"
                      style={{ backgroundColor: "var(--accent-bg)", color: "var(--accent)" }}
                    >
                      Select
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* About                                                            */}
      {/* ================================================================ */}
      <section
        className="rounded-xl p-5 sm:p-6"
        style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}
      >
        <h2 className="text-base font-semibold mb-2" style={{ color: "var(--text)" }}>
          About
        </h2>
        <div className="text-xs space-y-1" style={{ color: "var(--text-secondary)" }}>
          <p>Nowspace v{__APP_VERSION__}</p>
          <p>
            Calm personal planning on top of your Obsidian vault — week plan,
            bucket with horizons, habits, time tracking, notes and diary, all
            stored as plain markdown files you own.
          </p>
          <p>
            <a href="https://github.com/JanLin/coaching-agent/releases" target="_blank" rel="noreferrer"
              className="underline hover:opacity-80">Release notes</a>
          </p>
        </div>
      </section>
    </div>
  );
}

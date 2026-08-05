import React from "react";

/** A throwing extension panel costs a tab, not the application.
 *
 *  React unmounts the whole tree when a render throws and nothing catches it,
 *  which for a registered surface would mean an extension taking the week
 *  plan down with it. This catches at the tab boundary: the rest of Nowspace
 *  keeps working, the tab shows what happened, and the console gets the error
 *  once — not once per re-render.
 *
 *  The baseline has no other error boundary on purpose: a crash in the week
 *  plan is a bug to fix, and swallowing it would only hide it. Code from
 *  another repository is the case that warrants one. */
export default class SurfaceBoundary extends React.Component<
  { id: string; name: string; children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Once, with the id, so it is obvious which extension to go and look at
    console.error(`[nowspace] surface "${this.props.id}" failed`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="max-w-lg mx-auto text-center py-16 px-4" style={{ color: "var(--text-secondary)" }}>
        <div className="text-3xl mb-2">🧩</div>
        <p className="text-sm" style={{ color: "var(--text)" }}>{this.props.name} stopped working.</p>
        <p className="text-xs mt-1">
          The rest of Nowspace is unaffected. The error is in the console, from
          the <span className="font-mono">{this.props.id}</span> extension rather than the app itself.
        </p>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-3 text-xs px-2 py-1 rounded"
          style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
        >
          Try again
        </button>
      </div>
    );
  }
}

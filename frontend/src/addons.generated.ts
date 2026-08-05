/* Generated. The frontend half of backend/addons.py's list.
 *
 * An installed extension adds one line here:
 *
 *     import { register } from "@nowspace/relay";  register();
 *
 * A static import on purpose. `import()` from the backend origin would be
 * blocked by the Tauri CSP (`script-src 'self'`) and never execute, so a
 * runtime-loaded extension would work in the browser and silently not in the
 * desktop app — the worst of the two.
 *
 * Empty in the baseline, and empty is what ships: this file is the stub a
 * clean clone builds with. Regenerating it locally leaves it modified in
 * `git status` (a tracked file cannot be ignored); `git update-index
 * --skip-worktree frontend/src/addons.generated.ts` keeps that quiet on a
 * machine where an extension is installed.
 */

export {};

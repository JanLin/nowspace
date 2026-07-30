/** Auto-scroll while dragging near an edge.
 *
 *  Without this a drag can only reach what's already on screen: to move a task
 *  to a day further down the list, or a group past the fold, you had to drop
 *  it somewhere, scroll, and pick it up again.
 *
 *  Each dragover scrolls once, and a timer keeps scrolling while the pointer
 *  holds still near the edge — dragover stops firing when nothing moves, and
 *  holding still at the edge is exactly when you want it to continue. A timer
 *  rather than requestAnimationFrame so it also behaves in a backgrounded
 *  tab, where rAF is paused.
 *
 *  One document-level listener covers every drag in the app: tasks, groups,
 *  bucket rows, carry rows, vault notes. */

const BAND = 76;        // how close to the edge starts scrolling
const MAX_SPEED = 20;   // px per frame at the very edge

const TICK_MS = 16;

let timer: ReturnType<typeof setInterval> | 0 = 0;
let pointerY = 0;
let pointerX = 0;
let dragging = false;

/** The scrollbox under the pointer: a panel's own scroller if there is one,
    otherwise the page container. */
function scrollableAt(x: number, y: number): HTMLElement | null {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el && el !== document.body && el !== document.documentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 2) {
      return el;
    }
    el = el.parentElement;
  }
  const main = document.querySelector("main");
  return main && main.scrollHeight > main.clientHeight + 2 ? (main as HTMLElement) : null;
}

function step() {
  if (!dragging) return;
  const box = scrollableAt(pointerX, pointerY);
  if (box) {
    const r = box.getBoundingClientRect();
    const fromTop = pointerY - r.top;
    const fromBottom = r.bottom - pointerY;
    // Ease in: a gentle nudge at the edge of the band, full speed at the rim
    if (fromTop < BAND && fromTop > -BAND) {
      box.scrollTop -= Math.ceil(MAX_SPEED * Math.min(1, (BAND - fromTop) / BAND));
    } else if (fromBottom < BAND && fromBottom > -BAND) {
      box.scrollTop += Math.ceil(MAX_SPEED * Math.min(1, (BAND - fromBottom) / BAND));
    }
  }
}

function onDragOver(e: DragEvent) {
  pointerX = e.clientX;
  pointerY = e.clientY;
  dragging = true;
  step();                       // moving scrolls straight away
  if (!timer) timer = setInterval(step, TICK_MS);   // holding still keeps going
}

function stop() {
  dragging = false;
  if (timer) { clearInterval(timer); timer = 0; }
}

export function installDragAutoScroll() {
  document.addEventListener("dragover", onDragOver, { passive: true });
  document.addEventListener("drop", stop);
  document.addEventListener("dragend", stop);
  // A drag cancelled with Escape fires neither drop nor dragend in every engine
  window.addEventListener("blur", stop);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") stop(); });
}

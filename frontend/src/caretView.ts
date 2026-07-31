/** Where the caret sits inside a textarea, in pixels from the top of the box.
 *
 *  A textarea won't tell you, so we measure a hidden mirror div with the same
 *  box and font, holding the text up to the caret. Both note editors need it
 *  for the same reason: their textarea never scrolls internally (it grows to
 *  the full height of the note and an ancestor does the scrolling), so the
 *  browser's own "keep the caret in view" does nothing and the line being
 *  typed slides under the fold. */

let mirror: HTMLDivElement | null = null;

export function caretOffsetTop(ta: HTMLTextAreaElement): number {
  const cs = getComputedStyle(ta);
  if (!mirror) {
    mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    document.body.appendChild(mirror);
  }
  Object.assign(mirror.style, {
    position: "absolute", visibility: "hidden", left: "-9999px", top: "0",
    whiteSpace: "pre-wrap", overflowWrap: "break-word", boxSizing: cs.boxSizing,
    width: `${ta.clientWidth}px`,
    font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`,
    letterSpacing: cs.letterSpacing, padding: cs.padding, border: "0",
  } as CSSStyleDeclaration);
  mirror.textContent = ta.value.slice(0, ta.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  return marker.offsetTop;
}

/** Bottom of what the user can actually see — the on-screen keyboard is
 *  outside visualViewport, which is the whole point of asking it. */
export function visibleViewportBottom(): number {
  const vv = window.visualViewport;
  return vv ? vv.offsetTop + vv.height : window.innerHeight;
}

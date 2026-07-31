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
    // Copied because a phone applies them and a mismatch here wraps the
    // mirror differently from the real box — which on a long note compounds
    // line by line until the measurement points somewhere else entirely.
    textIndent: cs.textIndent, wordBreak: cs.wordBreak, tabSize: cs.tabSize,
    textTransform: cs.textTransform,
    // Mobile browsers inflate text in some boxes and not others; pinning it
    // off keeps the mirror and the textarea at the same size.
    WebkitTextSizeAdjust: "100%", textSizeAdjust: "100%",
  } as unknown as CSSStyleDeclaration);
  mirror.textContent = ta.value.slice(0, ta.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  return marker.offsetTop;
}

/** The caret's rectangle measured off a rendered copy of the same text —
 *  exact, because it asks the browser where a character actually is rather
 *  than rebuilding the wrapping and hoping it matches. The markdown editor
 *  paints a highlighted <pre> behind its textarea, in the same box with the
 *  same wrapping, which is that copy. Returns null when the overlay isn't
 *  there or doesn't reach the caret; the mirror above is the fallback. */
export function caretRectFromOverlay(container: HTMLElement, pos: number): DOMRect | null {
  const pre = container.querySelector<HTMLElement>(".w-md-editor-text-pre");
  if (!pre) return null;
  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let node: Node | null = null;
  let offset = 0;
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0;
    if (seen + len >= pos) { offset = pos - seen; break; }
    seen += len;
  }
  if (!node) return null;
  const range = document.createRange();
  try {
    range.setStart(node, offset);
    range.setEnd(node, offset);
    let rect = range.getBoundingClientRect();
    // A collapsed range at a line break measures as nothing. Widen it by a
    // character — forwards first, and backwards when the caret sits at the
    // end of its node, which is exactly where a line ends.
    const len = node.textContent?.length ?? 0;
    if (rect.height === 0 && offset < len) {
      range.setEnd(node, offset + 1);
      rect = range.getBoundingClientRect();
    }
    if (rect.height === 0 && offset > 0) {
      range.setStart(node, offset - 1);
      range.setEnd(node, offset);
      rect = range.getBoundingClientRect();
    }
    return rect.height > 0 ? rect : null;
  } catch {
    return null;
  }
}

/** Bottom of what the user can actually see — the on-screen keyboard is
 *  outside visualViewport, which is the whole point of asking it. */
export function visibleViewportBottom(): number {
  const vv = window.visualViewport;
  return vv ? vv.offsetTop + vv.height : window.innerHeight;
}

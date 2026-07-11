// CSS-drawn check circle with fixed pixel dimensions. The previous Unicode
// ○/✓ glyphs rendered at wildly different sizes depending on the platform
// font (a tiny "o" in Chrome/Android vs the Mac app's WebKit) and the light
// gray was barely visible. The ring picks up currentColor from the wrapping
// button, so existing hover color classes keep working.
export default function TaskCheck({ done, size = 14 }: { done: boolean; size?: number }) {
  return done ? (
    <span
      className="inline-flex items-center justify-center rounded-full bg-green-500 text-white font-bold select-none"
      style={{ width: size, height: size, fontSize: size * 0.62, lineHeight: 1 }}
    >
      ✓
    </span>
  ) : (
    <span
      className="inline-block rounded-full"
      style={{ width: size, height: size, border: "2px solid currentColor" }}
    />
  );
}

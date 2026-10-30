// The application mark (DESIGN-SPEC 2.4): a signal-filled rounded rectangle
// holding two white eyes, styled by `.pt-brand-mark`. Decorative; the wordmark
// or the surrounding link carries the name.
export function AppMark() {
  return (
    <span className="pt-brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <ellipse cx="8.6" cy="12" rx="2.2" ry="3" fill="currentColor" />
        <ellipse cx="15.4" cy="12" rx="2.2" ry="3" fill="currentColor" />
      </svg>
    </span>
  );
}

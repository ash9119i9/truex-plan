// .tx-kbd and .tx-keys (DESIGN-SPEC 9.5). The ⌘/Ctrl swap and "then" sequences
// are the caller's job, not the primitive's.
export function Keycap({ children }: { children: string }) {
  return <kbd className="tx-kbd">{children}</kbd>;
}

export function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="tx-keys">
      {keys.map((key, i) => (
        <Keycap key={i}>{key}</Keycap>
      ))}
    </span>
  );
}

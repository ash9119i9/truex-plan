// Joins class names, skipping empty ones (replaces clsx for the tx layer).
export const classes = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(" ");

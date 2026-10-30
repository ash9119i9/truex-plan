# Settings, shortcuts sheet, command palette, Help

Status: open · Design · Added 2026-10-28 · Spec 19.4, 11.10, 10.6, 19.5 M10

## Gap

- **Settings** (⌘,): labelled in the chat study, with no handler and no screen.
- **Keyboard shortcuts sheet** (?): labelled, with no handler and no screen.
- **Command palette** (⌘K): the pattern exists (`.pt-palette`, 10.6), but the chat study doesn't wire it.
- **Help**: marked Soon.

## Do

- Settings: decide what it holds. Theme, contrast and text size are already chosen per device (2.3). Others could include account, workspace and connected tools.
- Shortcuts sheet: build it from the keyboard map in 11.10 so the two can't drift.
- Palette: decide its commands and what it searches (chats, agents, actions).
- Help: decide whether it's in-app content or a link out.
- Bind ⌘K, ⌘, and ?, and keep `aria-keyshortcuts` only on bound chords (M10).

## Done when

Each has a screen study and a spec section, and every labelled shortcut opens a real destination.

"use client";
// Sidebar "Projects" section: folders that group conversations, plus the
// per-conversation "⋯" menu used in Recents and inside projects.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ChevronLeft,
  Folder,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  checkProjectName,
  createProject,
  deleteProject,
  listProjects,
  listProjectSessions,
  renameProject,
  sessionProjectActions,
  setSessionProject,
  sortProjects,
} from "@/lib/projects";
import { userMessage, warnFailure } from "@/lib/api";
import type { Project, PublicSession } from "../../shared/contracts";

// ---------- State ----------

export interface ProjectsState {
  projects: Project[];
  expanded: string[];
  byProject: Record<string, PublicSession[]>;
  error: string;
  clearError: () => void;
  // The last background refresh of projects failed; the list may be stale.
  refreshFailed: boolean;
  toggle: (id: string) => void;
  expand: (id: string) => void;
  refreshAll: () => void;
  create: (name: string) => Promise<Project | null>;
  rename: (id: string, name: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  assign: (
    sessionId: string,
    projectId: string | null,
  ) => Promise<PublicSession | null>;
}

// Owns project data. `refreshSessions` reloads the Recents list so every
// mutation leaves projects, Recents and open folders in sync.
export function useProjects(refreshSessions: () => unknown): ProjectsState {
  const [projects, setProjects] = useState<Project[]>([]),
    [expanded, setExpanded] = useState<string[]>([]),
    [byProject, setByProject] = useState<Record<string, PublicSession[]>>({}),
    [error, setError] = useState(""),
    [refreshFailed, setRefreshFailed] = useState(false);
  // Latest-request-wins tokens, like `generation` in page.tsx.
  const listToken = useRef(0),
    projectTokens = useRef(new Map<string, number>()),
    expandedRef = useRef<string[]>([]),
    refreshSessionsRef = useRef(refreshSessions);
  expandedRef.current = expanded;
  refreshSessionsRef.current = refreshSessions;

  const loadProject = useCallback(async (id: string) => {
    const token = (projectTokens.current.get(id) || 0) + 1;
    projectTokens.current.set(id, token);
    try {
      const list = await listProjectSessions(id);
      if (projectTokens.current.get(id) !== token) return;
      setByProject((old) => ({ ...old, [id]: list }));
    } catch (e) {
      warnFailure("project conversations", e);
      if (projectTokens.current.get(id) !== token) return;
      setByProject((old) => ({ ...old, [id]: old[id] || [] }));
    }
  }, []);
  const refreshProjects = useCallback(async () => {
    const token = ++listToken.current;
    try {
      const list = sortProjects(await listProjects());
      if (token !== listToken.current) return;
      setProjects(list);
      const ids = new Set(list.map((p) => p._id));
      setExpanded((old) => old.filter((id) => ids.has(id)));
      setRefreshFailed(false);
    } catch (e) {
      // The sidebar keeps its last list when the service is unreachable.
      warnFailure("project list", e);
      if (token === listToken.current) setRefreshFailed(true);
    }
  }, []);
  const refreshAll = useCallback(() => {
    void refreshProjects();
    void refreshSessionsRef.current();
    for (const id of expandedRef.current) void loadProject(id);
  }, [refreshProjects, loadProject]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const expand = useCallback(
    (id: string) => {
      setExpanded((old) => (old.includes(id) ? old : [...old, id]));
      void loadProject(id);
    },
    [loadProject],
  );
  const toggle = useCallback(
    (id: string) => {
      if (expandedRef.current.includes(id))
        setExpanded((old) => old.filter((x) => x !== id));
      else expand(id);
    },
    [expand],
  );

  // Mutations report failures in the sidebar and never throw.
  async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
    setError("");
    try {
      return await run();
    } catch (e) {
      setError(userMessage(e, "The change could not be saved."));
      return null;
    } finally {
      refreshAll();
    }
  }
  return {
    projects,
    expanded,
    byProject,
    error,
    clearError: () => setError(""),
    refreshFailed,
    toggle,
    expand,
    refreshAll,
    create: (name) => attempt(() => createProject(name)),
    rename: async (id, name) =>
      (await attempt(() => renameProject(id, name))) !== null,
    remove: async (id) => {
      const done = (await attempt(() => deleteProject(id))) !== null;
      if (done) setExpanded((old) => old.filter((x) => x !== id));
      return done;
    },
    assign: async (sessionId, projectId) => {
      const updated = await attempt(() =>
        setSessionProject(sessionId, projectId),
      );
      if (updated && projectId) expand(projectId);
      return updated;
    },
  };
}

// ---------- Menu primitive ----------

const MENU_WIDTH = 208;

function menuItems(menu: HTMLElement | null) {
  return Array.from(
    menu?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled), input',
    ) || [],
  );
}

// A small accessible popover menu. Fixed positioning keeps it clear of the
// sidebar's scroll clipping; it closes on Escape, outside click, or scroll.
function Menu({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled?: boolean;
  children: (menu: { close: () => void; focusFirst: () => void }) => ReactNode;
}) {
  const [open, setOpen] = useState(false),
    [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  }, []);
  const focusFirst = useCallback(() => {
    requestAnimationFrame(() => menuItems(menu.current)[0]?.focus());
  }, []);
  function place() {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      top: r.bottom + 4,
      left: Math.max(
        8,
        Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8),
      ),
    });
  }
  // Flip above the trigger when the menu would run off the bottom.
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const box = menu.current.getBoundingClientRect(),
      r = trigger.current.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 8 && r.top - box.height - 4 > 8)
      setPos((p) => p && { ...p, top: r.top - box.height - 4 });
  }, [open, pos?.left]);
  useEffect(() => {
    if (!open) return;
    focusFirst();
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !trigger.current?.contains(t))
        close(false);
    };
    const dismiss = () => close(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open, close, focusFirst]);
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return close();
    }
    if (e.key === "Tab") return close(false);
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const items = menuItems(menu.current);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown"
        ? (at + 1) % items.length
        : e.key === "ArrowUp"
          ? (at - 1 + items.length) % items.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? items.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="row-action"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (open) return close();
          place();
          setOpen(true);
        }}
        onKeyDown={(e) => {
          // Focus can still be on the trigger (before the menu takes it).
          if (e.key === "Escape" && open) {
            e.preventDefault();
            return close();
          }
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            place();
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {open && pos && (
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          className="menu"
          style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
          onKeyDown={onKeyDown}
        >
          {children({ close, focusFirst })}
        </div>
      )}
    </>
  );
}

function MenuItem({
  icon,
  children,
  onSelect,
  danger,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={danger ? "menu-item danger" : "menu-item"}
      onClick={onSelect}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

// ---------- Inline name input ----------

function NameInput({
  initial = "",
  label,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  label: string;
  onSubmit: (name: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const errorId = useRef(
    `project-name-error-${Math.random().toString(36).slice(2)}`,
  ).current;
  async function submit() {
    const check = checkProjectName(value);
    if (!check.ok) return setError(check.error);
    if (check.name === initial.trim()) return onCancel();
    setSaving(true);
    await onSubmit(check.name);
    setSaving(false);
  }
  return (
    <div className="project-name-input">
      <input
        autoFocus
        aria-label={label}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        value={value}
        disabled={saving}
        maxLength={120}
        placeholder="Project name"
        onChange={(e) => {
          setValue(e.target.value);
          setError("");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        onBlur={() => !saving && onCancel()}
      />
      {error && (
        <small id={errorId} role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

// ---------- Conversation menu ----------

export function SessionMenu({
  session,
  state,
  disabled,
  onUpdated,
}: {
  session: PublicSession;
  state: ProjectsState;
  disabled?: boolean;
  onUpdated?: (session: PublicSession) => void;
}) {
  const title = session.title || "New conversation";
  return (
    <span className="row-menu">
      <Menu label={`Options for ${title}`} disabled={disabled}>
        {(menu) => (
          <SessionMenuContent
            session={session}
            state={state}
            onUpdated={onUpdated}
            {...menu}
          />
        )}
      </Menu>
    </span>
  );
}

function SessionMenuContent({
  session,
  state,
  onUpdated,
  close,
  focusFirst,
}: {
  session: PublicSession;
  state: ProjectsState;
  onUpdated?: (session: PublicSession) => void;
  close: () => void;
  focusFirst: () => void;
}) {
  const [view, setView] = useState<"root" | "pick" | "new">("root");
  const actions = sessionProjectActions(session, state.projects);
  useEffect(() => {
    if (view !== "new") focusFirst();
  }, [view, focusFirst]);
  async function assign(projectId: string | null) {
    close();
    const updated = await state.assign(session._id, projectId);
    if (updated)
      onUpdated?.({
        ...session,
        ...updated,
        projectId: projectId || undefined,
      });
  }
  if (view === "new")
    return (
      <NameInput
        label="New project name"
        onCancel={() => setView("pick")}
        onSubmit={async (name) => {
          const created = await state.create(name);
          if (created) await assign(created._id);
        }}
      />
    );
  if (view === "pick")
    return (
      <>
        <MenuItem
          icon={<ChevronLeft size={14} aria-hidden="true" />}
          onSelect={() => setView("root")}
        >
          Back
        </MenuItem>
        <div className="menu-sep" role="separator" />
        {actions.targets.map((p) => (
          <MenuItem
            key={p._id}
            icon={<Folder size={14} aria-hidden="true" />}
            onSelect={() => void assign(p._id)}
          >
            {p.name}
          </MenuItem>
        ))}
        <MenuItem
          icon={<FolderPlus size={14} aria-hidden="true" />}
          onSelect={() => setView("new")}
        >
          New project…
        </MenuItem>
      </>
    );
  return (
    <>
      {actions.current && (
        <div className="menu-heading">In {actions.current.name}</div>
      )}
      <MenuItem
        icon={<FolderInput size={14} aria-hidden="true" />}
        onSelect={() => setView("pick")}
      >
        {actions.mode === "add" ? "Add to project" : "Move to project"}
      </MenuItem>
      {actions.canRemove && (
        <MenuItem
          icon={<FolderMinus size={14} aria-hidden="true" />}
          onSelect={() => void assign(null)}
        >
          Remove from project
        </MenuItem>
      )}
    </>
  );
}

// ---------- Projects section ----------

export function ProjectSidebar({
  state,
  sessions,
  currentSessionId,
  busy,
  onOpen,
  onNewChat,
  onDeleted,
  onSessionUpdated,
}: {
  state: ProjectsState;
  // The Recents list; fresher titles and moves from it win over folder data.
  sessions: PublicSession[];
  currentSessionId?: string;
  busy?: boolean;
  onOpen: (id: string) => void;
  onNewChat: (projectId: string) => void;
  onDeleted?: (projectId: string) => void;
  onSessionUpdated?: (session: PublicSession) => void;
}) {
  const [creating, setCreating] = useState(false),
    [renaming, setRenaming] = useState<string | null>(null);
  const recent = new Map(sessions.map((s) => [s._id, s]));
  // Folder lists decide membership (they are refetched after every move);
  // Recents only supplies fresher titles and goals.
  function projectSessions(id: string) {
    const list = state.byProject[id];
    if (!list) return undefined;
    return list.map((s) => {
      const r = recent.get(s._id);
      return r ? { ...s, title: r.title, goal: r.goal } : s;
    });
  }
  return (
    <section className="project-section" aria-label="Projects">
      <div className="sidebar-label">
        Projects
        <button
          type="button"
          className="row-action visible"
          aria-label="New project"
          title="New project"
          onClick={() => {
            state.clearError();
            setCreating(true);
          }}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>
      {state.error && (
        <p className="sidebar-error" role="alert">
          {state.error}
        </p>
      )}
      {state.refreshFailed && !state.error && (
        <p className="sidebar-refresh-error" role="alert">
          Couldn’t refresh ·{" "}
          <button
            type="button"
            className="inline-retry"
            onClick={() => state.refreshAll()}
          >
            Retry
          </button>
        </p>
      )}
      <ul className="project-list">
        {creating && (
          <li>
            <NameInput
              label="New project name"
              onCancel={() => setCreating(false)}
              onSubmit={async (name) => {
                const created = await state.create(name);
                if (created) setCreating(false);
              }}
            />
          </li>
        )}
        {!creating && !state.projects.length && (
          <li className="sidebar-empty">No projects yet.</li>
        )}
        {state.projects.map((p) => {
          const open = state.expanded.includes(p._id);
          const list = open ? projectSessions(p._id) : undefined;
          const listId = `project-${p._id}-sessions`;
          return (
            <li key={p._id} className="project-item">
              {renaming === p._id ? (
                <NameInput
                  initial={p.name}
                  label={`Rename ${p.name}`}
                  onCancel={() => setRenaming(null)}
                  onSubmit={async (name) => {
                    if (await state.rename(p._id, name)) setRenaming(null);
                  }}
                />
              ) : (
                <div className="session-row project-row">
                  <button
                    type="button"
                    className="session-link project-toggle"
                    aria-expanded={open}
                    aria-controls={open ? listId : undefined}
                    onClick={() => state.toggle(p._id)}
                  >
                    {open ? (
                      <FolderOpen size={14} aria-hidden="true" />
                    ) : (
                      <Folder size={14} aria-hidden="true" />
                    )}
                    <span>
                      <b>{p.name}</b>
                    </span>
                  </button>
                  <span className="row-menu">
                    <button
                      type="button"
                      className="row-action"
                      aria-label={`New chat in ${p.name}`}
                      title="New chat in project"
                      disabled={busy}
                      onClick={() => onNewChat(p._id)}
                    >
                      <Plus size={14} aria-hidden="true" />
                    </button>
                    <Menu label={`Options for project ${p.name}`}>
                      {({ close }) => (
                        <>
                          <MenuItem
                            icon={<Pencil size={14} aria-hidden="true" />}
                            onSelect={() => {
                              close();
                              state.clearError();
                              setRenaming(p._id);
                            }}
                          >
                            Rename
                          </MenuItem>
                          <MenuItem
                            danger
                            icon={<Trash2 size={14} aria-hidden="true" />}
                            onSelect={async () => {
                              close();
                              if (
                                !window.confirm(
                                  `Delete project “${p.name}”? Conversations will stay in Recents.`,
                                )
                              )
                                return;
                              if (await state.remove(p._id)) onDeleted?.(p._id);
                            }}
                          >
                            Delete
                          </MenuItem>
                        </>
                      )}
                    </Menu>
                  </span>
                </div>
              )}
              {open && (
                <ul id={listId} className="project-sessions">
                  {!list && <li className="sidebar-empty">Loading…</li>}
                  {list && !list.length && (
                    <li className="sidebar-empty">No conversations yet.</li>
                  )}
                  {list?.map((s) => (
                    <li key={s._id} className="session-row">
                      <button
                        type="button"
                        className={
                          currentSessionId === s._id
                            ? "session-link selected"
                            : "session-link"
                        }
                        aria-current={
                          currentSessionId === s._id ? "page" : undefined
                        }
                        disabled={busy}
                        onClick={() => onOpen(s._id)}
                      >
                        <span>
                          <b>{s.title || "New conversation"}</b>
                        </span>
                      </button>
                      <SessionMenu
                        session={s}
                        state={state}
                        disabled={busy}
                        onUpdated={onSessionUpdated}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiRequestError, userMessage, warnFailure } from "@/lib/api";
import { CHAT_MIN, fitPanel, PANEL_W } from "@/lib/fit-panel";
import { FOLD, useLayoutWidth } from "@/lib/layout-width";
import { useExit } from "@/lib/use-exit";
import {
  cachedFileContent,
  downloadFile,
  fetchChatFiles,
  isImage,
  parseFiles,
  retryUnsavedFiles,
  seedFileContent,
  withFiles,
  type ChatFile,
} from "@/lib/tenant-files";
import {
  defaultAgent,
  fetchTenantAgents,
  fetchTenantModels,
  groupAgents,
  withAgent,
  type TenantAgent,
  type TenantModel,
} from "@/lib/tenant-agents";
import {
  applyStreamEvent,
  archiveChat,
  canSendMessage,
  chatParam,
  exchangesOf,
  fetchChat,
  fetchChats,
  fetchOlderMessages,
  liveReply,
  messageIds,
  outcomeNote,
  parseSaved,
  pendingRunId,
  pendingThread,
  readOnlyNote,
  renameChat,
  replyEnded,
  sendFailure,
  sendMessage,
  startChat,
  stopRun,
  withChat,
  withOlder,
  withPending,
  withReceipt,
  withSaved,
  withSteer,
  withLiveSteer,
  withApproval,
  withApprovalRace,
  withNetworkDecision,
  hasPendingApproval,
  dropSteer,
  type ChatSummary,
  type ChatThread,
  type LiveReply,
  type FollowUpOrigin,
  type PendingSend,
  type RunningReply,
  type SendFailure,
} from "@/lib/tenant-chat";
import type { FollowUpItem } from "@/lib/suggestions";
import { followRun } from "@/lib/tenant-chat-stream";
import {
  discardUpload,
  fetchUploadSettings,
  fileProblem,
  pendingAttachments,
  uploadFile,
  uploadIds,
  UPLOADS_OFF,
  withDraftFile,
  previewSeeds,
  type DraftFile,
  type UploadSettings,
} from "@/lib/tenant-uploads";
import {
  connectCardText,
  connectionRequired,
  postApproval,
  RETURN_KEY,
  startConnect,
  type ApprovalAnswer,
  type ConnectionRequired,
} from "@/lib/tenant-connectors";
import { Panel } from "@/components/v2/shell";
import { Hero } from "@/components/v2/hero";
import { Icon } from "@/components/tx/icon";
import { Button } from "@/components/tx/button";
import {
  useWorkspace,
  WorkspaceSidebar,
  WorkspaceStage,
} from "@/components/auth/tenant-workspace";
import { AgentPick, dockAgentMenu } from "./agent-picker";
import { TeamBoard } from "./team-board";
import { TenantAgentDialog } from "./tenant-agent-dialog";
import { ChatList } from "./chat-list";
import { ChatComposer } from "./chat-composer";
import { ChatTopbar } from "./chat-topbar";
import {
  NetworkActionsContext,
  Transcript,
  type Connection,
  type NetworkActions,
} from "./chat-transcript";
import {
  postNetworkDecision,
  type NetworkDecision,
} from "@/lib/tenant-network";
import {
  FileActionsContext,
  type FileActions,
  type RetryState,
  type ViewerTarget,
} from "./file-card";
import { FileViewer } from "./file-viewer";
import { CommandPalette } from "./command-palette";
import { FloatingDock } from "./floating-dock";
import { ActivityPanel } from "@/components/activity/panel";
import { turnView, type TurnView } from "@/lib/activity";
import { RequestDock } from "./request-dock";
import { useFocusTrap } from "@/lib/focus-trap";
import { ariaKeys, useShortcuts } from "@/lib/shortcuts";
import type { PaletteItem } from "@/lib/palette";
import "@/styles/app/tools.css";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready" };

// The draft and send notes of the new-chat screen are kept under this key;
// an open chat's under its ID.
const NEW = "new";
// Files uploading at once; the platform takes three per member.
const UPLOADS_AT_ONCE = 2;

// A picked image is kept with its chip, so it can be shown before (and
// without) any download.
const imagePreview = (file: File, name: string): { preview?: Blob } =>
  isImage(name) ? { preview: file } : {};

const sidebarNode = () => document.querySelector<HTMLElement>(".cs-sidebar");

/**
 * The tenant chat page: the member's chats in the sidebar, and either a new
 * chat (pick an agent, write the first message) or an open chat with its
 * history and live reply. The open chat is in the URL (?chat=), so refreshing
 * reopens it and a reply in progress is followed again from its snapshot.
 */
export function TenantChat() {
  const { me, actions, setNew } = useWorkspace();
  const router = useRouter();
  // The URL this page opened at. Read from the router, not window.location:
  // on a client navigation here the page renders before the address changes.
  const searchParams = useSearchParams();
  // A fresh object on every session check; the stream must not refollow.
  const recheck = useRef(actions.recheck);
  recheck.current = actions.recheck;
  // The room the shell has at the current text size (DESIGN-SPEC 11.11);
  // at or below the sidebar fold the sidebar is a drawer.
  const layoutW = useLayoutWidth();
  const narrow = layoutW <= FOLD.sidebar;
  // At or below the activity fold the Activity Panel and its dock key are
  // hidden (DESIGN-SPEC 11.11); 150% and 200% text reach it on a laptop.
  const activityFits = layoutW > FOLD.activity;
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [narrow]);
  // Wide screens: ⌘B or the toggle hides the sidebar (DESIGN-SPEC 11.10).
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The Activity Panel and the turn it shows (null: the latest).
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityTurn, setActivityTurn] = useState<number | null>(null);
  // Expanded to the wide size (legacy session panel "max").
  const [activityWide, setActivityWide] = useState(false);
  // The floating dock is raised; the composer reserves its height meanwhile.
  const [dockUp, setDockUp] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [announcement, setAnnouncement] = useState("");

  // ---- Agents, for new chats ----
  const [agentsLoad, setAgentsLoad] = useState<Load>({ state: "loading" });
  const [agents, setAgents] = useState<TenantAgent[]>([]);
  const [models, setModels] = useState<TenantModel[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // "Browse all agents" shows every agent with Edit, Share and Archive.
  const [browsing, setBrowsing] = useState(
    () => searchParams.get("view") === "agents",
  );
  const [dialog, setDialog] = useState<{ editing: TenantAgent | null } | null>(
    null,
  );
  const [agentsAttempt, setAgentsAttempt] = useState(0);
  // Whether this server lets agents start helper agents.
  const [helpersAllowed, setHelpersAllowed] = useState(false);

  useEffect(() => {
    let live = true;
    setAgentsLoad({ state: "loading" });
    void Promise.allSettled([fetchTenantAgents(), fetchTenantModels()]).then(
      ([agentsResult, modelsResult]) => {
        if (!live) return;
        if (modelsResult.status === "fulfilled") {
          setModels(modelsResult.value);
          setModelsError("");
        } else
          setModelsError(
            userMessage(
              modelsResult.reason,
              "Models could not be loaded. Close this dialog and try again.",
            ),
          );
        if (agentsResult.status === "rejected") {
          setAgentsLoad({
            state: "error",
            message: userMessage(
              agentsResult.reason,
              "Agents could not be loaded. Try again.",
            ),
          });
          return;
        }
        setAgents(agentsResult.value.agents);
        setHelpersAllowed(agentsResult.value.helpers);
        setAgentsLoad({ state: "ready" });
      },
    );
    return () => {
      live = false;
    };
  }, [agentsAttempt]);

  // The selection always names an agent a chat could start with.
  useEffect(() => {
    setSelectedId((current) =>
      agents.some((a) => a.id === current && a.available)
        ? current
        : (defaultAgent(agents)?.id ?? null),
    );
  }, [agents]);

  const agentChanged = useCallback((agent: TenantAgent) => {
    setAgents((list) => withAgent(list, agent));
  }, []);

  // Opening the dialog after models failed to load asks for them again.
  const openDialog = (editing: TenantAgent | null) => {
    setDialog({ editing });
    if (!modelsError) return;
    fetchTenantModels().then(
      (list) => {
        setModels(list);
        setModelsError("");
      },
      () => undefined,
    );
  };
  const selected = agents.find((a) => a.id === selectedId) ?? null;
  // The picker offers active agents in the directory's order.
  const pickable = useMemo(() => {
    const groups = groupAgents(agents);
    return [...groups.builtin, ...groups.personal, ...groups.tenant];
  }, [agents]);

  // ---- The chat list ----
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [listError, setListError] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listAttempt, setListAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setListState("loading");
    fetchChats().then(
      (page) => {
        if (!live) return;
        setChats((list) => page.chats.reduce(withChat, list));
        setCursor(page.nextCursor);
        setListState("ready");
      },
      (error) => {
        if (!live) return;
        setListError(userMessage(error, "Chats couldn't be loaded."));
        setListState("error");
      },
    );
    return () => {
      live = false;
    };
  }, [listAttempt]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchChats(cursor);
      setChats((list) => page.chats.reduce(withChat, list));
      setCursor(page.nextCursor);
    } catch (error) {
      setListError(userMessage(error, "More chats couldn't be loaded."));
      setListState("error");
    } finally {
      setLoadingMore(false);
    }
  };

  // ---- The open chat ----
  const [openId, setOpenId] = useState<string | null>(() =>
    chatParam(searchParams.toString()),
  );
  // Read by async work to drop answers for a chat no longer shown.
  const openRef = useRef(openId);
  const [thread, setThread] = useState<ChatThread | null>(null);
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const [opened, setOpened] = useState<
    | { state: "loading" }
    | { state: "ready" }
    | { state: "error"; message: string; notFound: boolean }
  >({ state: openId ? "loading" : "ready" });
  // The reply being followed, and the chat it belongs to.
  const [live, setLive] = useState<{ chatId: string; reply: LiveReply } | null>(
    null,
  );
  // The open chat's stored file versions, and the file the viewer shows.
  const [chatFiles, setChatFiles] = useState<{
    chatId: string;
    files: ChatFile[];
  } | null>(null);
  const [viewer, setViewer] = useState<{
    chatId: string;
    target: ViewerTarget;
  } | null>(null);
  // Replies whose viewer the person closed: it does not open by itself again.
  const dismissed = useRef(new Set<string>());
  const addFiles = useCallback((chatId: string, added: ChatFile[]) => {
    setChatFiles((current) => ({
      chatId,
      files:
        current?.chatId === chatId ? withFiles(current.files, added) : added,
    }));
  }, []);
  const [connection, setConnection] = useState<Connection>("open");
  const [followKey, setFollowKey] = useState(0);
  const [stopping, setStopping] = useState<string | null>(null);
  const [stopError, setStopError] = useState("");
  const [olderFor, setOlderFor] = useState<string | null>(null);
  const [olderError, setOlderError] = useState("");

  const navigate = useCallback(
    (chatId: string | null, how: "push" | "replace" = "push") => {
      setDrawer(false);
      // Any navigation leaves the Agents board; "Agents" sets it again after.
      setBrowsing(false);
      if (chatId === openRef.current) {
        // Already on the new-chat screen, so drop `?view=agents` too.
        if (!chatId && window.location.search)
          window.history.replaceState(null, "", window.location.pathname);
        return;
      }
      openRef.current = chatId;
      setOpenId(chatId);
      setStopError("");
      setOlderError("");
      const url = chatId ? `?chat=${chatId}` : window.location.pathname;
      if (how === "push") window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    },
    [],
  );

  // Back and Forward move between chats.
  useEffect(() => {
    const onPop = () => {
      const chatId = chatParam(window.location.search);
      openRef.current = chatId;
      setOpenId(chatId);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Reads the chat; `quiet` keeps what is on screen while it does.
  const load = useCallback(
    async (chatId: string, quiet = false) => {
      if (!quiet) setOpened({ state: "loading" });
      try {
        const next = await fetchChat(chatId);
        if (openRef.current !== chatId) return;
        // Alongside, not first: a chat opens without waiting for its files.
        fetchChatFiles(chatId).then(
          (files) => {
            if (openRef.current === chatId) addFiles(chatId, files);
          },
          (error: unknown) => warnFailure("chat files", error),
        );
        setThread(next);
        setOpened({ state: "ready" });
        setChats((list) => withChat(list, next.chat));
        const runId = next.chat.activeRunId;
        setLive((current) =>
          !runId
            ? null
            : current?.chatId === chatId && current.reply.runId === runId
              ? current
              : { chatId, reply: liveReply(runId) },
        );
      } catch (error) {
        if (openRef.current !== chatId) return;
        // A quiet reload that fails leaves the chat as it was.
        if (quiet && threadRef.current?.chat.id === chatId) return;
        const notFound =
          error instanceof ApiRequestError && error.status === 404;
        setOpened({
          state: "error",
          notFound,
          message: notFound
            ? "This chat doesn't exist, or you can't open it."
            : userMessage(error, "This chat couldn't be opened. Try again."),
        });
      }
    },
    [addFiles],
  );

  useEffect(() => {
    if (!openId) {
      setOpened({ state: "ready" });
      return;
    }
    if (threadRef.current?.chat.id === openId) return;
    void load(openId);
  }, [openId, load]);

  const openThread = openId && thread?.chat.id === openId ? thread : null;
  const openLive = live && live.chatId === openId ? live.reply : null;

  // Only the open chat is followed, so a reply running elsewhere is noticed
  // by re-reading the first page of the list while one runs. Running chats
  // are the most recent, so they are on that page.
  const backgroundBusy = chats.some(
    (chat) => chat.activeRunId && chat.id !== openId,
  );
  useEffect(() => {
    if (!backgroundBusy) return;
    let timer = 0;
    let stopped = false;
    const poll = () => {
      timer = window.setTimeout(() => {
        fetchChats()
          .then(
            (page) => {
              // The open chat keeps its own state: a page read before its
              // reply finished would bring the pulse back.
              if (!stopped)
                setChats((list) =>
                  page.chats
                    .filter((chat) => chat.id !== openRef.current)
                    .reduce(withChat, list),
                );
            },
            (error: unknown) => warnFailure("chat list", error),
          )
          .finally(() => {
            if (!stopped) poll();
          });
      }, 4000);
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [backgroundBusy]);

  // A reply that finishes in a chat that is not open marks it unread until
  // it is opened. Kept for this session only; the platform has no read state.
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set());
  const runningRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const running = new Set(
      chats.filter((chat) => chat.activeRunId).map((chat) => chat.id),
    );
    const finished = [...runningRef.current].filter(
      (chatId) => !running.has(chatId) && chatId !== openId,
    );
    runningRef.current = running;
    if (finished.length)
      setUnread((current) => new Set([...current, ...finished]));
  }, [chats, openId]);
  useEffect(() => {
    if (!openId) return;
    setUnread((current) => {
      if (!current.has(openId)) return current;
      const next = new Set(current);
      next.delete(openId);
      return next;
    });
  }, [openId]);

  // Follows the open chat's reply until it is saved. Leaving the chat stops
  // following; the reply keeps running and is picked up again on return.
  const followChat = openLive ? openId : null;
  const followRunId = openLive?.runId ?? null;
  useEffect(() => {
    if (!followChat || !followRunId) return;
    setConnection("open");
    const mine = (current: typeof live) =>
      current?.chatId === followChat && current.reply.runId === followRunId;
    return followRun(followChat, followRunId, {
      onEvent: (event) => {
        setLive((current) =>
          mine(current)
            ? { ...current!, reply: applyStreamEvent(current!.reply, event) }
            : current,
        );
        if (event.type === "files")
          addFiles(followChat, parseFiles(event.data));
      },
      onConnection: (connected) =>
        setConnection(connected ? "open" : "reconnecting"),
      onEnd: (end) => {
        if (end.kind === "saved") {
          const saved = parseSaved(end.data);
          if (!saved) {
            void load(followChat, true);
            return;
          }
          setThread((current) =>
            current?.chat.id === followChat
              ? withSaved(current, saved)
              : current,
          );
          setLive((current) => (mine(current) ? null : current));
          setChats((list) =>
            list.map((chat) =>
              chat.id === followChat && chat.activeRunId === followRunId
                ? { ...chat, activeRunId: null }
                : chat,
            ),
          );
          setAnnouncement(
            outcomeNote(saved.run.status, saved.run.error) ?? "Reply finished.",
          );
          return;
        }
        if (end.kind === "signedOut") recheck.current();
        if (end.kind === "notFound") {
          void load(followChat);
          return;
        }
        // Gave up, or the platform cannot stream it: the person decides
        // when to try again.
        setConnection("lost");
      },
    });
  }, [followChat, followRunId, followKey, load, addFiles]);

  // Stable, like loadOlder, so typing a draft does not re-render the
  // transcript (dev build, 54 messages: it added 8–16 ms per keystroke).
  const reconnect = useCallback(() => {
    if (!openId) return;
    setConnection("open");
    setFollowKey((n) => n + 1);
    void load(openId, true);
  }, [openId, load]);

  // A new reply starts without a pending stop.
  useEffect(() => {
    setStopping(null);
    setStopError("");
  }, [followRunId]);

  // ---- Sending ----
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<{
    key: string;
    failure: SendFailure;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  // A 409 CONNECTION_REQUIRED on start/send: the draft is kept and a Connect
  // card is shown above the composer. Keyed by the draft it blocked, so it is
  // dropped when the member switches chats/agents or a send succeeds.
  const [connectCard, setConnectCard] = useState<{
    key: string;
    required: ConnectionRequired;
  } | null>(null);
  // The message on its way, shown before the platform answers, and the
  // agent a first message starts its chat with.
  const [pending, setPending] = useState<
    (PendingSend & { agent: TenantAgent | null }) | null
  >(null);
  const [ids] = useState(() => messageIds());
  const draftKey = openId ?? NEW;
  const draft = drafts[draftKey] ?? "";

  // ---- Attached files ----
  // Each picked file uploads at once (a few at a time, the platform's
  // per-member bound) and waits in its draft until the message is sent.
  const [uploadSettings, setUploadSettings] =
    useState<UploadSettings>(UPLOADS_OFF);
  useEffect(() => {
    let current = true;
    fetchUploadSettings()
      .then((settings) => current && setUploadSettings(settings))
      .catch((error) => warnFailure("upload settings", error));
    return () => {
      current = false;
    };
  }, []);
  const [draftFiles, setDraftFiles] = useState<Record<string, DraftFile[]>>({});
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});
  const uploadQueue = useRef<
    Array<{ draft: string; chip: string; file: File; name: string }>
  >([]);
  const uploading = useRef(new Map<string, AbortController>());
  // Chips taken off while their upload was still going.
  const removedChips = useRef(new Set<string>());
  const files = draftFiles[draftKey] ?? [];
  const setChip = (draft: string, chip: string, next: DraftFile | null) =>
    setDraftFiles((all) => {
      const list = all[draft];
      if (!list?.some((f) => f.key === chip)) return all;
      return { ...all, [draft]: withDraftFile(list, chip, next) };
    });
  const pumpUploads = () => {
    while (uploading.current.size < UPLOADS_AT_ONCE) {
      const next = uploadQueue.current.shift();
      if (!next) return;
      const controller = new AbortController();
      uploading.current.set(next.chip, controller);
      void uploadFile(next.file, next.name, controller.signal)
        .then((uploadId) => {
          if (removedChips.current.has(next.chip)) {
            void discardUpload(uploadId);
            return;
          }
          setChip(next.draft, next.chip, {
            key: next.chip,
            name: next.name,
            size: next.file.size,
            ...imagePreview(next.file, next.name),
            state: "ready",
            uploadId,
          });
        })
        .catch((error) => {
          if (removedChips.current.has(next.chip)) return;
          setChip(next.draft, next.chip, {
            key: next.chip,
            name: next.name,
            size: next.file.size,
            ...imagePreview(next.file, next.name),
            state: "failed",
            error: userMessage(error, "The file couldn't be attached."),
          });
        })
        .finally(() => {
          uploading.current.delete(next.chip);
          pumpUploads();
        });
    }
  };
  const attachFiles = (picked: File[]) => {
    const key = draftKey;
    let count = (draftFiles[key] ?? []).length;
    const added: DraftFile[] = [];
    let problem = "";
    for (const file of picked) {
      const refused = fileProblem(file, uploadSettings, count);
      if (refused) {
        problem ||= refused;
        continue;
      }
      count++;
      const chip = crypto.randomUUID();
      const name = file.name.normalize("NFC").trim();
      added.push({
        key: chip,
        name,
        size: file.size,
        ...imagePreview(file, name),
        state: "uploading",
      });
      uploadQueue.current.push({ draft: key, chip, file, name });
    }
    setFileErrors((all) => ({ ...all, [key]: problem }));
    if (added.length === 0) return;
    setDraftFiles((all) => ({
      ...all,
      [key]: [...(all[key] ?? []), ...added],
    }));
    pumpUploads();
  };
  const removeFile = (chip: string) => {
    const key = draftKey;
    const file = (draftFiles[key] ?? []).find((f) => f.key === chip);
    if (!file) return;
    removedChips.current.add(chip);
    uploadQueue.current = uploadQueue.current.filter((q) => q.chip !== chip);
    uploading.current.get(chip)?.abort();
    if (file.state === "ready") void discardUpload(file.uploadId);
    setChip(key, chip, null);
    setFileErrors((all) => ({ ...all, [key]: "" }));
  };

  // Switching the new-chat agent dismisses a Connect card raised for a
  // different agent (switching chats changes draftKey, which hides it).
  useEffect(() => {
    setConnectCard((current) => (current?.key === NEW ? null : current));
  }, [selectedId]);

  const send = () => {
    const key = openId ?? NEW;
    void dispatch(key, drafts[key] ?? "");
  };

  // A Follow Up row sends its text as the next message, with where it came
  // from. Resolves true once accepted, so the row can keep its progress
  // state; a failure re-enables the rows. The composer's draft text and
  // files are never sent or cleared by a row; a failure puts the row's text
  // in the composer only when it is empty.
  const sendFollowUp = async (runId: string, item: FollowUpItem) => {
    if (!openId || openThread?.chat.activeRunId || sendingRef.current)
      return false;
    return dispatch(openId, item.text, false, {
      fromRunId: runId,
      slot: item.slot,
    });
  };

  // Sends a message's text again as a brand-new message (a not-sent steer's
  // Resend): a fresh intent, so it gets a new clientMessageId and goes
  // through the normal send path.
  const resend = (text: string) => {
    ids.reset();
    void dispatch(openId ?? NEW, text, true);
  };

  // The transcript's copies keep their identity across stream frames, so
  // saved exchanges (memoized rows) do not re-render; each call runs the
  // latest committed `resend` / `sendFollowUp`.
  const sendsRef = useRef({ resend, sendFollowUp });
  useLayoutEffect(() => {
    sendsRef.current = { resend, sendFollowUp };
  });
  const onResend = useCallback(
    (text: string) => sendsRef.current.resend(text),
    [],
  );
  const onFollowUp = useCallback(
    (runId: string, item: FollowUpItem) =>
      sendsRef.current.sendFollowUp(runId, item),
    [],
  );
  const newChat = useCallback(() => navigate(null), [navigate]);

  // Starts sign-in to a connector named on the Connect card: stores where to
  // return so the member lands back on this chat, then navigates to the
  // provider's authorize URL (matching connected-tools-screen's RETURN_KEY).
  const [connecting, setConnecting] = useState<string | null>(null);
  const connect = async (slug: string) => {
    if (connecting) return;
    setConnecting(slug);
    try {
      try {
        window.sessionStorage.setItem(
          RETURN_KEY,
          window.location.pathname + window.location.search,
        );
      } catch {
        /* Storage can be unavailable; the member still returns via history. */
      }
      const url = await startConnect(slug);
      window.location.assign(url);
    } catch (error) {
      setConnecting(null);
      setConnectCard((current) =>
        current
          ? {
              ...current,
              required: {
                ...current.required,
                message: userMessage(
                  error,
                  "Sign-in couldn't be started. Try again.",
                ),
              },
            }
          : current,
      );
    }
  };

  // ---- Write-tool approvals ----
  // The approvalId whose answer is in flight, so its card's buttons disable.
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const approvalBusyRef = useRef(false);
  const approve = async (approvalId: string, decision: ApprovalAnswer) => {
    const chat = openThread?.chat ?? null;
    const runId = openLive?.runId ?? chat?.activeRunId ?? null;
    if (!chat || !runId || approvalBusyRef.current) return;
    approvalBusyRef.current = true;
    setApprovalBusy(approvalId);
    // Only touch the live reply that owns this approval, and only while this
    // chat is still open, so a late answer never settles another reply.
    const mine = (current: typeof live) =>
      current?.chatId === chat.id && current.reply.runId === runId;
    try {
      const result = await postApproval(chat.id, runId, approvalId, decision);
      if (openRef.current !== chat.id) return;
      setLive((current) => {
        if (!mine(current)) return current;
        const reply =
          result.kind === "ok"
            ? withApproval(current!.reply, approvalId, result.decision)
            : result.kind === "resolved"
              ? withApprovalRace(current!.reply, approvalId, "resolved")
              : result.kind === "not_found"
                ? withApprovalRace(current!.reply, approvalId, "not_found")
                : current!.reply; // a retryable failure leaves the card open
        return reply === current!.reply ? current : { ...current!, reply };
      });
    } finally {
      approvalBusyRef.current = false;
      setApprovalBusy(null);
    }
  };

  // ---- Network cards (blocked sandbox requests on saved replies) ----
  const [networkBusy, setNetworkBusy] = useState<string | null>(null);
  const [networkErrors, setNetworkErrors] = useState<Record<string, string>>(
    {},
  );
  const answerNetwork = async (
    messageId: string,
    decision: NetworkDecision,
  ) => {
    const chatId = openThread?.chat.id;
    if (!chatId || networkBusy) return;
    setNetworkBusy(messageId);
    setNetworkErrors(({ [messageId]: _gone, ...rest }) => rest);
    try {
      const result = await postNetworkDecision(chatId, messageId, decision);
      if (openRef.current !== chatId) return;
      if (result.kind === "failed")
        setNetworkErrors((all) => ({ ...all, [messageId]: result.message }));
      else if (result.kind === "resolved")
        // Answered elsewhere: the next read shows that answer.
        setNetworkErrors((all) => ({
          ...all,
          [messageId]: "This was already answered. Reload to see the answer.",
        }));
      else
        setThread((current) =>
          current?.chat.id === chatId
            ? withNetworkDecision(current, messageId, result.decision)
            : current,
        );
    } finally {
      setNetworkBusy(null);
    }
  };

  const dispatch = async (
    key: string,
    text: string,
    resent = false,
    followUp?: FollowUpOrigin,
  ): Promise<boolean> => {
    const chat = openThread?.chat ?? null;
    // A resend is the text of a steer that was never read; it has no files.
    // A Follow Up row sends only its own text and leaves the draft alone.
    const sentFiles = resent || followUp ? [] : (draftFiles[key] ?? []);
    const busyNow = !!(openId && chat?.activeRunId);
    if (sendingRef.current || !canSendMessage(text, sentFiles, busyNow))
      return false;
    // A reply in progress is steered, not blocked; only a read-only or
    // missing chat refuses.
    if (openId && (!chat || readOnlyNote(chat))) return false;
    const agent = openId ? null : selected;
    if (!openId && !agent?.available) return false;
    sendingRef.current = true;
    setSending(true);
    setFailure(null);
    setConnectCard(null);
    const target = openId ?? `new:${agent!.id}`;
    // A resend reuses no earlier intent; its id is the one just minted.
    const attachments = uploadIds(sentFiles);
    // A retry of the same text and files reuses its ID.
    const intent = attachments.length
      ? `${target}:files:${attachments.join(",")}`
      : target;
    const clientMessageId = resent
      ? ids.for(`resend:${target}:${Date.now()}`, text)
      : ids.for(intent, text);
    const since = Date.now();
    // A message into a running reply shows at the bottom of that reply at
    // once (a steer); otherwise it shows as the next message in the chat.
    // The composer stays usable either way; a failure puts the text back.
    const steering = !!(openId && chat?.activeRunId);
    if (steering)
      setLive((current) =>
        current?.chatId === openId && current.reply.runId === chat!.activeRunId
          ? {
              ...current,
              reply: withLiveSteer(current.reply, { clientMessageId, text }),
            }
          : current,
      );
    else
      setPending({
        key,
        text,
        clientMessageId,
        since,
        agent,
        attachments: pendingAttachments(sentFiles),
      });
    if (!followUp) {
      setDrafts((all) => {
        const { [key]: _sent, ...rest } = all;
        return rest;
      });
      if (sentFiles.length)
        setDraftFiles((all) => {
          const { [key]: _sent, ...rest } = all;
          return rest;
        });
      setFileErrors((all) => (all[key] ? { ...all, [key]: "" } : all));
    }
    try {
      const receipt = openId
        ? await sendMessage(chat!, text, clientMessageId, attachments, followUp)
        : {
            kind: "send" as const,
            receipt: await startChat(
              agent!.id,
              text,
              clientMessageId,
              attachments,
            ),
          };
      ids.reset();
      setChats((list) => withChat(list, receipt.receipt.chat));
      // The person moved to another chat meanwhile: the reply runs anyway
      // and the list shows it.
      if (openRef.current !== openId) return true;
      if (receipt.kind === "steer") {
        // The steer joined the running turn: the run carries it (so a reload
        // shows it) and the optimistic bubble stays until `input` fixes it.
        const { chat: steerChat, run, steer } = receipt.receipt;
        setThread((current) =>
          withSteer(current?.chat.id === steerChat.id ? current : null, {
            chat: steerChat,
            run,
            steer,
          }),
        );
        setOpened({ state: "ready" });
        return true;
      }
      const sent = receipt.receipt;
      const chatId = sent.chat.id;
      if (!openId) navigate(chatId, "replace");
      // A steer the platform turned into a new run (its fallback): the
      // optimistic steer bubble belongs to the old reply, which is settling;
      // the saved messages will carry it, so drop it here.
      if (steering)
        setLive((current) =>
          current?.chatId === openId
            ? { ...current, reply: dropSteer(current.reply, clientMessageId) }
            : current,
        );
      // Sent images are shown from the bytes already here, not downloaded.
      for (const { fileId, blob } of previewSeeds(
        sentFiles,
        sent.message.attachments ?? [],
      ))
        seedFileContent(fileId, blob);
      setThread((current) =>
        withReceipt(current?.chat.id === chatId ? current : null, sent),
      );
      // The attached files are the chat's files now; a reply's `files`
      // event names only what the reply wrote, so read them once here.
      if (attachments.length)
        fetchChatFiles(chatId).then(
          (files) => {
            if (openRef.current === chatId) addFiles(chatId, files);
          },
          (error: unknown) => warnFailure("chat files", error),
        );
      setOpened({ state: "ready" });
      if (sent.chat.activeRunId === sent.run.id)
        setLive({ chatId, reply: liveReply(sent.run.id, since) });
      // A repeat of a message answered meanwhile: show what was saved.
      else void load(chatId, true);
      return true;
    } catch (error) {
      setDrafts((all) => (all[key] ? all : { ...all, [key]: text }));
      if (sentFiles.length)
        setDraftFiles((all) =>
          all[key]?.length ? all : { ...all, [key]: sentFiles },
        );
      // An optimistic steer that never reached the turn is removed.
      if (steering)
        setLive((current) =>
          current?.chatId === openId
            ? { ...current, reply: dropSteer(current.reply, clientMessageId) }
            : current,
        );
      // A 409 CONNECTION_REQUIRED keeps the draft (restored above) and shows
      // the Connect card instead of a generic send failure.
      const required = connectionRequired(error);
      if (required) {
        if (openRef.current === openId) setConnectCard({ key, required });
        return false;
      }
      const failed = sendFailure(error);
      if (openRef.current === openId) {
        setFailure({ key, failure: failed });
        if (failed.reload && openId) void load(openId, true);
      }
      return false;
    } finally {
      setPending(null);
      sendingRef.current = false;
      setSending(false);
    }
  };

  const stop = async () => {
    const chat = openThread?.chat;
    const runId = chat?.activeRunId;
    if (!chat || !runId || stopping === runId) return;
    setStopping(runId);
    setStopError("");
    try {
      await stopRun(chat.id, runId);
    } catch (error) {
      setStopping(null);
      setStopError(
        userMessage(error, "The reply couldn't be stopped. Try again."),
      );
    }
  };

  const rename = async (title: string): Promise<string | null> => {
    const chatId = openThread?.chat.id;
    if (!chatId) return "Open a chat first.";
    try {
      const saved = await renameChat(chatId, title);
      // Only the title: the rest of this screen's copy may be newer.
      setThread((current) =>
        current?.chat.id === chatId
          ? { ...current, chat: { ...current.chat, title: saved.title } }
          : current,
      );
      setChats((list) =>
        list.map((chat) =>
          chat.id === chatId ? { ...chat, title: saved.title } : chat,
        ),
      );
      return null;
    } catch (error) {
      return userMessage(error, "The chat couldn't be renamed. Try again.");
    }
  };

  const archive = async (): Promise<string | null> => {
    const chatId = openThread?.chat.id;
    if (!chatId) return "Open a chat first.";
    try {
      const saved = await archiveChat(chatId);
      setChats((list) => withChat(list, saved));
      setAnnouncement(`Archived “${saved.title}”.`);
      if (openRef.current === chatId) navigate(null);
      return null;
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "CHAT_BUSY")
        return "This chat is still answering. Wait for the reply, or stop it, then archive.";
      return userMessage(error, "The chat couldn't be archived. Try again.");
    }
  };

  const loadOlder = useCallback(async () => {
    const current = openThread;
    const before = current?.messages[0]?.seq;
    if (!current || before === undefined || olderFor) return;
    const chatId = current.chat.id;
    setOlderFor(chatId);
    setOlderError("");
    try {
      const page = await fetchOlderMessages(chatId, before);
      setThread((t) => (t?.chat.id === chatId ? withOlder(t, page) : t));
    } catch (error) {
      if (openRef.current === chatId)
        setOlderError(
          userMessage(error, "Earlier messages couldn't be loaded."),
        );
    } finally {
      setOlderFor(null);
    }
  }, [openThread, olderFor]);

  // ---- The mobile drawer ----
  useEffect(() => {
    if (!narrow || !drawer) return;
    document.querySelector<HTMLElement>(".cs-sidebar .cs-new")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setDrawer(false);
      toggleRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, drawer]);
  useFocusTrap(sidebarNode, narrow && drawer);

  const shownFailure = failure?.key === draftKey ? failure.failure : null;
  const shownConnectCard =
    connectCard?.key === draftKey ? connectCard.required : null;
  const setDraft = (value: string) => {
    setDrafts((all) => ({ ...all, [draftKey]: value }));
    if (shownFailure && !shownFailure.unknown) setFailure(null);
  };

  // A refusal about the running reply ("still answering", too many
  // follow-ups) is dropped when that reply ends: the draft can be sent now.
  const openChatId = openThread?.chat.id ?? null;
  const openRunId = openThread?.chat.activeRunId ?? null;
  const lastRunning = useRef<RunningReply | null>(null);
  useEffect(() => {
    const now = openChatId ? { chatId: openChatId, runId: openRunId } : null;
    const before = lastRunning.current;
    lastRunning.current = now;
    if (!now || !replyEnded(before, now)) return;
    setFailure((current) =>
      current?.key === now.chatId && current.failure.untilReplyEnds
        ? null
        : current,
    );
  }, [openChatId, openRunId]);

  // A message on its way shows in the chat it was sent from: added to the
  // open chat, or as the start of the chat a first message creates.
  // Memoized: the transcript re-renders only when these change.
  const pendingHere = pending?.key === draftKey ? pending : null;
  const shownThread = useMemo(() => {
    if (!pendingHere) return openThread;
    if (openThread) return withPending(openThread, pendingHere);
    return !openId && pendingHere.agent
      ? pendingThread(pendingHere.agent, pendingHere)
      : null;
  }, [openThread, openId, pendingHere]);
  const pendingLive = useMemo(
    () =>
      pendingHere
        ? liveReply(pendingRunId(pendingHere), pendingHere.since)
        : null,
    [pendingHere],
  );
  const shownLive = openLive ?? pendingLive;
  const creating = !openId && !!shownThread;
  // The frame shows the new-conversation layout (11.4) until a chat exists.
  const frameNew = !openId && !creating;
  useEffect(() => {
    setNew(frameNew);
  }, [frameNew, setNew]);
  useEffect(() => () => setNew(false), [setNew]);

  // ---- Files ----
  const shownFiles = useMemo(
    () => (chatFiles && chatFiles.chatId === openId ? chatFiles.files : []),
    [chatFiles, openId],
  );
  const shownViewer = viewer && viewer.chatId === openId ? viewer : null;
  // Where the Activity Panel fits, a file opens inside it; below its fold
  // the file panel floats beside the chat instead.
  const viewerInPanel = activityFits && !!shownThread;
  const panelViewer = viewerInPanel ? shownViewer : null;
  const floatViewer = viewerInPanel ? null : shownViewer;
  const openFile = useCallback(
    (target: ViewerTarget) => {
      if (!openId) return;
      setViewer({ chatId: openId, target });
      // The panel opens at the wide size, which the fit rules may refuse.
      if (viewerInPanel) {
        setActivityOpen(true);
        setActivityWide(true);
      }
    },
    [openId, viewerInPanel],
  );
  // The viewed reply's files that couldn't be saved.
  const viewerRun = shownViewer?.target.runId;
  const viewerUnsaved = !viewerRun
    ? []
    : openLive?.runId === viewerRun
      ? openLive.unsaved
      : (shownThread?.runs[viewerRun]?.unsavedFiles ?? []);
  // ...and those too large to save, which are never retried.
  const viewerTooLarge = !viewerRun
    ? []
    : openLive?.runId === viewerRun
      ? openLive.tooLarge
      : (shownThread?.runs[viewerRun]?.tooLargeFiles ?? []);
  // A reply that starts writing a new file opens it in the viewer, so its
  // text can be watched as it is written. Not on a phone, where the viewer
  // would cover the chat, and not after the person closed it for this reply.
  const writingPath = openLive ? firstWritingPath(openLive) : null;
  const liveRunId = openLive?.runId ?? null;
  useEffect(() => {
    if (!openId || !liveRunId || !writingPath || narrow) return;
    if (dismissed.current.has(liveRunId)) return;
    setViewer((current) =>
      current?.chatId === openId && current.target.runId === liveRunId
        ? current
        : { chatId: openId, target: { runId: liveRunId, path: writingPath } },
    );
    if (viewerInPanel) {
      setActivityOpen(true);
      setActivityWide(true);
    }
  }, [openId, liveRunId, writingPath, narrow, viewerInPanel]);
  const closeViewer = useCallback(() => {
    setViewer((current) => {
      if (current) dismissed.current.add(current.target.runId);
      return null;
    });
  }, []);
  const download = useCallback(
    (file: ChatFile) => {
      if (!openId) return;
      downloadFile(openId, file).catch((error: unknown) =>
        setAnnouncement(userMessage(error, "The file couldn't be downloaded.")),
      );
    },
    [openId],
  );
  // Retries of replies' unsaved files, by run.
  const [retries, setRetries] = useState<Record<string, RetryState>>({});
  const retryFiles = useCallback(
    (runId: string, paths: readonly string[]) => {
      const chatId = openId;
      if (!chatId) return;
      const put = (state: RetryState | null) =>
        setRetries((current) => {
          const next = { ...current };
          if (state) next[runId] = state;
          else delete next[runId];
          return next;
        });
      put({ busy: true });
      retryUnsavedFiles(chatId, runId).then(
        ({ files, unsaved, tooLarge }) => {
          addFiles(chatId, files);
          // Neither saved, still failing nor too large: no longer in the chat.
          const gone = paths.some(
            (path) =>
              !unsaved.includes(path) &&
              !tooLarge.includes(path) &&
              !files.some((f) => f.path === path),
          );
          put(
            unsaved.length
              ? {
                  busy: false,
                  message: "Still couldn't save. Try again in a moment.",
                }
              : gone
                ? {
                    busy: false,
                    message:
                      "Some files are no longer in this chat, so they weren't saved.",
                  }
                : null,
          );
          setThread((current) => {
            const run = current?.chat.id === chatId && current.runs[runId];
            if (!run) return current;
            const { unsavedFiles: _before, ...rest } = run;
            // A file a retry found too large joins the reply's too large ones.
            const big = [
              ...new Set([...(run.tooLargeFiles ?? []), ...tooLarge]),
            ];
            return {
              ...current,
              runs: {
                ...current.runs,
                [runId]: {
                  ...rest,
                  ...(unsaved.length ? { unsavedFiles: unsaved } : {}),
                  ...(big.length ? { tooLargeFiles: big } : {}),
                },
              },
            };
          });
          setLive((current) =>
            current?.chatId === chatId && current.reply.runId === runId
              ? {
                  ...current,
                  reply: {
                    ...current.reply,
                    unsaved,
                    tooLarge: [
                      ...new Set([...current.reply.tooLarge, ...tooLarge]),
                    ],
                  },
                }
              : current,
          );
        },
        (error: unknown) =>
          put({
            busy: false,
            message: userMessage(
              error,
              "The files couldn't be saved. Try again.",
            ),
          }),
      );
    },
    [openId, addFiles],
  );
  // Stable per chat, so image previews don't reload as the viewer changes.
  const fileContent = useCallback(
    (fileId: string) =>
      openId
        ? cachedFileContent(openId, fileId)
        : Promise.reject(new Error("No chat is open.")),
    [openId],
  );
  const fileActions = useMemo<FileActions>(
    () => ({
      open: openFile,
      content: fileContent,
      download,
      active: shownViewer?.target ?? null,
      retry: retryFiles,
      retryState: (runId) => retries[runId],
    }),
    [openFile, fileContent, download, shownViewer, retryFiles, retries],
  );
  const viewerFit = fitPanel(
    layoutW,
    560,
    640,
    !narrow && !sidebarHidden,
    true,
  );

  // The topbar (DESIGN-SPEC 11.3): a new conversation has no agent yet.
  const isNew = frameNew;
  const topChat = shownThread?.chat ?? chats.find((c) => c.id === openId);
  const onBoard =
    !openId && !creating && browsing && agentsLoad.state === "ready";
  const topTitle = onBoard
    ? "Agents"
    : isNew
      ? "New conversation"
      : topChat?.title || (topChat ? "New chat" : "Loading…");
  const topAgent = topChat?.agent
    ? {
        name: topChat.agent.name,
        state: hasPendingApproval(openLive)
          ? ("waiting" as const)
          : topChat.activeRunId || openLive
            ? ("working" as const)
            : ("ready" as const),
      }
    : null;

  // The wide panel is offered only where the chat keeps 640px beside it;
  // the sidebar yields to it when both don't fit (legacy fit rules).
  const wideFit = fitPanel(
    layoutW,
    PANEL_W.max,
    CHAT_MIN.max,
    !narrow && !sidebarHidden,
    true,
  );
  // A floating file (560px) beside it would squeeze the chat.
  const canWide = !wideFit.overlay && !floatViewer;
  const shownWide = activityOpen && activityWide && canWide;
  const sidebarYields = shownWide && !wideFit.sidebar;
  // Hidden by the user, or pushed out by the wide panel.
  const sidebarOff = sidebarHidden || sidebarYields;
  const toggleSidebar = () => {
    if (narrow) setDrawer((open) => !open);
    // Opening the sidebar wins: the wide panel shrinks back.
    else if (sidebarYields) setActivityWide(false);
    else setSidebarHidden((hidden) => !hidden);
  };
  // The dock's Account key opens the account menu in the sidebar, showing the
  // sidebar first if it is hidden.
  const openAccount = () => {
    if (narrow) setDrawer(true);
    else {
      setSidebarHidden(false);
      if (sidebarYields) setActivityWide(false);
    }
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(".cs-sidebar .cs-account")?.click(),
    );
  };
  // Closing the panel closes a file open inside it.
  const toggleActivity = () => {
    if (activityOpen && panelViewer) closeViewer();
    setActivityOpen((open) => !open);
    setActivityTurn(null);
  };
  // Focus goes back to the dock key that opened it, which raises the dock.
  const closeActivity = () => {
    if (panelViewer) closeViewer();
    setActivityOpen(false);
    document
      .querySelector<HTMLElement>('.cs-dock-btn[aria-label="Activity"]')
      ?.focus();
  };
  // The panel exists for an open conversation on a wide enough shell; the
  // dock key and ⌘. exist exactly where it does.
  const canActivity = !!shownThread && activityFits;
  const activityShown = activityOpen && canActivity;
  // Stays mounted through its slide out (the --panel-out duration).
  const activityMounted = useExit(activityShown, 320);
  useShortcuts({
    sidebar: toggleSidebar,
    palette: () => setPaletteOpen((open) => !open),
    ...(canActivity ? { activity: toggleActivity } : {}),
  });
  // One report per turn of the open conversation, for the Activity Panel.
  const turns = useMemo(() => {
    if (!shownThread) return [];
    const exchanges = exchangesOf(shownThread);
    if (shownLive && !exchanges.some((e) => e.runId === shownLive.runId))
      exchanges.push({ runId: shownLive.runId, messages: [], run: null });
    return exchanges.map((exchange) =>
      turnView(
        exchange,
        shownLive?.runId === exchange.runId ? shownLive : null,
        shownFiles,
        shownThread.chat.connectors,
      ),
    );
  }, [shownThread, shownLive, shownFiles]);
  // A file open in the panel shows the turn that made it.
  const fileTurn = panelViewer
    ? turns.findIndex((t) => t.runId === panelViewer.target.runId)
    : -1;
  const turnIndex =
    fileTurn >= 0
      ? fileTurn
      : Math.min(activityTurn ?? turns.length - 1, turns.length - 1);
  const showInChat = (turn: TurnView) => {
    const target =
      turn.state === "needs"
        ? document.querySelector<HTMLElement>(".cs-pinned .rq")
        : document.querySelector<HTMLElement>(
            `[data-run="${CSS.escape(turn.runId)}"]`,
          );
    target?.scrollIntoView({
      block: "nearest",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    target?.focus({ preventScroll: true });
  };
  const paletteItems = useMemo<PaletteItem[]>(
    () => [
      // Ahead of the history, so a long one can't push it past the cap.
      {
        id: "agents",
        group: "Go to",
        label: "Agents",
        keywords: "team board specialists",
      },
      ...chats.map((chat) => ({
        id: `chat:${chat.id}`,
        group: "Go to" as const,
        label: chat.title || "Untitled conversation",
      })),
      {
        id: "new",
        group: "Actions",
        label: "New conversation",
        shortcut: "new",
      },
      {
        id: "sidebar",
        group: "Actions",
        label: (narrow ? drawer : !sidebarOff)
          ? "Hide sidebar"
          : "Show sidebar",
        keywords: "conversations",
        shortcut: "sidebar",
      },
      {
        id: "tools",
        group: "Actions",
        label: "Connected tools",
        keywords: "connectors mcp",
      },
    ],
    [chats, narrow, drawer, sidebarOff],
  );
  const runPalette = (id: string) => {
    if (id.startsWith("chat:")) navigate(id.slice(5));
    else if (id === "new") navigate(null);
    else if (id === "sidebar") toggleSidebar();
    else if (id === "agents") {
      navigate(null);
      setBrowsing(true);
    } else if (id === "tools")
      router.push(`/t/${me.tenant.id}/connected-tools`);
  };
  // Hiding the sidebar while focus is in it leaves focus on the toggle that
  // brings it back, not on the page body.
  useEffect(() => {
    if (!sidebarOff) return;
    const focused = document.activeElement;
    if (!focused || focused === document.body || focused.closest(".cs-sidebar"))
      toggleRef.current?.focus();
  }, [sidebarOff]);

  const sidebarToggle =
    narrow || sidebarOff ? (
      <Button
        ref={toggleRef}
        iconOnly
        icon="sidebar"
        variant="ghost"
        size="sm"
        aria-label="Conversations"
        aria-expanded={narrow ? drawer : false}
        aria-keyshortcuts={ariaKeys("sidebar")}
        onClick={toggleSidebar}
      />
    ) : null;

  const dock = (
    <FloatingDock
      sidebarOpen={narrow ? drawer : !sidebarOff}
      onSidebar={toggleSidebar}
      onSearch={() => setPaletteOpen(true)}
      onNew={() => navigate(null)}
      onAgent={() => {
        navigate(null);
        setBrowsing(true);
      }}
      onAccount={openAccount}
      agentMenu={
        agentsLoad.state === "ready"
          ? {
              items: dockAgentMenu(pickable, selectedId),
              onSelect: (id) => {
                if (id === "new") openDialog(null);
                else if (id === "browse") {
                  navigate(null);
                  setBrowsing(true);
                } else {
                  // A new chat with that agent, ready to type.
                  navigate(null);
                  setSelectedId(id.slice("agent:".length));
                }
              },
            }
          : undefined
      }
      onUpChange={setDockUp}
      activityOpen={activityOpen}
      onActivity={canActivity ? toggleActivity : undefined}
    />
  );

  let stage: ReactNode;
  if (onBoard) {
    stage = (
      <section className="cs-scroll" aria-label="Agents">
        <TeamBoard
          agents={agents}
          selectedId={selectedId}
          onChat={(agent) => {
            setSelectedId(agent.id);
            setBrowsing(false);
          }}
          onEdit={(agent) => openDialog(agent)}
          onNew={() => openDialog(null)}
          onClose={() => setBrowsing(false)}
          onChanged={agentChanged}
        />
      </section>
    );
  } else if (!openId && !creating) {
    stage = (
      <>
        <section className="cs-scroll" aria-label="New chat">
          <Hero name={me.user.name}>
            {shownConnectCard && (
              <ConnectCard
                required={shownConnectCard}
                connecting={connecting}
                onConnect={(slug) => void connect(slug)}
              />
            )}
            <ChatComposer
              hero
              value={draft}
              onChange={setDraft}
              onSend={send}
              onStop={() => undefined}
              agentName={selected?.name ?? null}
              busy={false}
              sending={sending}
              ending={null}
              disabled={!selected?.available}
              failure={shownFailure}
              stopError=""
              focusKey={NEW}
              uploads={uploadSettings}
              files={files}
              onAddFiles={attachFiles}
              onRemoveFile={removeFile}
              fileError={fileErrors[draftKey] ?? ""}
              bar={
                agentsLoad.state === "ready" && (
                  <AgentPick
                    agents={pickable}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onNew={() => openDialog(null)}
                    onBrowse={() => setBrowsing(true)}
                  />
                )
              }
            />
            {agentsLoad.state === "loading" && (
              <p className="cs-hero-note" aria-busy="true">
                Loading agents…
              </p>
            )}
            {agentsLoad.state === "error" && (
              <div className="cs-hero-note" role="alert">
                <p>{agentsLoad.message}</p>
                <Button
                  size="sm"
                  onClick={() => setAgentsAttempt((n) => n + 1)}
                >
                  Try again
                </Button>
              </div>
            )}
          </Hero>
        </section>
        <div className="cs-bottom">{dock}</div>
      </>
    );
  } else if (shownThread) {
    const chat = shownThread.chat;
    const note = readOnlyNote(chat);
    const busy = !!chat.activeRunId;
    const networkActions: NetworkActions = {
      answer: (messageId, decision) => void answerNetwork(messageId, decision),
      busy: networkBusy,
      errors: networkErrors,
      // "Try again" is an ordinary message: the next reply carries the allow.
      tryAgain: busy || note || sending ? null : () => resend("Try again."),
      latestRunId: shownThread.messages.at(-1)?.runId ?? null,
    };
    stage = (
      <section className="cs-open" aria-label={chat.title || "Chat"}>
        <FileActionsContext.Provider value={fileActions}>
          <NetworkActionsContext.Provider value={networkActions}>
            <Transcript
              thread={shownThread}
              live={shownLive}
              connection={connection}
              loadingOlder={olderFor === chat.id}
              olderError={olderError}
              onLoadOlder={loadOlder}
              onReconnect={reconnect}
              onResend={onResend}
              onFollowUp={onFollowUp}
              tenantId={me.tenant.id}
              files={shownFiles}
              onNewChat={newChat}
            />
          </NetworkActionsContext.Provider>
        </FileActionsContext.Provider>
        <div className={dockUp ? "cs-bottom is-dock-up" : "cs-bottom"}>
          {note && !busy ? (
            <div className="tx-card cs-readonly" role="status">
              <p>{note}</p>
              <Button size="sm" onClick={() => navigate(null)}>
                Start a new chat
              </Button>
            </div>
          ) : (
            <>
              {shownConnectCard && (
                <ConnectCard
                  required={shownConnectCard}
                  connecting={connecting}
                  onConnect={(slug) => void connect(slug)}
                />
              )}
              <RequestDock
                live={shownLive}
                connectors={chat.connectors}
                busy={approvalBusy}
                onApprove={approve}
              />
              <ChatComposer
                value={draft}
                onChange={setDraft}
                onSend={send}
                onStop={() => void stop()}
                agentName={chat.agent?.name ?? null}
                busy={busy}
                sending={sending}
                ending={
                  openLive?.phase === "settled"
                    ? "saving"
                    : stopping === chat.activeRunId ||
                        openLive?.phase === "stopping"
                      ? "stopping"
                      : null
                }
                awaitingApproval={hasPendingApproval(openLive)}
                disabled={false}
                failure={shownFailure}
                stopError={stopError}
                focusKey={chat.id}
                uploads={uploadSettings}
                files={files}
                onAddFiles={attachFiles}
                onRemoveFile={removeFile}
                fileError={fileErrors[draftKey] ?? ""}
              />
            </>
          )}
          {dock}
        </div>
      </section>
    );
  } else if (opened.state === "error") {
    stage = (
      <section className="cs-scroll" aria-label="Chat">
        <div className="cs-state">
          <p role="alert">{opened.message}</p>
          {opened.notFound ? (
            <Button size="sm" onClick={() => navigate(null)}>
              Start a new chat
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                if (openId) void load(openId);
              }}
            >
              Try again
            </Button>
          )}
        </div>
      </section>
    );
  } else {
    stage = (
      <section className="cs-scroll" aria-label="Chat" aria-busy="true">
        <p className="cs-state">Loading chat…</p>
      </section>
    );
  }

  // Back to the Files list of the same turn.
  const closePanelFile = () => {
    setActivityTurn(turnIndex);
    closeViewer();
  };
  const fileViewer = (target: ViewerTarget, onClose = closeViewer) =>
    openId && (
      <FileViewer
        chatId={openId}
        target={target}
        files={shownFiles}
        live={openLive}
        onSelect={(next) => setViewer({ chatId: openId, target: next })}
        onClose={onClose}
        onDownload={download}
        unsaved={viewerUnsaved}
        tooLarge={viewerTooLarge}
        saving={retries[target.runId]}
        onSave={() => retryFiles(target.runId, viewerUnsaved)}
      />
    );

  return (
    <>
      <Panel
        kind="sidebar"
        // Gives way to an open file before the file floats over the chat.
        open={
          narrow ? drawer : !sidebarOff && (!floatViewer || viewerFit.sidebar)
        }
        label="Conversations and workspace"
        modal={narrow}
      >
        <WorkspaceSidebar
          current={browsing && !openId ? "agents" : "chat"}
          onNew={() => navigate(null)}
          onAgents={() => {
            navigate(null);
            setBrowsing(true);
            if (narrow) setDrawer(false);
          }}
        >
          <ChatList
            chats={chats}
            activeId={openId}
            unread={unread}
            state={listState}
            error={listError}
            hasMore={!!cursor}
            loadingMore={loadingMore}
            onOpen={(chatId) => navigate(chatId)}
            onRetry={() => setListAttempt((n) => n + 1)}
            onMore={() => void loadMore()}
          />
        </WorkspaceSidebar>
      </Panel>
      {narrow && drawer && (
        <div
          className="cs-scrim"
          aria-hidden="true"
          onClick={() => setDrawer(false)}
        />
      )}
      <WorkspaceStage
        title={topTitle}
        agent={topAgent}
        start={sidebarToggle}
        topbar={
          shownThread && !isNew ? (
            <ChatTopbar
              chat={shownThread.chat}
              busy={!!shownThread.chat.activeRunId}
              waiting={hasPendingApproval(openLive)}
              creating={creating}
              start={sidebarToggle}
              onRename={rename}
              onArchive={archive}
            />
          ) : undefined
        }
      >
        {stage}
      </WorkspaceStage>
      {activityMounted && shownThread && activityFits && (
        <ActivityPanel
          closing={!activityShown}
          turns={turns}
          index={turnIndex}
          agent={
            shownThread.chat.agent
              ? {
                  name: shownThread.chat.agent.name,
                  source: shownThread.chat.agent.source,
                  model: shownThread.chat.model?.displayName ?? null,
                }
              : null
          }
          onIndex={(index) => {
            if (panelViewer) closeViewer();
            setActivityTurn(index);
          }}
          onClose={closeActivity}
          onShowInChat={showInChat}
          onOpenFile={(file) =>
            openFile({ runId: file.runId, path: file.path })
          }
          onDownloadFile={download}
          file={
            panelViewer &&
            openId &&
            fileViewer(panelViewer.target, closePanelFile)
          }
          onCloseFile={closePanelFile}
          wide={shownWide}
          onToggleWide={
            canWide ? () => setActivityWide((wide) => !wide) : undefined
          }
        />
      )}
      <Panel
        kind="activity"
        open={!!floatViewer}
        width={560}
        // Floats over the chat only when even without the sidebar the chat
        // would be under 640px.
        overlay={viewerFit.overlay}
        label="File"
      >
        {floatViewer && openId && fileViewer(floatViewer.target)}
      </Panel>
      <TenantAgentDialog
        open={dialog !== null}
        editing={dialog?.editing ?? null}
        models={models}
        modelsError={modelsError}
        helpersAllowed={helpersAllowed}
        onClose={() => setDialog(null)}
        onSayHi={(agent) => {
          // A new chat with the new agent, ready to type.
          navigate(null);
          setSelectedId(agent.id);
        }}
        onSaved={(agent) => {
          agentChanged(agent);
          if (!dialog?.editing && agent.available) setSelectedId(agent.id);
          setDialog(null);
        }}
      />
      {paletteOpen && (
        <CommandPalette
          items={paletteItems}
          onRun={runPalette}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      <p className="tx-sr" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}

// The first new file the reply is writing that has text to show.
function firstWritingPath(live: LiveReply): string | null {
  for (const item of live.items)
    if (
      item.type === "file_change" &&
      item.status === "inProgress" &&
      item.preview?.text
    )
      return item.preview.path;
  return null;
}

// Shown above the composer after a 409 CONNECTION_REQUIRED: the draft is kept,
// and the member connects each available connector the agent needs. An
// unavailable connector cannot be connected, so it is listed as such with no
// button.
function ConnectCard({
  required,
  connecting,
  onConnect,
}: {
  required: ConnectionRequired;
  connecting: string | null;
  onConnect: (slug: string) => void;
}) {
  const available = required.connectors.filter((c) => c.available);
  const unavailable = required.connectors.filter((c) => !c.available);
  return (
    <div
      className="connect-card"
      role="region"
      aria-label="Connect to continue"
    >
      <p>{connectCardText(required.connectors)}</p>
      {!!available.length && (
        <div className="connect-card-actions">
          {available.map((c) => (
            <button
              key={c.slug}
              type="button"
              className="tx-btn tx-primary"
              disabled={connecting !== null}
              onClick={() => onConnect(c.slug)}
            >
              {connecting === c.slug ? "Starting…" : `Connect ${c.displayName}`}
            </button>
          ))}
        </div>
      )}
      {unavailable.map((c) => (
        <p key={c.slug} className="connector-pick-hint">
          {c.displayName} is unavailable right now.
        </p>
      ))}
    </div>
  );
}

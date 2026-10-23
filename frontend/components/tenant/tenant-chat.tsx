"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiRequestError, userMessage, warnFailure } from "@/lib/api";
import { fitPanel } from "@/lib/fit-panel";
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
import { tintOf } from "@/lib/agent-look";
import {
  defaultAgent,
  fetchTenantAgents,
  fetchTenantModels,
  withAgent,
  type TenantAgent,
  type TenantModel,
} from "@/lib/tenant-agents";
import {
  applyStreamEvent,
  archiveChat,
  canSendMessage,
  chatParam,
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
  type PendingSend,
  type RunningReply,
  type SendFailure,
} from "@/lib/tenant-chat";
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
import { Icon } from "@/components/v2/icon";
import {
  useWorkspace,
  WorkspaceStage,
} from "@/components/auth/tenant-workspace";
import { AgentPicker } from "./agent-picker";
import { TenantAgentDialog } from "./tenant-agent-dialog";
import { ChatList } from "./chat-list";
import { ChatComposer } from "./chat-composer";
import {
  ChatHeader,
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
import "@/styles/v2/tenant-chat.css";
// Connect card, tool rows, connector banner and picker styles.
import "@/styles/v2/connectors.css";

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

// Below this width the sidebar is a drawer (Layout & shell §7).
const NARROW = "(max-width: 720px)";

/**
 * The tenant chat page: the member's chats in the sidebar, and either a new
 * chat (pick an agent, write the first message) or an open chat with its
 * history and live reply. The open chat is in the URL (?chat=), so refreshing
 * reopens it and a reply in progress is followed again from its snapshot.
 */
export function TenantChat() {
  const { me, actions } = useWorkspace();
  // A fresh object on every session check; the stream must not refollow.
  const recheck = useRef(actions.recheck);
  recheck.current = actions.recheck;
  const narrow = useMedia(NARROW);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [narrow]);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [announcement, setAnnouncement] = useState("");

  // ---- Agents, for new chats ----
  const [agentsLoad, setAgentsLoad] = useState<Load>({ state: "loading" });
  const [agents, setAgents] = useState<TenantAgent[]>([]);
  const [models, setModels] = useState<TenantModel[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ editing: TenantAgent | null } | null>(
    null,
  );
  const [agentsAttempt, setAgentsAttempt] = useState(0);

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
        setAgents(agentsResult.value);
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
    typeof window === "undefined" ? null : chatParam(window.location.search),
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
      if (chatId === openRef.current) return;
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

  // Sends a message's text again as a brand-new message (a not-sent steer's
  // Resend): a fresh intent, so it gets a new clientMessageId and goes
  // through the normal send path.
  const resend = (text: string) => {
    ids.reset();
    void dispatch(openId ?? NEW, text, true);
  };

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

  const dispatch = async (key: string, text: string, resent = false) => {
    const chat = openThread?.chat ?? null;
    // A resend is the text of a steer that was never read; it has no files.
    const sentFiles = resent ? [] : (draftFiles[key] ?? []);
    const busyNow = !!(openId && chat?.activeRunId);
    if (sendingRef.current || !canSendMessage(text, sentFiles, busyNow)) return;
    // A reply in progress is steered, not blocked; only a read-only or
    // missing chat refuses.
    if (openId && (!chat || readOnlyNote(chat))) return;
    const agent = openId ? null : selected;
    if (!openId && !agent?.available) return;
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
    try {
      const receipt = openId
        ? await sendMessage(chat!, text, clientMessageId, attachments)
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
      if (openRef.current !== openId) return;
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
        return;
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
        return;
      }
      const failed = sendFailure(error);
      if (openRef.current === openId) {
        setFailure({ key, failure: failed });
        if (failed.reload && openId) void load(openId, true);
      }
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
    document.querySelector<HTMLElement>(".tchat-side .btn-new")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setDrawer(false);
      toggleRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, drawer]);

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

  // ---- Files ----
  const shownFiles = useMemo(
    () => (chatFiles && chatFiles.chatId === openId ? chatFiles.files : []),
    [chatFiles, openId],
  );
  const shownViewer = viewer && viewer.chatId === openId ? viewer : null;
  // The viewed reply's files that couldn't be saved.
  const viewerRun = shownViewer?.target.runId;
  const viewerUnsaved = !viewerRun
    ? []
    : openLive?.runId === viewerRun
      ? openLive.unsaved
      : (shownThread?.runs[viewerRun]?.unsavedFiles ?? []);
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
  }, [openId, liveRunId, writingPath, narrow]);
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
        ({ files, unsaved }) => {
          addFiles(chatId, files);
          // Neither saved nor still failing: no longer in the chat.
          const gone = paths.some(
            (path) =>
              !unsaved.includes(path) && !files.some((f) => f.path === path),
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
            return {
              ...current,
              runs: {
                ...current.runs,
                [runId]: unsaved.length
                  ? { ...rest, unsavedFiles: unsaved }
                  : rest,
              },
            };
          });
          setLive((current) =>
            current?.chatId === chatId && current.reply.runId === runId
              ? { ...current, reply: { ...current.reply, unsaved } }
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
      open: (target) => openId && setViewer({ chatId: openId, target }),
      content: fileContent,
      download,
      active: shownViewer?.target ?? null,
      retry: retryFiles,
      retryState: (runId) => retries[runId],
    }),
    [openId, fileContent, download, shownViewer, retryFiles, retries],
  );
  const viewportWidth = useViewportWidth();
  const viewerFit = fitPanel(viewportWidth, 560, 640, !narrow, true);

  let stage: ReactNode;
  if (!openId && !creating) {
    stage = (
      <section className="workspace-empty tchat-new" aria-label="New chat">
        <Hero agentHue={selected ? tintOf(selected.tint).dot : undefined}>
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
          />
          {agentsLoad.state === "loading" && (
            <p className="workspace-empty-note" aria-busy="true">
              Loading agents…
            </p>
          )}
          {agentsLoad.state === "error" && (
            <div className="workspace-empty-note" role="alert">
              <p>{agentsLoad.message}</p>
              <button
                type="button"
                className="btn-soft"
                onClick={() => setAgentsAttempt((n) => n + 1)}
              >
                Try again
              </button>
            </div>
          )}
          {agentsLoad.state === "ready" && (
            <AgentPicker
              agents={agents}
              selectedId={selectedId}
              onSelect={(agent) => setSelectedId(agent.id)}
              onNew={() => openDialog(null)}
              onEdit={(agent) => openDialog(agent)}
              onChanged={agentChanged}
            />
          )}
        </Hero>
      </section>
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
      <section className="tchat-open" aria-label={chat.title || "Chat"}>
        <ChatHeader
          chat={chat}
          busy={busy}
          creating={creating}
          onRename={rename}
          onArchive={archive}
        />
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
              onResend={resend}
              onApprove={(approvalId, decision) =>
                void approve(approvalId, decision)
              }
              approvalBusy={approvalBusy}
              tenantId={me.tenant.id}
              files={shownFiles}
            />
          </NetworkActionsContext.Provider>
        </FileActionsContext.Provider>
        <div className="bottom">
          {note && !busy ? (
            <div className="tchat-readonly" role="status">
              <p>{note}</p>
              <button
                type="button"
                className="btn-soft"
                onClick={() => navigate(null)}
              >
                Start a new chat
              </button>
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
        </div>
      </section>
    );
  } else if (opened.state === "error") {
    stage = (
      <section className="workspace-empty" aria-label="Chat">
        <div className="tchat-state">
          <p role="alert">{opened.message}</p>
          {opened.notFound ? (
            <button
              type="button"
              className="btn-soft"
              onClick={() => navigate(null)}
            >
              Start a new chat
            </button>
          ) : (
            <button
              type="button"
              className="btn-soft"
              onClick={() => {
                if (openId) void load(openId);
              }}
            >
              Try again
            </button>
          )}
        </div>
      </section>
    );
  } else {
    stage = (
      <section className="workspace-empty" aria-label="Chat" aria-busy="true">
        <p className="tchat-state">Loading chat…</p>
      </section>
    );
  }

  return (
    <>
      <Panel
        kind="sidebar"
        // Gives way to an open file before the file floats over the chat.
        open={narrow ? drawer : !shownViewer || viewerFit.sidebar}
        label="Chats"
        className="tchat-side"
      >
        <ChatList
          chats={chats}
          activeId={openId}
          state={listState}
          error={listError}
          hasMore={!!cursor}
          loadingMore={loadingMore}
          onOpen={(chatId) => navigate(chatId)}
          onNew={() => navigate(null)}
          onRetry={() => setListAttempt((n) => n + 1)}
          onMore={() => void loadMore()}
          onConnectedTools={() =>
            window.location.assign(`/t/${me.tenant.id}/connected-tools`)
          }
        />
      </Panel>
      {narrow && drawer && (
        <div
          className="tchat-scrim"
          aria-hidden="true"
          onClick={() => setDrawer(false)}
        />
      )}
      <WorkspaceStage
        start={
          narrow ? (
            <button
              ref={toggleRef}
              type="button"
              className="icon-btn"
              aria-label="Chats"
              aria-expanded={drawer}
              onClick={() => setDrawer((open) => !open)}
            >
              <Icon name="sidebar" size={16} />
            </button>
          ) : null
        }
      >
        {stage}
      </WorkspaceStage>
      <Panel
        kind="activity"
        open={!!shownViewer}
        width={560}
        // Floats over the chat only when even without the sidebar the chat
        // would be under 640px.
        overlay={viewerFit.overlay}
        label="File"
      >
        {shownViewer && openId && (
          <FileViewer
            chatId={openId}
            target={shownViewer.target}
            files={shownFiles}
            live={openLive}
            onSelect={(target) => setViewer({ chatId: openId, target })}
            onClose={closeViewer}
            onDownload={download}
            unsaved={viewerUnsaved}
            saving={retries[shownViewer.target.runId]}
            onSave={() => retryFiles(shownViewer.target.runId, viewerUnsaved)}
          />
        )}
      </Panel>
      <TenantAgentDialog
        open={dialog !== null}
        editing={dialog?.editing ?? null}
        models={models}
        modelsError={modelsError}
        onClose={() => setDialog(null)}
        onSaved={(agent) => {
          agentChanged(agent);
          if (!dialog?.editing && agent.available) setSelectedId(agent.id);
          setDialog(null);
        }}
      />
      <p className="sr-only" role="status" aria-live="polite">
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

function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
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
              className="btn-solid"
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

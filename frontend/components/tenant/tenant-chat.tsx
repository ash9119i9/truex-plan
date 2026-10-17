"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiRequestError, userMessage } from "@/lib/api";
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
  canSendDraft,
  chatParam,
  fetchChat,
  fetchChats,
  fetchOlderMessages,
  liveReply,
  messageIds,
  outcomeNote,
  parseSaved,
  readOnlyNote,
  renameChat,
  sendFailure,
  sendMessage,
  startChat,
  stopRun,
  withChat,
  withOlder,
  withReceipt,
  withSaved,
  type ChatSummary,
  type ChatThread,
  type LiveReply,
  type SendFailure,
} from "@/lib/tenant-chat";
import { followRun } from "@/lib/tenant-chat-stream";
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
import { ChatHeader, Transcript, type Connection } from "./chat-transcript";
import "@/styles/v2/tenant-chat.css";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready" };

// The draft and send notes of the new-chat screen are kept under this key;
// an open chat's under its ID.
const NEW = "new";
// Below this width the sidebar is a drawer (Layout & shell §7).
const NARROW = "(max-width: 720px)";

/**
 * The tenant chat page: the member's chats in the sidebar, and either a new
 * chat (pick an agent, write the first message) or an open chat with its
 * history and live reply. The open chat is in the URL (?chat=), so refreshing
 * reopens it and a reply in progress is followed again from its snapshot.
 */
export function TenantChat() {
  const { actions } = useWorkspace();
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
  const load = useCallback(async (chatId: string, quiet = false) => {
    if (!quiet) setOpened({ state: "loading" });
    try {
      const next = await fetchChat(chatId);
      if (openRef.current !== chatId) return;
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
      const notFound = error instanceof ApiRequestError && error.status === 404;
      setOpened({
        state: "error",
        notFound,
        message: notFound
          ? "This chat doesn't exist, or you can't open it."
          : userMessage(error, "This chat couldn't be opened. Try again."),
      });
    }
  }, []);

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
      onEvent: (event) =>
        setLive((current) =>
          mine(current)
            ? { ...current!, reply: applyStreamEvent(current!.reply, event) }
            : current,
        ),
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
  }, [followChat, followRunId, followKey, load]);

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
  const [ids] = useState(() => messageIds());
  const draftKey = openId ?? NEW;
  const draft = drafts[draftKey] ?? "";

  const send = async () => {
    const key = openId ?? NEW;
    const text = drafts[key] ?? "";
    if (sendingRef.current || !canSendDraft(text)) return;
    const chat = openThread?.chat ?? null;
    if (openId && (!chat || chat.activeRunId || readOnlyNote(chat))) return;
    const agent = openId ? null : selected;
    if (!openId && !agent?.available) return;
    sendingRef.current = true;
    setSending(true);
    setFailure(null);
    const target = openId ?? `new:${agent!.id}`;
    const clientMessageId = ids.for(target, text);
    try {
      const receipt = openId
        ? await sendMessage(openId, text, clientMessageId)
        : await startChat(agent!.id, text, clientMessageId);
      ids.reset();
      setDrafts((all) => {
        if (all[key] !== text) return all;
        const { [key]: _sent, ...rest } = all;
        return rest;
      });
      setChats((list) => withChat(list, receipt.chat));
      // The person moved to another chat meanwhile: the reply runs anyway
      // and the list shows it.
      if (openRef.current !== openId) return;
      const chatId = receipt.chat.id;
      if (!openId) navigate(chatId, "replace");
      setThread((current) =>
        withReceipt(current?.chat.id === chatId ? current : null, receipt),
      );
      setOpened({ state: "ready" });
      if (receipt.chat.activeRunId === receipt.run.id)
        setLive({ chatId, reply: liveReply(receipt.run.id) });
      // A repeat of a message answered meanwhile: show what was saved.
      else void load(chatId, true);
    } catch (error) {
      const failed = sendFailure(error);
      if (openRef.current === openId) {
        setFailure({ key, failure: failed });
        if (failed.reload && openId) void load(openId, true);
      }
    } finally {
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
  const setDraft = (value: string) => {
    setDrafts((all) => ({ ...all, [draftKey]: value }));
    if (shownFailure && !shownFailure.unknown) setFailure(null);
  };

  let stage: ReactNode;
  if (!openId) {
    stage = (
      <section className="workspace-empty tchat-new" aria-label="New chat">
        <Hero agentHue={selected ? tintOf(selected.tint).dot : undefined}>
          <ChatComposer
            hero
            value={draft}
            onChange={setDraft}
            onSend={() => void send()}
            onStop={() => undefined}
            agentName={selected?.name ?? null}
            busy={false}
            sending={sending}
            ending={null}
            disabled={!selected?.available}
            failure={shownFailure}
            stopError=""
            focusKey={NEW}
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
  } else if (openThread) {
    const chat = openThread.chat;
    const note = readOnlyNote(chat);
    const busy = !!chat.activeRunId;
    stage = (
      <section className="tchat-open" aria-label={chat.title || "Chat"}>
        <ChatHeader
          chat={chat}
          busy={busy}
          onRename={rename}
          onArchive={archive}
        />
        <Transcript
          thread={openThread}
          live={openLive}
          connection={connection}
          loadingOlder={olderFor === chat.id}
          olderError={olderError}
          onLoadOlder={loadOlder}
          onReconnect={reconnect}
        />
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
            <ChatComposer
              value={draft}
              onChange={setDraft}
              onSend={() => void send()}
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
              disabled={false}
              failure={shownFailure}
              stopError={stopError}
              focusKey={chat.id}
            />
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
              onClick={() => void load(openId)}
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
        open={!narrow || drawer}
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

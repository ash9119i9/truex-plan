"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiRequestError, userMessage } from "@/lib/api";
import { LOOKS, TINTS, tintOf } from "@/lib/agent-look";
import {
  AGENT_DESCRIPTION_MAX,
  AGENT_NAME_MAX,
  createTenantAgent,
  formChanges,
  formOf,
  formProblem,
  requestIds,
  updateTenantAgent,
  type AgentForm,
  type AgentScope,
  type TenantAgent,
  type TenantModel,
} from "@/lib/tenant-agents";
import { Lanyard, Robot } from "@/components/v2/agent-badge";
import { IdCard, issueDate } from "./agent-id-card";
import { Icon } from "@/components/tx/icon";
import { Button } from "@/components/tx/button";
import { Chip } from "@/components/tx/chip";
import { Segmented } from "@/components/tx/segmented";
import { Switch } from "@/components/tx/field";
import { useRovingFocus } from "@/lib/roving-focus";
import { modelLabel } from "@/lib/turn";
import {
  DESK_STEPS,
  BEHAVIOUR_IDEAS,
  BLANK_GUIDE,
  deskProblem,
  featuredModels,
  guideSummary,
  linesOf,
  RULE_IDEAS,
  TOPIC_OPTIONS,
  type DeskGuide,
  type DeskStep,
} from "@/lib/agent-desk";
import { DeskRadios, GuideEditor, SignPad } from "./desk-guide";
import { AgentIssued } from "./agent-issued";
import { agentHandle } from "../../../shared/contracts";
import {
  fetchConnectors,
  isNotConfigured,
  MAX_CONNECTORS,
  tokenEstimateHint,
  type Connector,
  type ConnectorAccess,
} from "@/lib/tenant-connectors";
import {
  fetchSkills,
  MAX_SKILLS,
  skillNote,
  skillOptions,
  type SkillCatalog,
} from "@/lib/tenant-skills";
import { warnFailure } from "@/lib/api";

// The Agent ID desk (DESIGN-SPEC 15.3): create or edit a personal or workspace
// agent in four steps, with its ID card as the live preview. Saving sends the
// same payload as before. Who can use an agent is chosen once, at creation;
// sharing later is the board's "Share with workspace" action.

const SCOPES: { id: AgentScope; label: string; hint: string }[] = [
  { id: "personal", label: "Just me", hint: "Only you can see and use it." },
  {
    id: "tenant",
    label: "Everyone in this workspace",
    hint: "Every member can see and use it; their chats stay private. It can't be made personal again.",
  },
];

export function TenantAgentDialog({
  open,
  editing,
  models,
  modelsError,
  helpersAllowed = false,
  onClose,
  onSaved,
  onSayHi,
  initialStep = "identity",
}: {
  open: boolean;
  /** The agent being edited, or null to create one. */
  editing: TenantAgent | null;
  models: TenantModel[];
  modelsError?: string;
  /** Whether this server lets agents start helper agents. */
  helpersAllowed?: boolean;
  onClose: () => void;
  onSaved: (agent: TenantAgent) => void;
  /** After issuing: start a chat with the new agent (the celebration's Say hi). */
  onSayHi?: (agent: TenantAgent) => void;
  /** The step the desk opens on (tests and deep links). */
  initialStep?: DeskStep;
}) {
  const [form, setForm] = useState<AgentForm>(() => formOf(editing, models));
  const [scope, setScope] = useState<AgentScope>("personal");
  // What it answers, its rules and behaviour, and the signature (spec 15.3
  // steps 3 and 4). They drive the card but aren't saved yet: see submit.
  const [guide, setGuide] = useState<DeskGuide>(BLANK_GUIDE);
  const setGuidePart = (part: Partial<DeskGuide>) =>
    setGuide((g) => ({ ...g, ...part }));
  const [saving, setSaving] = useState(false);
  // Issue ID (spec 15.3): the card flips to its front and the ISSUED seal
  // lands; then the desk fades and gives way to the celebration (the legacy
  // dialog's), which stays until Say hi or Done. The agent is saved first.
  const [sealed, setSealed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [celebrated, setCelebrated] = useState<TenantAgent | null>(null);
  const issuedAgent = useRef<TenantAgent | null>(null);
  const issueTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [error, setError] = useState("");
  const titleId = useId();
  const [step, setStep] = useState<DeskStep>(initialStep);
  // The card side on show: the front while choosing who it is, the back for
  // what it can open (spec 15.3, as in the study).
  const [face, setFace] = useState<"front" | "back">(
    initialStep === "identity" ? "front" : "back",
  );
  const [visited, setVisited] = useState<Set<DeskStep>>(() => new Set());
  const [allModels, setAllModels] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const opened = useRef(false);
  // The connector catalog for the picker. null while loading or when the
  // feature is off / the fetch failed — in which case the section is hidden
  // (existing selections on an edited agent are left untouched either way).
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  // The skill catalog, null while loading or when the fetch failed. Skills an
  // edited agent already has are shown either way.
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalog | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  // The card settles slightly when something is added; restarting a CSS
  // animation needs a reflow between.
  const thud = (delay = 160) =>
    setTimeout(() => {
      const el = wrapRef.current;
      if (!el) return;
      el.classList.remove("is-thud");
      void el.offsetWidth;
      el.classList.add("is-thud");
    }, delay);
  // The card leans toward the pointer across the stage.
  const lean = (x: number, y: number) => {
    tiltRef.current?.style.setProperty(
      "--tx",
      `${((0.5 - y) * 10).toFixed(2)}deg`,
    );
    tiltRef.current?.style.setProperty(
      "--ty",
      `${((x - 0.5) * 14).toFixed(2)}deg`,
    );
  };
  const ids = useRef(requestIds());
  // Answers that arrive after the dialog closed or reopened are ignored.
  const generation = useRef(0);

  useEffect(() => {
    if (!open) return;
    generation.current++;
    setForm(formOf(editing, models));
    setScope("personal");
    setGuide(BLANK_GUIDE);
    setSealed(false);
    setLeaving(false);
    setCelebrated(null);
    issuedAgent.current = null;
    setSaving(false);
    setError("");
    setStep(initialStep);
    setFace(initialStep === "identity" ? "front" : "back");
    setVisited(new Set());
    setAllModels(false);
    setModelQuery("");
    opened.current = false;
    ids.current.reset();
    const focus = setTimeout(() => nameRef.current?.focus(), 30);
    return () => {
      generation.current++;
      clearTimeout(focus);
      issueTimers.current.forEach(clearTimeout);
      issueTimers.current = [];
    };
    // Only opening or switching agents resets the form; models arriving
    // later fill in the default model below without discarding typing.
  }, [open, editing]);

  useEffect(() => {
    if (open && !editing && !form.modelId && models[0])
      setForm((f) => ({ ...f, modelId: models[0]!.id }));
  }, [open, editing, models, form.modelId]);

  // The connector picker's catalog. A failure or a feature-off result hides
  // the section silently (connectors stays null); existing selections on an
  // edited agent are kept regardless, since the picker only reads them.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setConnectors(null);
    fetchConnectors().then(
      (result) => {
        if (!live) return;
        setConnectors(result.kind === "list" ? result.connectors : null);
      },
      (error) => {
        if (!live) return;
        setConnectors(null);
        if (!isNotConfigured(error)) warnFailure("connectors catalog", error);
      },
    );
    return () => {
      live = false;
    };
  }, [open, editing]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setSkillCatalog(null);
    fetchSkills().then(
      (catalog) => {
        if (live) setSkillCatalog(catalog);
      },
      (error) => {
        if (!live) return;
        setSkillCatalog(null);
        warnFailure("skills catalog", error);
      },
    );
    return () => {
      live = false;
    };
  }, [open, editing]);

  // Closing returns focus to whatever opened the desk (spec 18).
  useEffect(() => {
    if (!open) return;
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open]);

  // Moving to a step moves focus to its heading; opening focuses the name.
  useEffect(() => {
    if (!open) return;
    if (opened.current) heading.current?.focus();
    opened.current = true;
  }, [step, open]);
  const stepIndex = DESK_STEPS.findIndex((s) => s.id === step);
  const stepRoving = useRovingFocus(
    DESK_STEPS.map(() => ({})),
    stepIndex,
    (next) => {
      setVisited((v) => new Set(v).add(step));
      setStep(DESK_STEPS[next].id);
      setFace(next === 0 ? "front" : "back");
    },
    "horizontal",
  );
  // The model cards on show: three featured, or the whole (searched) list.
  const listed = allModels
    ? models.filter((m) =>
        m.displayName.toLowerCase().includes(modelQuery.trim().toLowerCase()),
      )
    : featuredModels(models, form.modelId);
  const modelIndex = Math.max(
    0,
    listed.findIndex((m) => m.id === form.modelId),
  );
  const modelRoving = useRovingFocus(
    listed.map(() => ({})),
    modelIndex,
    (next) => {
      const m = listed[next];
      if (m) {
        setForm((f) => ({ ...f, modelId: m.id }));
        setError("");
      }
    },
    "both",
  );

  if (!open) return null;

  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError("");
  };

  // Toggles a connector in the form, preserving selection order; a new slug
  // is appended (so the order stays stable) and the cap is enforced here too.
  const toggleConnector = (slug: string) => {
    setFace("back");
    if (!form.connectorSlugs.includes(slug)) thud();
    setForm((f) => {
      const has = f.connectorSlugs.includes(slug);
      const next = has
        ? f.connectorSlugs.filter((s) => s !== slug)
        : f.connectorSlugs.length >= MAX_CONNECTORS
          ? f.connectorSlugs
          : [...f.connectorSlugs, slug];
      return { ...f, connectorSlugs: next };
    });
    setError("");
  };
  // Sets a connector's access (only offered when it has write tools). The
  // form keeps a read_only flag; cleanForm prunes it if the connector is
  // later removed.
  const setConnectorAccess = (slug: string, access: ConnectorAccess) => {
    setForm((f) => ({
      ...f,
      connectorAccess: { ...f.connectorAccess, [slug]: access },
    }));
    setError("");
  };
  const atConnectorCap = form.connectorSlugs.length >= MAX_CONNECTORS;
  // Toggles a skill, keeping the chosen order; a new one is appended.
  const toggleSkill = (id: string) => {
    setFace("back");
    if (!form.skillIds.includes(id)) thud();
    setForm((f) => {
      const has = f.skillIds.includes(id);
      const next = has
        ? f.skillIds.filter((s) => s !== id)
        : f.skillIds.length >= MAX_SKILLS
          ? f.skillIds
          : [...f.skillIds, id];
      return { ...f, skillIds: next };
    });
    setError("");
  };
  const atSkillCap = form.skillIds.length >= MAX_SKILLS;
  const skillRows = skillOptions(
    skillCatalog?.skills ?? [],
    editing?.skills ?? [],
  );
  const selectedModel = models.find((m) => m.id === form.modelId);
  const changes = editing ? formChanges(editing, form) : null;
  const problem =
    formProblem(form) ?? (selectedModel ? null : "Choose an available model.");
  const canSubmit =
    !saving && !problem && (!changes || Object.keys(changes).length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    const version = generation.current;
    setSaving(true);
    setError("");
    try {
      const saved = editing
        ? await updateTenantAgent(editing.id, editing.revision, changes!)
        : await createTenantAgent(form, scope, ids.current.for(form, scope));
      if (generation.current !== version) return;
      // TODO(agent-guide): send the Rules step and the signature once
      // platform-next stores `instructions` and `sig` (DESIGN-SPEC 15.1).
      // Uncomment when the endpoint exists:
      // await saveAgentGuide(saved.id, {
      //   topics: guide.topics,
      //   rules: linesOf(guide.rules),
      //   rulesAs: guide.rulesAs,
      //   behaviour: linesOf(guide.behaviour),
      //   behaviourAs: guide.behaviourAs,
      //   sig: guide.sig || null,
      // });
      if (editing) {
        onSaved(saved);
        return;
      }
      issuedAgent.current = saved;
      // The flip takes 0.8 s and overshoots; the seal waits until it settles.
      const flip = face === "back" ? 850 : 0;
      setFace("front");
      issueTimers.current = [
        setTimeout(() => {
          setSealed(true);
          thud(240);
        }, flip),
        setTimeout(() => setLeaving(true), flip + 1300),
        setTimeout(() => setCelebrated(saved), flip + 1550),
      ];
    } catch (e) {
      if (generation.current !== version) return;
      setError(
        e instanceof ApiRequestError && e.code === "STALE_REVISION"
          ? "This agent was changed somewhere else. Close this dialog and open it again to edit the latest version."
          : userMessage(e),
      );
    } finally {
      // An issued card keeps "Issuing…" until the desk closes.
      if (generation.current === version && !issuedAgent.current)
        setSaving(false);
    }
  };
  // Hands the issued agent back and says so. Closing mid-seal does this at
  // once, so the new agent is never lost from the list.
  const finishIssue = () => {
    const agent = issuedAgent.current;
    if (!agent) return;
    issuedAgent.current = null;
    issueTimers.current.forEach(clearTimeout);
    issueTimers.current = [];
    onSaved(agent);
  };
  const close = () => (issuedAgent.current ? finishIssue() : onClose());
  const sayHi = () => {
    const agent = issuedAgent.current;
    finishIssue();
    if (agent) onSayHi?.(agent);
  };

  const scopeLabel = editing
    ? editing.source === "tenant"
      ? "Workspace agent"
      : "Personal agent"
    : scope === "tenant"
      ? "Workspace agent"
      : "Personal agent";
  const identityProblem = deskProblem(form);
  const at = DESK_STEPS.findIndex((s) => s.id === step);
  const last = at === DESK_STEPS.length - 1;
  const footProblem =
    identityProblem && step !== "identity"
      ? `${identityProblem} on the Identity step first`
      : null;
  // Names for the card's back, from the catalogues or the saved agent.
  const connectorName = (slug: string) =>
    connectors?.find((c) => c.slug === slug)?.displayName ??
    editing?.connectors.find((c) => c.slug === slug)?.displayName ??
    slug;
  // R/W only means something where the connector has write tools; without the
  // catalogue, the saved access stands.
  const connectorWrites = (slug: string) => {
    const c = connectors?.find((x) => x.slug === slug);
    return c ? c.writeTools.length > 0 : true;
  };
  const skillName = (id: string) =>
    skillRows.find((s) => s.id === id)?.displayName ?? id;
  const stepCount = (id: DeskStep) =>
    id === "access"
      ? form.connectorSlugs.length + form.skillIds.length
      : id === "rules"
        ? linesOf(guide.rules).length + linesOf(guide.behaviour).length
        : 0;
  const go = (next: DeskStep) => {
    setStep(next);
    setFace(next === "identity" ? "front" : "back");
    setVisited((v) => new Set(v).add(step));
  };

  const idCard = (
    <IdCard
      name={form.name.trim()}
      handle={form.name.trim() ? agentHandle(form.name) : ""}
      purpose={form.description.trim()}
      look={form.look}
      tint={form.tint}
      model={selectedModel ? modelLabel(selectedModel.displayName) : ""}
      issued={editing ? undefined : issueDate(new Date())}
      workspace={editing ? editing.source === "tenant" : scope === "tenant"}
      access={form.connectorSlugs.map((slug) => ({
        name: connectorName(slug),
        write:
          (form.connectorAccess[slug] ?? "read_write") === "read_write" &&
          connectorWrites(slug),
      }))}
      skills={form.skillIds.map(skillName)}
      sealed={sealed}
      sig={guide.sig}
      guide={guideSummary(guide)}
      face={face}
    />
  );
  if (celebrated)
    return (
      <AgentIssued
        name={celebrated.name}
        handle={agentHandle(celebrated.name)}
        issued={issueDate(new Date())}
        canChat={celebrated.available && !!onSayHi}
        onSayHi={sayHi}
        onDone={close}
      >
        {idCard}
      </AgentIssued>
    );
  return (
    <div
      className={leaving ? "idd-scrim is-leaving" : "idd-scrim"}
      onMouseDown={close}
    >
      <div
        className="idd"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.defaultPrevented) close();
        }}
      >
        <form
          className="idd-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!last) go(DESK_STEPS[at + 1].id);
            else void submit();
          }}
        >
          <header className="idd-head">
            <h2 id={titleId} className="t-h3">
              {editing ? `Edit ${editing.name}` : "New agent"}
            </h2>
            <p className="idd-sub">{DESK_STEPS[at].sub}</p>
          </header>
          <div
            className="idd-steps"
            role="tablist"
            aria-label="Steps"
            onKeyDown={stepRoving.onKeyDown}
          >
            {DESK_STEPS.map((s, i) => {
              const done =
                visited.has(s.id) && (s.id !== "identity" || !identityProblem);
              return (
                <button
                  key={s.id}
                  ref={stepRoving.ref(i)}
                  type="button"
                  role="tab"
                  id={`${titleId}-${s.id}`}
                  aria-selected={s.id === step}
                  aria-controls={`${titleId}-panel`}
                  tabIndex={stepRoving.tabIndex(i)}
                  className={s.id === step ? "idd-step is-on" : "idd-step"}
                  onClick={() => go(s.id)}
                >
                  <span
                    className={done ? "idd-step-no is-done" : "idd-step-no"}
                    aria-hidden="true"
                  >
                    {done ? <Icon name="check" size="sm" /> : i + 1}
                  </span>
                  <span className="idd-step-label">{s.label}</span>
                  {stepCount(s.id) > 0 && (
                    <span className="idd-step-count mono">
                      {stepCount(s.id)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div
            className="idd-body"
            role="tabpanel"
            id={`${titleId}-panel`}
            aria-labelledby={`${titleId}-${step}`}
          >
            {/* The step's name, for screen readers; it takes focus when the step opens. */}
            <h3 className="idd-h" tabIndex={-1} ref={heading}>
              {DESK_STEPS[at].label}
            </h3>

            {step === "identity" && (
              <>
                <DeskField
                  label="Name"
                  hint={
                    form.name.trim() ? `@${agentHandle(form.name)}` : undefined
                  }
                >
                  {(a11y) => (
                    <input
                      ref={nameRef}
                      className="tx-input"
                      {...a11y}
                      value={form.name}
                      maxLength={AGENT_NAME_MAX}
                      placeholder="Research Scout"
                      onChange={(e) => set("name", e.target.value)}
                    />
                  )}
                </DeskField>
                <DeskField
                  label="Purpose"
                  hint={`${form.description.trim().length}/${AGENT_DESCRIPTION_MAX}`}
                >
                  {(a11y) => (
                    <textarea
                      className="tx-input"
                      {...a11y}
                      value={form.description}
                      rows={2}
                      maxLength={AGENT_DESCRIPTION_MAX}
                      placeholder="What this specialist owns"
                      onChange={(e) => set("description", e.target.value)}
                    />
                  )}
                </DeskField>
                <fieldset
                  className="idd-set"
                  aria-labelledby={`${titleId}-photo`}
                >
                  <div className="idd-label-row">
                    <span className="idd-label" id={`${titleId}-photo`}>
                      Photo
                    </span>
                    <div className="idd-photo-tools">
                      <div
                        className="idd-tints"
                        role="radiogroup"
                        aria-label="Backdrop"
                      >
                        {TINTS.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            role="radio"
                            aria-checked={form.tint === t.id}
                            aria-label={t.label}
                            title={t.label}
                            className="idd-tint"
                            style={{ background: t.bg }}
                            onClick={() => {
                              set("tint", t.id);
                              setFace("front");
                            }}
                          />
                        ))}
                      </div>
                      <button
                        type="button"
                        className="idd-link"
                        onClick={() => {
                          set(
                            "look",
                            (form.look +
                              1 +
                              Math.floor(Math.random() * (LOOKS.length - 1))) %
                              LOOKS.length,
                          );
                          setFace("front");
                        }}
                      >
                        shuffle
                      </button>
                    </div>
                  </div>
                  <div
                    className="idd-looks"
                    role="radiogroup"
                    aria-label="Look"
                  >
                    {LOOKS.map((l, i) => (
                      <button
                        key={l.name}
                        type="button"
                        role="radio"
                        aria-checked={form.look === i}
                        aria-label={l.name}
                        title={l.name}
                        className={
                          form.look === i ? "idd-look is-on" : "idd-look"
                        }
                        style={
                          form.look === i
                            ? { background: tintOf(form.tint).bg }
                            : undefined
                        }
                        onClick={() => {
                          set("look", i);
                          setFace("front");
                        }}
                      >
                        <Robot look={i} size={36} />
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="idd-set">
                  <legend className="idd-label">Model</legend>
                  {allModels && models.length > 7 && (
                    <input
                      className="tx-input idd-model-search"
                      type="search"
                      aria-label="Search models"
                      placeholder="Search models"
                      value={modelQuery}
                      onChange={(e) => setModelQuery(e.target.value)}
                    />
                  )}
                  {models.length === 0 ? (
                    <p className="idd-note is-bad" role="alert">
                      {modelsError || "No models available"}
                    </p>
                  ) : (
                    <div
                      className="idd-models"
                      role="radiogroup"
                      aria-label="Model"
                      onKeyDown={modelRoving.onKeyDown}
                    >
                      {listed.map((m, i) => (
                        <button
                          key={m.id}
                          ref={modelRoving.ref(i)}
                          type="button"
                          role="radio"
                          aria-checked={m.id === form.modelId}
                          className={
                            m.id === form.modelId
                              ? "idd-model is-on"
                              : "idd-model"
                          }
                          tabIndex={i === modelIndex ? 0 : -1}
                          onClick={() => set("modelId", m.id)}
                        >
                          <span className="idd-model-name">
                            {modelLabel(m.displayName)}
                          </span>
                          <span className="idd-model-dot" aria-hidden="true">
                            {m.id === form.modelId && (
                              <Icon name="check" size="sm" />
                            )}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {models.length > 3 && (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-expanded={allModels}
                      onClick={() => setAllModels((all) => !all)}
                    >
                      {allModels ? "Fewer" : `All models (${models.length})`}
                    </Button>
                  )}
                  {models.length > 0 && !selectedModel && (
                    <p className="idd-note is-bad">
                      Its model is no longer available. Choose another to save.
                    </p>
                  )}
                </fieldset>
              </>
            )}

            {step === "access" && (
              <>
                <fieldset className="idd-set">
                  <legend className="idd-label">Connected tools</legend>
                  {connectors === null ? (
                    <p className="idd-note">
                      No connected tools to offer here.
                    </p>
                  ) : (
                    <>
                      <div className="idd-stickers">
                        {connectors.map((c) => {
                          const checked = form.connectorSlugs.includes(c.slug);
                          return (
                            <span
                              key={c.slug}
                              className={
                                checked ? "idd-sticker is-on" : "idd-sticker"
                              }
                            >
                              <button
                                type="button"
                                aria-pressed={checked}
                                disabled={!checked && atConnectorCap}
                                onClick={() => toggleConnector(c.slug)}
                              >
                                <span
                                  className="idd-sticker-mark"
                                  aria-hidden="true"
                                >
                                  {c.displayName.charAt(0).toUpperCase()}
                                </span>
                                {c.displayName}
                              </button>
                              {checked && c.writeTools.length > 0 && (
                                <ConnectorAccessChoice
                                  slug={c.slug}
                                  displayName={c.displayName}
                                  access={
                                    form.connectorAccess[c.slug] ?? "read_write"
                                  }
                                  onChange={setConnectorAccess}
                                />
                              )}
                              {checked && c.connection.status !== "active" && (
                                <span className="idd-note">
                                  Not connected yet. Connect it from Connected
                                  tools.
                                </span>
                              )}
                            </span>
                          );
                        })}
                      </div>
                      <p className="idd-note">
                        Tools that change data ask for your approval each time.
                        Up to {MAX_CONNECTORS}.
                      </p>
                    </>
                  )}
                </fieldset>
                {skillRows.length > 0 && (
                  <fieldset className="idd-set">
                    <legend className="idd-label">Skills</legend>
                    <div className="idd-chips">
                      {skillRows.map((skill) => {
                        const checked = form.skillIds.includes(skill.id);
                        const note = skillNote(
                          skill,
                          skillCatalog?.scripts ?? false,
                        );
                        return (
                          <Chip
                            key={skill.id}
                            pressed={checked}
                            disabled={
                              !checked && (atSkillCap || !skill.available)
                            }
                            title={skill.description || undefined}
                            onClick={() => toggleSkill(skill.id)}
                          >
                            {skill.displayName}
                            {note ? ` · ${note}` : ""}
                          </Chip>
                        );
                      })}
                    </div>
                    <p className="idd-note">
                      Instructions and files it reads when a task calls for
                      them. Up to {MAX_SKILLS}.
                    </p>
                  </fieldset>
                )}
                <fieldset className="idd-set">
                  <legend className="idd-label">
                    Knowledge{" "}
                    <span className="tx-pill tx-pill-line tx-pill-sm">
                      Soon
                    </span>
                  </legend>
                </fieldset>
                {(helpersAllowed || editing?.helpers) && (
                  <fieldset className="idd-set">
                    <legend className="idd-label">Helpers</legend>
                    <Switch
                      label="Use helper agents"
                      checked={form.helpers}
                      onChange={(on) => set("helpers", on)}
                    />
                    <p className="idd-note">
                      For work that spans several sources, it can run helpers in
                      parallel. A helper never changes an outside system on its
                      own; every such change still asks you first.
                    </p>
                    {!helpersAllowed && form.helpers && (
                      <p className="idd-note">
                        Helpers are off in this workspace. Chats run without
                        them.
                      </p>
                    )}
                  </fieldset>
                )}
              </>
            )}

            {step === "rules" && (
              <>
                <DeskRadios
                  legend="What it answers"
                  value={guide.topics}
                  options={TOPIC_OPTIONS.map((option) => ({
                    id: option.id,
                    label: option.label,
                    hint: option.hint(form.description.trim()),
                  }))}
                  onChange={(topics) => {
                    setGuidePart({ topics });
                    setFace("back");
                  }}
                />
                <GuideEditor
                  label="Rules"
                  noun="rule"
                  value={guide.rules}
                  as={guide.rulesAs}
                  onChange={(rules) => {
                    setGuidePart({ rules });
                    setFace("back");
                  }}
                  onAs={(rulesAs) => setGuidePart({ rulesAs })}
                  placeholder="Never share customer data outside the workspace"
                  ideas={RULE_IDEAS}
                />
                <GuideEditor
                  label="Behaviour"
                  noun="behaviour"
                  value={guide.behaviour}
                  as={guide.behaviourAs}
                  onChange={(behaviour) => {
                    setGuidePart({ behaviour });
                    setFace("back");
                  }}
                  onAs={(behaviourAs) => setGuidePart({ behaviourAs })}
                  placeholder="Lead with the answer, then the detail"
                  ideas={BEHAVIOUR_IDEAS}
                />
              </>
            )}

            {step === "sign" && (
              <>
                {!editing ? (
                  <DeskRadios
                    legend="Who can use it"
                    value={scope}
                    options={SCOPES}
                    onChange={(next) => {
                      setScope(next);
                      setFace("front");
                      setError("");
                    }}
                  />
                ) : (
                  <p className="idd-note">
                    {editing.source === "tenant"
                      ? "Everyone in this workspace can use it."
                      : "Only you can use it."}
                  </p>
                )}
                <section
                  className="idd-set"
                  aria-labelledby={`${titleId}-sign`}
                >
                  <div className="idd-label-row">
                    <span className="idd-label" id={`${titleId}-sign`}>
                      Signature <span className="idd-hint">optional</span>
                    </span>
                  </div>
                  <SignPad
                    value={guide.sig}
                    onChange={(sig) => {
                      setGuidePart({ sig });
                      setFace("back");
                    }}
                    onStart={() => setFace("back")}
                  />
                </section>
              </>
            )}
          </div>
          {error && (
            <p className="idd-note is-bad idd-error" role="alert">
              {error}
            </p>
          )}
          <footer className="idd-foot">
            {footProblem && (
              <span className="idd-note is-bad">{footProblem}</span>
            )}
            <span className="pt-spacer" />
            {at === 0 ? (
              <Button size="lg" onClick={close}>
                Cancel
              </Button>
            ) : (
              <Button size="lg" onClick={() => go(DESK_STEPS[at - 1].id)}>
                Back
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={last && !canSubmit}
              working={saving ? (editing ? "Saving…" : "Issuing…") : undefined}
            >
              {!last ? (
                <>
                  Continue
                  <Icon name="chev" size="sm" />
                </>
              ) : editing ? (
                "Save changes"
              ) : (
                "Issue ID"
              )}
            </Button>
          </footer>
        </form>

        <div
          className="idd-stage"
          onPointerMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            lean(
              (e.clientX - box.left) / box.width,
              (e.clientY - box.top) / box.height,
            );
          }}
          onPointerLeave={() => lean(0.5, 0.5)}
        >
          <Button
            className="idd-x"
            iconOnly
            icon="x"
            variant="ghost"
            size="sm"
            aria-label="Close"
            onClick={close}
          />
          <Lanyard
            onTap={() => setFace((f) => (f === "front" ? "back" : "front"))}
          >
            <div ref={wrapRef} className="idc-wrap">
              <div ref={tiltRef} className="idc-tilt">
                {idCard}
              </div>
            </div>
          </Lanyard>
          <span className="idd-stage-note" aria-hidden="true">
            Drag to swing · tap to flip
          </span>
          <Segmented
            label="Card side"
            size="sm"
            options={[
              { value: "front", label: "Front" },
              { value: "back", label: "Back" },
            ]}
            value={face}
            onChange={setFace}
          />
        </div>
      </div>
    </div>
  );
}

// The read/write access choice for one attached connector, shown only when it
// has write tools (spec 15.3 READ / R/W). R/W (the default, as before) lets
// its write tools run, each guarded by a per-call approval in the chat; Read
// strips them.
function ConnectorAccessChoice({
  slug,
  displayName,
  access,
  onChange,
}: {
  slug: string;
  displayName: string;
  access: ConnectorAccess;
  onChange: (slug: string, access: ConnectorAccess) => void;
}) {
  return (
    <Segmented
      label={`${displayName} access`}
      size="sm"
      options={[
        { value: "read_only", label: "Read" },
        { value: "read_write", label: "R/W" },
      ]}
      value={access}
      onChange={(value) => onChange(slug, value)}
    />
  );
}

// A desk field: the label row carries a mono hint on the right (the handle, a
// count), as in the study, tied to the control by aria-describedby.
function DeskField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (a11y: { id: string; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="tx-field">
      <div className="idd-label-row">
        <label htmlFor={id}>{label}</label>
        {hint && (
          <span className="idd-hint mono" id={`${id}-hint`}>
            {hint}
          </span>
        )}
      </div>
      {children({ id, "aria-describedby": hint ? `${id}-hint` : undefined })}
    </div>
  );
}

# Truex assistant capabilities

Open **Capabilities, documents & visuals** above the transcript to choose a task, upload
documents, download generated files, explore saved visuals, and manage a goal. The seven capabilities are
explanations/planning, clarification questions, web research, documents, goal
tracking, Visualize, and helper-agent collaboration. Project development, Git, and command
execution are excluded.

See [Visualize](VISUALIZE.md) for interactive rendering, the supported widget bridge,
exports, storage and browser isolation.

## Runtime integration

The adapter explicitly enables normal-mode clarification, goals, and collaboration.
Questions use the existing request/answer pipeline with schema validation and
expiry. Plans appear in Session activity. Goal controls read, set, pause, resume,
complete, and clear goals; the existing `/goal` command remains available. Goal
creation is instructed to require an explicit user request. Helpers inherit the
restricted runtime configuration; the main agent handles document calls and
clarifications. Collaboration and web/document tool activity appear in the activity
panel without exposing raw arguments or internal runtime metadata.

`truex_models.webSearch` accepts `live` (default), `cached`, or `disabled`.
Native web research requires a Responses provider supporting hosted web search.
For providers without it, set `webSearch: "disabled"` and attach a web research
HTTP MCP connector through Connected tools. A configured feature is not a guarantee
that a provider supports it. The assistant is instructed to use real sources,
provide direct Markdown citations, and disclose unavailable search.

Document tools are registered with `thread/start.dynamicTools` and executed by the
adapter through `item/tool/call`, following the
[App Server protocol](https://learn.chatgpt.com/docs/app-server). The pinned local
protocol is the source of truth for fields. Unknown dynamic tools and namespaces
are rejected; document arguments are validated independently of the model.

## Document behavior and limits

- Start a **new conversation** after updating to register document tools. Existing
  conversations remain usable, but the UI explains when document tools are absent.
- Upload PDF, DOCX, XLSX, PPTX, TXT, Markdown, CSV, or TSV. Maximum 1 MB per file,
  50 files and 25 MB per conversation. Filenames cannot select directories.
- The model can list documents, read extracted text in 20,000-character chunks,
  and create PDF, DOCX, XLSX, or PPTX files. Generated source is retained for later
  revisions. Downloads use attachment headers and disable content sniffing.
- Revisions create a new immutable file linked to its source. Content can be
  regenerated; imported visual formatting, macros, charts, and embedded objects
  are not preserved. These tools do not perform Office automation.
- PDF extraction reads the first 100 pages and does not perform OCR. PDF generation
  supports Western European text with the standard Helvetica font. Unsupported
  glyphs fail explicitly. Word, Excel, and PowerPoint support Unicode text.
- Spreadsheet extraction includes up to 2,000 populated rows per sheet. Creation
  supports up to 20 sheets with 2,000 rows and 100 columns each, with scalar values;
  formulas and recalculation are not supported. Presentation creation supports up
  to 50 slides, 8 bullets per slide, 120-character slide titles, and 250-character
  bullets. Office ZIP expansion is bounded to 20 MB and 3,000 entries.
- Corrupt/encrypted/unsupported documents return a processing failure rather than
  successful output. The model receives tool failures and must not claim success.

Files and metadata live in generated conversation workspaces on the agent-core
runtime volume. Preserve that volume across restarts. Forks copy the source
conversation's documents to the new workspace. Downloads and uploads route through
the session's existing owner and policy checks. The application still has no user
authentication or tenant authorization; keep the existing internal deployment
boundary. Local shell/file runtime tools remain disabled.

## Verification

Document tests validate real binaries and re-upload them to exercise extraction,
check revisions and chunking, and reject cross-conversation access and oversized
or malformed inputs. A real pinned-runtime fixture tests clarification answers,
model-called document generation, web tool configuration, goal controls and forked
documents. HTTP integration checks upload, listing, attachment download and session
isolation. Provider responses in these tests are simulated; they do not establish
live search-provider availability or model reasoning quality.

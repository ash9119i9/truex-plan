# GTM plan: Truex for SAP transformation teams

Status: draft for review, 2026-10-22
Owner: founding team
Companion file: [target-accounts.csv](target-accounts.csv)

## 1. Executive summary

Truex should not launch as a generic "AI agent platform." It should launch as a **secure AI workbench for SAP transformation programs**, sold first to the consultancies and program offices that are already spending heavily to move ECC customers to S/4HANA before the 2027/2030 deadlines.

The wedge is document-heavy program work that does not require an SAP connector:

- program knowledge search across SOWs, blueprints, workshop notes, tickets and cutover plans;
- workshop transcripts → decisions, actions and RAID logs;
- weekly status packs and steering-committee summaries;
- test-defect triage and duplicate clustering from exports;
- data-migration field mapping from spreadsheets and legacy specs;
- proposal/RFP responses for SAP consultancies;
- training and cutover documentation.

This is a real, immediate pain. It is also a market where the incumbent (SAP Joule) is strong on SAP knowledge but weak on a program's own artifacts, and where generic chatbots are usually blocked by security teams. Truex's differentiators are tenant isolation, citations, document generation, HTTP MCP connectors and an inspectable run history — not "another chat box."

The first commercial target is **India-based SAP consultancies and system integrators (SIs)**, whose delivery teams serve global clients and can adopt a tool without a data-residency review. The second target is **UK mid-market enterprises with an active program**. DACH is the highest-pain market, but most DACH enterprises will require a private/sovereign deployment; treat it as a third wave, not a first beachhead. Saudi Arabia stays a separate track (see `Millions/`).

The first 90 days should produce: two design partners, five pilots (at least three paid), two SI channel agreements, one case study (anonymized if necessary), and a go/no-go decision on building a read-only SAP OData connector.

## 2. Product truth: what we can sell today

This section is deliberately strict. The SAP use cases in `usecase/` are proposals, not shipped features. Selling them as existing capability would create a trust and delivery problem.

### 2.1 Sellable now

| Capability | Evidence in repo | Customer-facing claim |
| --- | --- | --- |
| Multi-tenant chat with agents, goals, fork, compact, steer | `README.md`, `docs/TRUEX_RUNTIME.md` | "A governed workspace for long-running analysis, not a one-shot chatbot." |
| Document upload and PDF/DOCX/XLSX/PPTX generation | `docs/ASSISTANT_CAPABILITIES.md` | "Turn program artifacts into deliverables." |
| Web research with sources | `docs/ASSISTANT_CAPABILITIES.md` | "Research SAP notes, vendor material and public sources with citations." |
| HTTP MCP connectors, read-only by default | `docs/MCP.md` | "Connect approved systems without giving the model shell or file access." |
| Per-user OAuth and write approvals | `platform-next` (commit `339bb34`) | "Users act as themselves; writes require approval." Verify this is the stack being demoed. |
| Tenant-scoped access and run history | `README.md`, platform docs | "Workspace isolation and an inspectable run history." |

### 2.2 Not sellable yet

| Gap | Consequence |
| --- | --- |
| No SAP connector | Cannot answer "which POs are overdue?" from live SAP data. |
| SAP use cases are proposals | Do not demo procurement/sales/invoice assistants as working product. |
| No SOC 2 / ISO 27001 evidence | Enterprise security reviews will stall. Use a security questionnaire and a pilot-friendly posture; do not claim certification. |
| No enterprise SSO/SCIM evidenced | Large enterprises may reject; target teams that can use Google auth or a controlled pilot tenant. |
| Default runtime is AWS `us-east-1` | EU/India data-residency-sensitive buyers need a private deployment plan. |
| Stable `platform` uses static connector headers; `platform-next` has OAuth | Demo only on the verified stack. Do not promise per-user OAuth on the stable stack. |
| No SAP production references | Use design-partner language and measure outcomes; do not invent ROI. |

### 2.3 Claims policy

**Can say:** "Truex helps SAP program teams turn documents, workshops and test evidence into answers and deliverables, with tenant isolation and citations."

**Cannot say:** "Truex is an SAP-certified solution," "Truex replaces Joule," "Truex reads/writes your SAP system," "SOC 2 compliant," "used by [named customer]" (until contracted and approved).

## 3. Market evidence

### 3.1 The deadline is real, and slipping

- Gartner: at the end of 2024 only ~39% of ~35,000 ECC customers (~14,000) had moved to S/4HANA. Gartner projected ~17,000 holdouts in 2027 and ~13,000 still on ECC in 2030 ([CIO, June 2025](https://www.cio.com/article/4000543)).
- SAP ECC mainstream maintenance ends 31 December 2027; extended support runs to 2030 at a premium.
- DSAG's 2026 investment survey: 54% still run ECC; of those still on ECC, 37% plan to switch by the end of 2027, 48% by 2030 and 4% by 2033 ([The Register, Feb 2026](https://www.theregister.com/off-prem/2026/02/27/half-of-german-speaking-sap-users-to-stay-on-ecc-to-2030/4657165)).
- SAPinsider 2026 (296 respondents): 55% have deployed S/4HANA but only 34% have fully completed the transition; 43% cite SAP's AI announcements as a primary external factor shaping ERP strategy, overtaking the 2027 deadline ([SAPinsider, Apr 2026](https://sapinsider.org/map/2026-sap-s4hana-migration-cloud-ai-bottleneck)).

**Implication:** a large population of programs is mid-flight, under pressure, and buying help now. The buyer is not "a company curious about AI"; it is a program director with a date and a budget.

### 3.2 Programs routinely overrun

Horváth's 2025 study of 200 SAP users (€200M+ revenue):

- >60% reported significant deviations in budget, schedule or quality;
- projects take ~30% longer than planned;
- 65% reported strong or very strong quality deficits;
- 98% use external support;
- >2/3 prefer private cloud or on-premise hosting ([Horváth, April 2025](https://www.horvath-partners.com/en/press/detail/study-shows-sap-s-4hana-transformations-rarely-go-as-planned-60-percent-exceed-budget-and-schedule-two-thirds-dissatisfied-with-result-quality)).

**Implication:** the pain is not "we lack an AI strategy." It is "we are late, over budget, short of senior people, and drowning in documents." Sell to that.

Sovereignty is a live buying criterion, not a compliance afterthought. Vitakraft chose STACKIT as its RISE hyperscaler specifically to keep data in Germany and enable compliant AI use ([q.beyond, Sep 2026](https://www.qbeyond.de/en/press-releases/2026/vitakraft-selects-qbeyond-as-its-sap-transformation-partner)). DSAG's 2026 survey also shows 56% of S/4HANA users on-premise. Any plan that assumes DACH enterprises will accept a US-hosted pilot is wrong; that is why the sequence below puts DACH after a private deployment option exists.

### 3.3 AI pilots stall in production

- Deloitte's 2026 State of AI (3,235 leaders): only 25% had moved 40% or more of their AI pilots into production; close to three-quarters plan to deploy agentic AI within two years, but only 21% report a mature agent-governance model ([Deloitte, Jan 2026](https://www.deloitte.com/us/en/about/press-room/state-of-ai-report-2026.html)).

**Implication:** "we help you get from pilot to production with governance" is a stronger message than "we have agents."

### 3.4 Joule is the incumbent, not the enemy

SAP Joule for Consultants is priced at **35 AI Units per user per month at €7 per AI Unit**, i.e. ~€245/user/month (~€2,940/user/year) before volume terms ([SAP pricing](https://www.sap.com/products/artificial-intelligence/pricing.html)). SAP-delivered agents are 0.02 AI Units per action. Custom agents can run in Joule Studio, free through the end of 2026.

Joule's strength is authoritative SAP knowledge: 250M lines of ABAP, 30M lines of CDS, 9+ TB of SAP content, 100+ certifications. It is the default for "how does this SAP process work?"

Joule's gap is the customer's own program: workshop transcripts, SOWs, RAID logs, test evidence, data-mapping spreadsheets, internal status packs and cross-tool synthesis. That is where Truex should sit.

**Positioning:** "Joule knows SAP. Truex knows your program." Complementary, not competitive. If a buyer already has Joule, ask for the artifacts Joule does not ingest well.

### 3.5 The services market is the channel

SAP S/4HANA SI and transformation services are forecast to exceed **$108.5B by 2032** ([SAPinsider, Feb 2026](https://sapinsider.org/blogs/sap-s-4hana-systems-integrator-services-market-to-pass-100-billion-by-2032)). SIs are measured on utilization and margin, and are short of experienced consultants. A tool that shortens junior ramp and proposal turnaround is a margin product, not an IT cost.

### 3.6 Competitive landscape

| Alternative | Strength | Gap Truex exploits |
| --- | --- | --- |
| SAP Joule / Joule for Consultants | Authoritative SAP knowledge; bundled with SAP; in-system actions | Program artifacts, cross-tool synthesis, SI deliverables, price |
| Microsoft Copilot / Google Gemini | Ubiquitous; office integration | SAP program context, governed connectors, deliverable generation |
| ChatGPT / Claude / Perplexity | Fast, cheap, capable | Enterprise controls, tenant isolation, no artifact workspace, security review |
| Glean / enterprise search | Strong internal search | SAP program workflows, test/data deliverables, SI multi-client model |
| Document AI / OCR tools | Extraction accuracy | End-to-end reasoning, citations, generation, program cadence |
| Big-bank SI "AI accelerators" | Trusted relationship, budget | Independent, faster to deploy, no lock-in to one SI's methodology |

The winning comparison is not "better model." It is "the only tool that understands the program's artifacts and produces the program's deliverables inside the security boundary the program already accepts."

## 4. Ideal customer profile

### 4.1 Beachhead A: SAP consultancies and SIs

**Firmographics:** 50–5,000 employees; SAP practice of 20–3,000 consultants; India, UK, DACH, Benelux, Nordics; RISE/GROW pipeline; public S/4HANA case studies.

**Trigger:** new logo wins, a large transformation program starting, aggressive hiring of juniors, margin pressure, an "AI in delivery" initiative.

**Buyer:** managing partner, SAP practice head, COO, innovation/AI lead.

**User:** proposal team, program managers, functional consultants, junior consultants, test leads.

**Why they buy:** win more proposals, ramp juniors faster, protect margins, retain knowledge when seniors leave, standardize deliverables.

**Budget:** practice-level tooling or innovation budget; can start at 20–50 seats without procurement.

**Why this sequence:** India has the largest concentration of SAP delivery talent and SIs serving global clients; decisions are faster, and internal program artifacts are a smaller residency hurdle. The UK has large active programs and English-language procurement. DACH has the strongest deadline pressure and the clearest evidence of overruns (DSAG, Horváth), but also the strictest sovereignty expectations; enter after a private deployment option exists. The US is attractive but demands more security maturity and a local reference; enter after five paying customers.

### 4.2 Beachhead B: mid-market enterprises in an active program

**Firmographics:** €200M–€5B revenue; manufacturing, consumer products, pharma, utilities, retail; active ECC→S/4HANA or S/4HANA upgrade; 5–50 person program team; 1–3 SIs involved.

**Trigger:** go-live within 18 months, hypercare, a failed/restarted program, a new CIO/transformation lead, audit findings, data-migration problems.

**Buyer:** CIO, program director, transformation office lead, CFO's transformation PMO.

**User:** PMO, business analysts, test manager, data migration lead, change/training lead.

**Why they buy:** status reporting, decision tracking, defect triage, documentation quality, fewer repeated meetings, faster onboarding of backfill contractors.

**Budget:** program budget (often already 10–30% over); a €15k–60k pilot is a rounding error against a €5M+ program.

### 4.3 Not the first customer

- Companies with no active SAP program (no urgency, no budget).
- Pure SAP Basis/hosting buyers (not a document problem).
- Highly regulated buyers requiring on-premise and full certification on day one (unless a private deployment is genuinely ready).
- Very large Tier 1 SIs (6–18 month vendor onboarding; pursue as a second wave).
- Public sector with mandatory tender processes (long cycle, residency requirements).

## 5. Positioning and messaging

### 5.1 One-liner

**Truex is the secure AI workbench for SAP transformation teams: turn program documents, workshops and test evidence into cited answers and ready-to-send deliverables.**

### 5.2 Message pillars

1. **Program-specific, not generic.** It works on your SOWs, blueprints, workshops, tickets and cutover plans — not just public SAP knowledge.
2. **Evidence, not guesses.** Answers cite the source document; generated deliverables keep the program's terminology.
3. **Governed by design.** Tenant isolation, no shell/file access, read-only connectors by default, write approvals.
4. **Fits the program you already run.** Upload artifacts, connect approved tools, produce status packs and test analyses in the existing cadence.
5. **Value in weeks.** Start with one workflow, measure hours saved and cycle time, then expand.

### 5.3 Objection handling

| Objection | Response |
| --- | --- |
| "We have Joule / Copilot." | "Keep it. Joule is good for SAP knowledge. Truex works on your program artifacts and produces your deliverables. Run them side by side on one status pack." |
| "Our data cannot go to an AI tool." | "Pilot with a controlled tenant, a defined data set and a security review. We will document exactly what is stored and where. If residency is a blocker, we will scope a private deployment rather than pretend." |
| "SAP is building this." | "SAP is building SAP knowledge and in-system agents. Program knowledge across SOWs, transcripts, test exports and SI deliverables is a different problem, and it is the one that consumes your team's week." |
| "We tried an AI pilot and it failed." | "Most pilots fail at adoption, not model quality. We start with one workflow, five users and a measurable output, then expand only if it works." |
| "Is it accurate?" | "Every answer cites the source. For SAP configuration questions, we route to SAP documentation/Joule; for program questions, we ground in your artifacts." |

## 6. Offer and pricing

### 6.1 Packaging

| Package | Who | Price | Notes |
| --- | --- | --- | --- |
| **Pilot** | One program or practice | **$15,000 for 8 weeks** (range $12k–20k) | Up to 25 users, one workflow, success criteria, 50% credited to annual. |
| **Team** | SI practice / program office | **$49/user/month** annual ($59 monthly) | 10-seat minimum; includes onboarding and admin. |
| **India direct** | India-based teams | **₹2,400/user/month** (~$29) | Purchasing-power adjustment; same product. |
| **SI wholesale** | Partners reselling | **$25/user/month**, 100-seat minimum | Partner sets end price; 20–30% margin; co-branded workspace. |
| **Program license** | Enterprise program | **$30k/year for 50 users** or **$60k/year for 150 users** | Predictable budget; includes quarterly business review. |
| **Model costs** | All | BYO key or pass-through +15% | Never absorb unbounded inference cost in a fixed seat price. |

### 6.2 Why this price works

- Joule for Consultants is ~€245/user/month; Truex at $49 is ~1/5 the price and does a different job. It does not need to be cheaper than ChatGPT; it needs to be cheaper than a consultant hour.
- Assumption to validate with partners: an SAP consultant's fully loaded cost is $60–150/hour. Saving 2 hours/user/week pays for the seat several times over.
- Assumption to validate per account: a $15k pilot is below most enterprise procurement thresholds and can be signed by a practice head or program director.
- Wholesale at $25 leaves room for the SI to charge $40–60 and still look cheap against Joule.

### 6.3 Pilot success criteria (write into the SOW)

Pick one workflow and measure:

- 5+ active users, 20+ sessions in 30 days;
- 3+ deliverables produced (status pack, RAID log, defect triage, mapping sheet);
- ≥30% reduction in time to produce the chosen deliverable, self-reported and spot-checked;
- ≥80% of answers rated "usable without rework" by the owner;
- zero unresolved security findings in the agreed scope.

If the pilot misses, do not auto-convert. Publish the learning internally and fix the workflow.

## 7. Channels and partnerships

### 7.1 Direct outbound (primary, days 0–90)

- 50+ named accounts from `target-accounts.csv` (expand to 100 as research continues).
- Warm paths: ex-colleagues, SAP user-group contacts, SI alliance leads, independent contractors.
- Sequence: LinkedIn + email + one useful artifact (e.g. "S/4HANA status pack template" or "defect triage checklist"), not a generic demo ask.

### 7.2 SI partnerships (primary leverage)

Target 2 signed partners in 90 days, 5 in 12 months.

**Partner profile:** 100–1,000 SAP consultants, strong DACH/India/UK mid-market, no home-grown equivalent, innovation-friendly.

**Deal:** 20–30% reseller margin, free internal use for 10 seats, joint pilot with one of their clients, co-branded deliverables, named partner manager.

**Avoid:** Tier 1 SIs early (slow onboarding, build-vs-buy review, channel conflict). Use them as a second wave once references exist.

### 7.3 Events and communities

- DSAG (DACH), SAPinsider (Europe/US), ASUG (US), India SAP Community / SAP Inside Track.
- Do not sponsor large booths. Attend, speak on a practical panel ("what actually stalled our S/4HANA program"), run 10-person roundtables.
- Publish a monthly teardown: "What a good S/4HANA status pack contains" / "How to triage 500 test defects in a week."

### 7.4 Content and proof

- 1 flagship case study per quarter, with numbers approved by the customer.
- 3 reusable templates (status pack, RAID log, defect triage) as lead magnets.
- Security one-pager and data-flow diagram for procurement.
- 5-minute recorded demo per workflow; no live demo before the security one-pager is sent.

### 7.5 Marketplace (later)

SAP Store / Joule Studio integration only after a working connector and a reference. Do not spend time on certification before 10 paying customers.

## 8. 90-day plan

### Days 0–30: package and proof

- [ ] Freeze demo stack; verify OAuth, file generation, citations and tenant isolation on the exact environment used for demos.
- [ ] Build 3 demo data sets: (a) fictional S/4HANA program artifacts, (b) test-defect export, (c) data-mapping workbook.
- [ ] Write security one-pager, data-flow diagram and pilot SOW template.
- [ ] Produce 3 lead magnets (status pack, RAID log, defect triage).
- [ ] Select 2 design partners from the wave 1 list; offer a free 4-week pilot in exchange for feedback and a reference option.
- [ ] Finalize pricing and Stripe/invoice path for $15k pilots.

### Days 31–60: sell the pilot

- [ ] 300 targeted touches; aim for 12 meetings and 10 demos.
- [ ] Run 5 pilots total (3 paid + 2 design partners is acceptable).
- [ ] Sign 1 SI partner MOU; start joint pipeline review.
- [ ] Attend one SAP community event; collect 20 conversations.
- [ ] Instrument activation: first artifact within 48 hours, 5 users in 14 days.

### Days 61–90: convert and decide

- [ ] Convert 2 pilots to annual; target $60k–120k ARR.
- [ ] Publish 1 case study with measured hours saved.
- [ ] Sign a second SI partner.
- [ ] Run a 3-week technical spike: read-only SAP OData connector for purchase orders (one API, one auth model). Decide build/partner/defer based on 3 customer commitments.
- [ ] Review pipeline; if <3 pilots by day 60, change the segment or offer, not the messaging.

## 9. Named accounts

**Wave key:** wave 1 = can pilot quickly; wave 2 = needs a residency, sovereign or extended security review first (DACH enterprises, public sector, large regulated accounts); wave 3 = later. Most SI rows are wave 1 for partner internal use, but client-data deployments still need a residency review; larger European SIs such as Sopra Steria are wave 2. HARTING, Vitakraft and the other DACH enterprises are wave 2: open conversations now, but do not promise a pilot until the deployment question is answered. The `wave` column in the CSV carries this classification for every account.

The tables below are the highest-priority subset. The CSV contains the full 61-account list, including additional India and UK SIs.

### 9.1 Tier A: SI and consultancy partners (selected)

| Account | Country | Why now | First use case | Entry point |
| --- | --- | --- | --- | --- |
| All for One Group | Germany | ~3,000 employees; DACH mid-market SAP leader | Proposal + program knowledge | SAP practice lead / innovation |
| q.beyond | Germany | Won Vitakraft S/4HANA migration (Sep 2026) | Program status + workshop synthesis | SAP practice lead |
| DATAGROUP | Germany | ISG midmarket SAP leader 2026 | Managed-service knowledge base | SAP/cloud practice |
| Birlasoft | India | ~2,200 SAP practitioners; ISG US midmarket leader | Proposal + junior ramp | SAP practice / alliance |
| Coforge | India | Large SAP practice, active S/4HANA pipeline | Delivery knowledge + status packs | SAP practice head |
| LeverX | USA/global | SAP-focused SI | Program knowledge | Delivery leadership |
| SNP Group | Germany | Data transformation specialist | Data-mapping assistant | Data migration lead |
| Natuvion | Germany | Data migration and transformation | Mapping + cutover docs | Delivery lead |
| cbs Corporate Business Solutions | Germany | SAP S/4HANA consultancy | Program knowledge | Partner / practice lead |
| SEIDOR | Spain | SAP SI, European mid-market | Proposal + delivery | SAP practice |
| NTT DATA Business Solutions | Germany/global | HARTING RISE win; large SAP practice | Program office + hypercare | SAP transformation lead |
| Abacus Consulting | Pakistan/global | SAP SI with delivery centers | Junior ramp + status packs | SAP practice |

### 9.2 Tier A: enterprises with public triggers (selected, wave 1–2)

| Account | Country | Trigger | First use case | Entry point |
| --- | --- | --- | --- | --- |
| HARTING | Germany | RISE/S/4HANA signed Sep 2026 with NTT DATA | Program knowledge + status | CIO / program director |
| Vitakraft | Germany | S/4HANA migration with q.beyond, Sep 2026 | Workshop synthesis + data mapping | CIO / program lead |
| Twinings Ovaltine | Switzerland/UK | Consolidating 10 ERPs to RISE | Data mapping + program knowledge | Program director |
| Imperial Brands | UK | S/4HANA "Unify" program | Status + test/defect triage | Transformation office |
| Co-op | UK | ECC on RISE, 2,400 stores | Test/defect triage + training | Program office |
| Panasonic Europe | Europe | R/3→S/4HANA with Camunda | Process workshop synthesis | Transformation lead |
| Rosenberger | Germany | Go-live Jun 2026; hypercare issues | Defect triage + knowledge | CIO / hypercare lead |
| Wesizwe Platinum | South Africa | Reimplementation after cyberattack (2026) | Controls documentation + PMO | CIO / program director |
| Convatec | UK | S/4HANA with LTIMindtree | Program knowledge + status | Transformation office |
| Snohomish County PUD | USA | S/4HANA with Cognizant | PMO + documentation | CIO / program director |
| Century Plyboards | India | Go-live Apr 2026 | Hypercare defect triage | CIO / program lead |
| Elevate Campuses | India | S/4HANA with KPMG, Apr 2026 | Training + documentation | Program director |
| Clorox | USA | $580M S/4HANA completed Feb 2026 | Post-implementation optimization | CIO / finance transformation |
| Salling Group | Denmark | SAP transformation | Program knowledge | CIO |
| BEW Berliner Energie und Wärme | Germany | SAP transformation | Status + documentation | Program office |
| Gardner White | USA | S/4HANA program | Test/defect triage | CIO |
| FrieslandCampina | Netherlands | SAP program | Data mapping + status | Transformation office |
| TPAC Packaging India | India | SAP rollout | Training + cutover docs | Program lead |
| Birla Opus Paints | India | Greenfield SAP | Program knowledge | CIO |

### 9.3 Tier B: later

BMW, Hitachi High-Tech, Florida Crystals, badenova, Komm.ONE, Ratiodata, Index Living Mall, Coop Switzerland. These are larger or less time-critical; pursue after references and, for EU buyers, after a private-deployment option exists.

Full list with sources and confidence: [target-accounts.csv](target-accounts.csv).

## 10. Outreach scripts

### 10.1 SI practice head (email, 90 words)

Subject: One workflow to protect S/4HANA margins

Hi [Name],

Your team is running [program/client] while senior consultants are the bottleneck for status packs, workshop notes and test triage.

We built Truex, a secure workbench that turns those artifacts into cited answers and ready-to-send deliverables. One 8-week pilot, one workflow, measured hours saved.

Worth 20 minutes to see it on a sample S/4HANA program? I can send a security one-pager first.

[Name]

### 10.2 Enterprise program director (email, 90 words)

Subject: 500 test defects, one week

Hi [Name],

Most S/4HANA programs lose weeks to defect triage, status reporting and onboarding contractors. The work is document-heavy, not SAP-configuration-heavy.

Truex ingests your test exports, workshop notes and program documents, then produces a triaged defect list and a cited status pack. Tenant-isolated; no shell access; read-only connectors.

If you are in hypercare or preparing for go-live, I can run a 30-minute working session on one real export (with your data masked).

[Name]

### 10.3 Discovery questions

1. Which deliverable consumes the most senior time each week?
2. Where do program documents live, and who is allowed to use AI tools on them?
3. How many consultants joined in the last six months, and how long until they are productive?
4. What happened in the last steering committee that took too long to prepare?
5. Which SAP systems would you never connect to an external tool, and why?
6. What would make a pilot unquestionably successful in 8 weeks?
7. Who signs a $15k pilot, and what is the procurement path?

## 11. Metrics and unit economics

### 11.1 Funnel targets (first 90 days)

| Stage | Target | Notes |
| --- | --- | --- |
| Named touches | 300 | 50+ accounts, multi-threaded |
| Replies | 24–30 | 8–10% reply rate |
| Meetings | 12 | 40–50% of replies |
| Demos | 10 | Qualified only |
| Pilots | 5 | 50% of demos (including partner-sourced) |
| Paid conversions | 2 | annual contracts from the pilot cohort |
| ARR added | $60k–120k | Mix of Team and Program |

### 11.2 Unit economics

- Target ACV: $18k (Team, 30 seats) to $60k (Program).
- Gross margin target: 70%+ after inference; enforce BYO key or pass-through.
- CAC target: <$6k direct; <$3k partner-sourced.
- Payback target: <6 months.
- Pilot-to-paid: ≥40%; if lower, the workflow or ICP is wrong.

### 11.3 Leading indicators

- Time to first generated artifact (<48h).
- Seats active in week 2 (≥5).
- Sessions per active user per week (≥3).
- Artifacts per user per month (≥2).
- "Usable without rework" rating (≥80%).
- Security review cycle time (<3 weeks).

## 12. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| SAP ships adjacent program-work features in Joule | Medium | High | Stay on cross-artifact, cross-tool program work; integrate with Joule rather than compete. |
| Security review blocks the deal | High | High | Security one-pager, controlled pilot tenant, data-flow diagram, private-deployment roadmap. Do not claim certifications. |
| Data residency (EU/India) | High | High | Qualify early; prioritize buyers who accept AWS `us-east-1` for a pilot; scope in-region deployment only with a committed customer. |
| No SAP connector limits perceived value | High | Medium | Lead with artifact workflows; use CSV/XLSX exports as the bridge; build connector only after 3 commitments. |
| Long enterprise sales cycles | High | Medium | Sell pilots to practice heads/program directors, not CIO procurement. |
| SI channel conflict / slow partner onboarding | Medium | Medium | Start with mid-size SIs; give named deal registration and margin; avoid Tier 1 early. |
| Hallucinated SAP advice | Medium | High | Ground in artifacts; cite sources; route configuration questions to SAP docs/Joule; human approval for external deliverables. |
| Inference cost erodes margin | Medium | Medium | BYO key or pass-through; usage caps; monitor cost per artifact. |
| Founder-led sales does not scale | High | Medium | Document the playbook during pilots; hire first AE only after 10 paying customers. |
| Reference customer withdraws | Low | Medium | Contract reference rights up front; offer anonymity option; build multiple references. |

## 13. What not to do

- Do not launch a broad "AI agents for everything" campaign. The buyer has a deadline, not a curiosity.
- Do not demo live SAP transactions before the connector exists.
- Do not claim SAP certification, SOC 2, ISO 27001, SSO or in-region hosting until verified.
- Do not compete with Joule on SAP knowledge depth. Complement it.
- Do not sell to Tier 1 SIs in the first quarter; the onboarding cost will consume the runway.
- Do not sponsor large conference booths. Spend on 10-person roundtables and follow-up.
- Do not price below $25/user/month direct; it signals a toy and attracts the wrong buyer.
- Do not absorb model costs in a fixed seat price.
- Do not run pilots without written success criteria and a named executive sponsor.

## 14. Open decisions

1. **Demo stack:** `platform-next` (OAuth, approvals) or stable `platform`? Pick one and freeze it for sales.
2. **India pricing:** ₹2,400/user/month is a placeholder; validate with 5 Indian SIs before publishing.
3. **SAP connector:** build read-only OData for purchase orders, partner with an iPaaS/MCP vendor, or defer until 3 paid commitments. Recommendation: defer, run a 3-week spike only after commitments.
4. **Private deployment:** is an in-region/on-prem package real enough to promise a date? If not, say "roadmap, subject to a committed customer."
5. **Saudi track:** keep separate; do not mix into SAP collateral until residency is resolved.

## 15. Sources

- Gartner/CIO ECC migration numbers: https://www.cio.com/article/4000543
- Horváth S/4HANA study (2025): https://www.horvath-partners.com/en/press/detail/study-shows-sap-s-4hana-transformations-rarely-go-as-planned-60-percent-exceed-budget-and-schedule-two-thirds-dissatisfied-with-result-quality
- Horváth follow-up (resource bottlenecks): https://www.horvath-partners.com/en/press/detail/companies-underestimate-the-challenges-of-the-sap-s-4hana-transformation
- SAP Business AI pricing (Joule for Consultants, agents): https://www.sap.com/products/artificial-intelligence/pricing.html
- SAP Joule for Consultants product page: https://www.sap.com/products/technology-platform/joule-for-consultants.html
- SAP Joule for Consultants activation/pricing example: https://www.sap.com/estonia/products/artificial-intelligence/sap-consulting-capability.html
- SAPinsider ERP Migration and Transformation 2026: https://sapinsider.org/map/2026-sap-s4hana-migration-cloud-ai-bottleneck
- SAPinsider 2026 full report (PDF): https://sapinsider.org/wp-content/uploads/2026/03/0326-ERP-Migration-and-Transformation-Final.pdf
- SAP S/4HANA SI services market forecast: https://sapinsider.org/blogs/sap-s-4hana-systems-integrator-services-market-to-pass-100-billion-by-2032
- DSAG 2026 investment survey coverage: https://www.theregister.com/off-prem/2026/02/27/half-of-german-speaking-sap-users-to-stay-on-ecc-to-2030/4657165
- DSAG Annual Congress 2026 press release: https://impulsant.dsag.de/formate/pressemeldung/dsag-annual-congress-2026-economic-efficiency-and-freedom-of-choice/
- Deloitte State of AI in the Enterprise 2026: https://www.deloitte.com/us/en/about/press-room/state-of-ai-report-2026.html
- HARTING RISE with SAP announcement: https://news.sap.com/2026/09/harting-accelerates-cloud-transformation-with-rise-with-sap/
- Vitakraft/q.beyond announcement: https://www.qbeyond.de/en/press-releases/2026/vitakraft-selects-qbeyond-as-its-sap-transformation-partner
- Computer Weekly S/4HANA 2026: https://www.computerweekly.com/news/366636765/S4Hana-in-2026-Three-ways-to-move-off-SAP-ECC
- Truex repo: `README.md`, `usecase/`, `docs/MCP.md`, `docs/TRUEX_RUNTIME.md`, `docs/ASSISTANT_CAPABILITIES.md`, `Millions/`

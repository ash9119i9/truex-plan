# Millions: Saudi Arabia go-to-market

Idea: sell the Truex agent platform to Saudi customers, with the LLMs hosted on GPU servers inside the Kingdom so data never leaves the country.

Status: ideation only (2026-10-20). Nothing has been decided or built. Rankings are our own judgment of fit; none of these organisations has shown interest, and every name needs a warm introduction. Facts were checked on the web on 2026-10-20; programme dates, cohorts and region launches change, so confirm with each organisation before acting.

| File | Contents |
|---|---|
| [saudi-partners-and-customers.md](saudi-partners-and-customers.md) | Deal partners, hosting partners, target customers, events, first five calls |
| [india-entry-routes.md](india-entry-routes.md) | How a new Indian company gets into these partner conversations |

## Three things to know first

1. **HUMAIN is the biggest competitor and the best possible partner.** HUMAIN is owned by PIF, Saudi Arabia's sovereign wealth fund. It sells HUMAIN ONE, an agent platform for businesses, built on its Arabic-first model ALLaM and backed by AWS, EY, Groq and Microsoft. Don't sell a general agent platform against it head-on. Win with something it doesn't do well (for example agents built for SAP), or run on its GPUs instead of fighting it.
2. **The data rule is narrower than "data can't leave."** The PDPL (main privacy law) limits sending personal data abroad but does not force everyone to keep data in-country. The strict in-country rules come from the NCA cloud controls (government and critical infrastructure), SAMA (banks) and the national data-classification rules (NDMO). Start with those sectors; they feel the most pressure.
3. **Today's production setup would fail a residency check.** Agent-core runs on AWS Bedrock AgentCore in us-east-1, so prompts, conversation history and runtime state leave the country. To sell this, deploy the whole stack inside Saudi Arabia: frontend, platform, MongoDB, runtime container and model-gateway. The README says the runtime image works without AgentCore (leave `AGENTCORE_RUNTIME_ARN` unset) and gateway profiles with `wireApi: chat` can point at a self-hosted model server such as vLLM. This is documented but not yet tested.

## What every partner will ask first

"Where does the data go?" Today the answer is AWS us-east-1, which rules out regulated buyers. Before LEAP 2027, have ready:

- A reference deployment that runs entirely in-country: frontend, platform, MongoDB, runtime container, model-gateway pointing at a self-hosted model.
- A working SAP-agent demo.

These two things turn a partner meeting into a pilot.

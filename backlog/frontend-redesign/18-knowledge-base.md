# Knowledge base

Status: open · Design + backend · Added 2026-10-28 · Spec 19.4, 15.1, 15.3, 14.6, 14.7

## Gap

Knowledge is "Soon" in the Agent ID desk (step 2, Access). The spec still shows it in several places: the board meta "3 sources", the Agent tab group **Knowledge**, and the Files tab "Read, not changed" documents. There's no Knowledge screen and no backend.

## Do

- Design: a Knowledge screen to add, list and remove sources; attaching sources in the desk; and how a source shows in the panel.
- Decide what a source is (uploaded documents, a connector, a URL), who owns it (member or workspace), and how it reaches the model: retrieval, or files in the workspace.
- Backend: storage, per-workspace access checks, size limits, and removal that also covers chats that used the source.

`backlog.txt` lists "Knowledge: Knowledge nav + page" from the earlier redesign.

## Done when

The screen is designed and specified, an agent can attach sources, and a turn's panel shows which sources it opened.

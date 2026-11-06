# Agent Vitals landing positioning and GTM (2026-09)

> 2026-10-15: The next landing revision leads with desktop-agent history visualization and Agent City. See [Landing City-first redesign spec](LANDING_CITY_FIRST_REDESIGN_SPEC.md) for the new page positioning and conversion path. Historical channel findings below remain context, not current launch verification; privacy and truthful coverage requirements still apply.

## Brand and privacy promise

- **Product brand:** Agent Vitals 智能体监测
- **Chinese product name:** 智能体监测
- **Trust promise:** Sessions are analyzed offline on the user's own Mac and are not uploaded to a cloud service.
- **Network boundary:** public pricing-catalog and release checks may use the network, but they carry no Session data.

Privacy is not a footer disclaimer. It is one of the three primary adoption reasons, shown beside the first CTA together with MIT open source and no API key requirement.

## Decision

Do not lead with “save money on AI coding.” Token dashboards and cost trackers are already a crowded, increasingly commoditized category. Lead with the new control problem created by delegated work:

> **你把工作交给 Agent。谁来检查 Agent？**

The product mechanism is an **Agent work receipt**: a local, reviewable record of the usage, cost basis, failures, and session traces that supported harnesses already leave on the machine.

This is broader than coding, but it is not permission to claim universal office-agent coverage. The category can be broad while the support statement remains precise.

## What the current product can honestly promise

| Promise | Current state | Landing rule |
|---|---|---|
| Local processing; no user session data upload | Implemented. Public pricing-catalog and release checks may use the network without user session data. | Lead with it as the primary trust proof. |
| MIT open source | Implemented. | Show beside the primary CTA. |
| No API key required | Implemented for local log reading. | Show beside the primary CTA. |
| Cross-source usage overview | Implemented for the runtime sources represented in the desktop authority store; coverage differs by harness. | Say “supported sources,” not “all agents.” |
| Actual, estimated, subscription, and unresolved cost kept separate | Implemented in the data model and UI. Some harnesses or sessions have no price evidence. | Say “cost basis,” not “exact bill.” |
| Session list and drill-down | Implemented. | Safe to show. |
| Session trajectory and consumption diagnostics | Implemented for supported evidence: token composition, failures, input growth, cache behavior, and trace navigation. | Say “find clues / inspect evidence,” not “automatically optimize.” |
| WorkBuddy runtime entry point | Implemented with session and usage evidence, but not the same cost/detail coverage as every other harness. | Use it as the bridge to office work; disclose unequal coverage. |
| OpenClaw and Hermes runtime observability | Not equivalent to core runtime sources today; current strength is install-time and Skill inspection. | Do not put them in a runtime-support logo wall. |
| Judge whether the final deliverable is correct | Not implemented. | Explicitly deny this claim in FAQ. |
| Guaranteed savings or ROI | Not implemented and not generally measurable from fixed subscriptions. | Never promise a percentage saved. |

## Market shift and product wedge

Agents have moved from coding into research, documents, spreadsheets, email, calendars, file operations, scheduled work, and cross-application workflows. That creates four recurring pains:

1. **Invisible consumption:** subagents, retries, long contexts, and background runs consume limits or metered credits without a clear per-task explanation.
2. **Supervision overload:** running several agents replaces manual execution with queue watching, context switching, and exception review.
3. **Missing audit trail:** users see the output but cannot reconstruct what was attempted, where it failed, or which agent touched what.
4. **Privacy and trust:** office agents can read sensitive local files and connected accounts; uploading their audit logs to yet another cloud creates a second trust problem.

Agent Vitals should not compete as another agent builder. It should own the personal/local control layer after work has been delegated.

## Message house

### Category

Local Agent work ledger / Agent work receipts.

### Core promise

Every Agent run should leave a receipt.

### Proof

- session data stays on the Mac;
- source is MIT licensed and inspectable;
- measured, estimated, and unknown values stay visibly separate;
- users can move from overview to a session and its trace instead of trusting a score.

### Anti-promises

- not a quality judge;
- not a cloud team-observability platform;
- not universal harness coverage;
- not a guaranteed savings engine.

## Landing hierarchy

1. **Tension:** “你把工作交给 Agent。谁来检查 Agent？”
2. **Mechanism:** “每次 Agent 工作，都应该留下一张收据。”
3. **Proof:** local processing, MIT open source, no API key.
4. **Demonstration:** source → session → failure/cost clue → trace.
5. **Boundary:** exact supported harnesses and unequal evidence coverage.
6. **CTA:** “检查我的 Agent,” not “learn more.”

## Initial audience

Prioritize people who already run long or parallel Agent tasks and have experienced at least one of these moments:

- hit a usage limit earlier than expected;
- cannot explain which session consumed it;
- came back to a failed or stalled task;
- uses more than one local Agent;
- handles local files that should not enter a third-party observability cloud.

The first audience is still technical power users and AI-forward knowledge workers. Do not buy broad “productivity” traffic until office-harness coverage and onboarding are strong enough for nontechnical users.

## Reddit playbook

### Principles

- Read each community's current rules before posting.
- Use a founder account with disclosed affiliation.
- Contribute useful answers before sharing a link.
- One community-specific post is better than the same launch copy in ten subreddits.
- Lead with a reproducible problem or a teardown, not the product name.
- Keep the GitHub/download link at the end; the post should still be useful without clicking it.

### Community order

1. `r/ClaudeAI`, `r/ClaudeCode`, `r/codex`: strongest pain around limits, subagents, cache behavior, and session cost.
2. `r/AI_Agents`: broader audit-trail and supervision framing.
3. `r/macapps`: native local utility, privacy, and interaction quality.
4. `r/opensource`: architecture, redaction boundaries, and MIT implementation.
5. `r/LocalLLaMA`: local-first trust angle, only when the post genuinely discusses data boundaries.

Wait before targeting broad productivity communities. The product must first show reliable office-agent coverage and nontechnical onboarding.

### Launch post for Claude communities

**Title**

> I could see the output, but not which Agent session burned my limit — so I built a local work receipt for Claude Code / Codex

**Body outline**

1. Describe the moment: a limit dropped or a long task failed and there was no clean answer for which session caused it.
2. Share a redacted screenshot or 15-second video: overview → session → diagnostic → trace.
3. Explain the accounting rule: estimates are not bills; unknown is not zero.
4. Explain the privacy rule: local logs stay local; price/release checks carry no session data.
5. Disclose limitations: macOS beta, unequal harness coverage, no output-quality judgment.
6. Ask one concrete question: “Which missing clue would help you decide whether a long Agent run was worth it?”
7. Add the GitHub link after the question and disclose “I built this.”

### Discussion post for `r/AI_Agents`

**Title**

> Every Agent task should end with a receipt: what ran, what failed, and what it cost

Do not link in the opening paragraph. Present the work-receipt model, show the four fields, and ask whether people need action-level audit, cost attribution, or output verification first. Mention the product only after explaining what has already been built.

### Follow-up content

- a teardown of one anonymized repeated-failure trace;
- why “subscription equivalent cost” is not an actual bill;
- how to audit local Agent logs without uploading them;
- what the product cannot know from a given harness's log format.

## X playbook

X should compress the idea into one memorable sentence and one visual proof. The repeated creative unit is:

> **An Agent that can touch your files should leave a receipt.**

### Launch thread

1. “I gave several Agents work today. I got the outputs—but no receipt for what ran, what failed, or what used the limit.”
2. Attach a 10–20 second screen recording: overview → session → trace. No narrated product tour.
3. “So I built Agent Vitals: a local work ledger for the Agent records already on your Mac.”
4. Proof row: “Local processing · MIT open source · unknown ≠ zero · estimates ≠ bills.”
5. Honest boundary: current macOS beta and supported runtime sources; office coverage is expanding.
6. CTA: GitHub/download link plus one question about the viewer's hardest-to-audit Agent.

### Standalone post hooks

- “Your Agent finished the task. Where is the receipt?”
- “The next Agent feature I want isn't more autonomy. It's a work log I can verify.”
- “If an Agent can touch files, send email, and spend credits, ‘trust me’ is not an audit trail.”
- “Unknown cost is not zero. Estimated cost is not a bill. Agent dashboards should stop pretending otherwise.”
- “Multi-agent work traded execution time for supervision time. We need better receipts, not more tabs.”

Use a cropped native-app video or a single annotated screenshot with every post. Publish the strongest pain statement as a standalone post before the launch thread; reply with the demo only after the statement earns discussion.

## Four-week release loop

### Week 0 — proof before reach

- recruit 10 heavy Agent users from existing conversations;
- capture the exact sentence they use to describe the pain;
- measure install → first source found → first session opened → first trace inspected;
- collect three redacted “work receipt” screenshots.

### Week 1 — community learning

- five substantive Reddit comments per day in pain-adjacent threads;
- three X posts testing “receipt,” “supervision,” and “cost” hooks;
- no paid traffic.

### Week 2 — focused launch

- one Reddit launch post in the best-matched community;
- one X thread and one short demo video;
- GitHub release notes that repeat the same promise and limitations.

### Week 3 — evidence content

- publish one teardown from real redacted beta data;
- publish the “unknown ≠ zero” accounting explainer;
- add the top three objections to the landing FAQ.

### Week 4 — decide whether to expand

Expand toward office-agent channels only if WorkBuddy/office-source users can reach a useful trace without developer help. Otherwise keep acquisition focused on technical power users while building broader source coverage.

## Success metrics

Do not optimize for page views or followers. Track:

- landing → download click;
- download → app opened;
- app opened → at least one source found;
- source found → one session opened;
- session opened → trace/diagnostic inspected;
- day-7 return to inspect a new session;
- percentage of activated users who can name one concrete decision the product changed.

The Aha moment is not seeing a large token total. It is opening one suspicious session and saying: **“Now I know what happened, and what to check next.”**

## Research references

- OpenAI, “How agents are transforming work”: https://openai.com/index/how-agents-are-transforming-work/
- OpenAI Academy, “Workspace agents”: https://openai.com/academy/workspace-agents/
- Microsoft, “2026 Work Trend Index”: https://www.microsoft.com/en-us/worklab/work-trend-index/agents-human-agency-and-the-opportunity-for-every-organization
- McKinsey, “The State of AI 2026”: https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-state-of-ai
- Reddit, “Spam”: https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam
- Reddit for Business, organic community guidance: https://www.business.reddit.com/learning-hub/articles/how-to-build-a-community
- X, “Build your presence”: https://business.x.com/content/dam/business-twitter/resources/x-downloadable-guides/build-your-presence-on-x-one-sheet.pdf

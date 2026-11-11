# Dream City display projection v1

## Purpose

`dream-city-snapshot:v2` separates visitor-facing labels and usage from the anonymous renderer model. `snapshot.model.rows` remains empty, and the renderer receives neutral geometry values. The standalone visitor UI reads the separate `display` object for the city overview and selected-building panel.

## Allowlist

The candidate contains `display.schema = "agent-city-display:v1"` with:

- City: session count, active session count, token total and truncation flag.
- District: publication-local opaque alias, bounded display label, session count, active count and token total.
- Building/session: publication-local opaque alias, nullable bounded title, nullable title-source provenance, session count, active flag and token total.

Title sources are limited to `codex_thread_name`, `claude_ai_title` and `dsh_workspace_title`. Titles are already scrubbed by the local City projection and are rechecked by Rust through `bound_session_title`; the validator requires the scrubbed result to exactly match the supplied text and enforces 256 Unicode scalar values / 1024 UTF-8 bytes. This filtering does not establish that a title is semantically safe. The owner must disclose the shared fields and show the candidate preview before enabling publication.

The geometry model remains anonymous: district/building labels and usage fields are zeroed, and `rows` is empty. No local session or asset IDs, costs, model IDs, timestamps, event data, logs, prompts, paths, credentials or arbitrary fields are allowed in `display`.

## Validation and re-keying

Rust requires exact object key sets, safe nonnegative integer counts, bounded collection sizes, unique aliases, and references to the corresponding geometry district/building aliases. It rejects unknown title provenance, unsanitized titles, mismatched null title/source pairs and dangling or duplicate references. The existing publication re-key pass traverses the complete candidate, so aliases in `display` are regenerated with the same ephemeral mapping used by geometry.

The visitor parser accepts only the v2 snapshot and v1 display contract. The relay continues to receive the frozen compressed snapshot as an opaque bounded payload; this display contract does not grant remote access or change authorization semantics.


# Issue review and optimization plan

Reviewed on 2026-07-13 against all issues in `chaolucky18/xuexitongScript`.

## Findings

| Cluster | Relevant issues | Cause | Resolution |
| --- | --- | --- | --- |
| Script cannot start or installation links return 404 | #47, #33, #18, #17, #16 | README contained machine-local links; the course tree can render after a userscript starts | Replace links with repository-relative paths and wait up to 20 seconds for `#coursetree` |
| Repeated or skipped course navigation | #24, #37, #27, #9 | Every `play()` call added newly bound media listeners, so old handlers could not be removed | Keep stable handler references, detach them on video replacement, and lock navigation until a target is clicked |
| Playback pauses or recovery is unreliable | #32, #25, #19 | Muted fallback did not restart monitoring; only the first iframe path was inspected | Restart monitoring after muted playback and search accessible nested player frames |
| No-video/courseware pages loop or get stuck | #43, #38 | All missing-video states were treated like a chapter test and blindly clicked a next button | Distinguish chapter tests, cap their retries, and stop safely on unknown courseware; optional auto-advance remains opt-in |
| Playback rate or task point is not accepted | #3, #6, #28, #31 | The platform can enforce rate and completion server-side | Do not attempt to bypass the platform; document this as a platform constraint |
| Interactive or chapter-question automation | #29, #39, #42, #45 | Requires answering assessed questions | Default unchanged: users complete assessed interactions themselves. V3.5 adds opt-in LLM assistance (`llmEnabled=false` by default): in-video interactions can be auto-selected (auto-submit also opt-in), chapter tests only get suggestions and are never auto-clicked |

## Delivered in V3.3

1. Treat `v3_optimized.js` as the sole implementation and generate the Tampermonkey entrypoint from it.
2. Add startup readiness, player discovery, event-lifecycle cleanup, duplicate-navigation protection, and bounded chapter-test progression.
3. Add a dependency-free verification command that checks syntax and confirms both entrypoints are synchronized.

## Delivered in V3.5

1. Inject a local-only GUI monitor panel (`guiEnabled`, default on) that mirrors console logs and shows playback / interaction / LLM state.
2. Add opt-in LLM assistance for in-video interaction popups behind `llmEnabled=false` (OpenAI-compatible endpoint, in-memory key only, required `x-opencode-session` routing header, strict JSON answer parsing, bounded request count, automatic fallback to manual handling).
3. Chapter-test pages keep the bounded-skip default; `llmChapterTest` only prints suggested answers to the panel and never clicks options or submit controls.
## Follow-up plan

1. Collect sanitized DOM snapshots for courseware, completed no-video nodes, and the current player iframe layout before adding any further selectors.
2. Add browser-based integration fixtures for those snapshots, then test course navigation end-to-end.
3. Keep rate/task-point enforcement as an explicit platform limitation rather than adding brittle countermeasures.

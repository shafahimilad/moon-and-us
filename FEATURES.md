# Moon&Us — feature status

Status of each item in the Clue Plus–inspired specification (reviewed 2026-11-08).
Labels: **Implemented and verified** · **Implemented but requires external verification** · **Blocked** (with reason).

## Inventory before this work

| Area | Before |
|---|---|
| Daily tracking, BBT, notes, period history | Existing |
| Predictions (period, PMS, fertile, ovulation) | Incomplete (no exclusions, overrides, irregular ranges, observed ovulation) |
| Modes | Incomplete (period / conceive goal only) |
| Calendar | Incomplete (no filters, no day details) |
| Analysis | Incomplete (no BBT chart, pain, sleep, comparisons) |
| Reminders | Missing (calendar file only) |
| Sharing | Incomplete (partner could read raw logs and notes) |
| Doctor's report | Missing (text summary only) |
| Wearables, chat, community | Missing / requires an external service |

## Status by item

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Modes and changing goals | Implemented and verified | 5 modes; per-day `modeHistory`; pregnancy and no-period intervals excluded from cycle maths (engine tests). |
| 2 | Tracking, categories, personalization | Implemented and verified | Edit any past day, multi-day period edit, pain intensity, weight, BBT; confirmed categories sleep quality, urine, vulva & vagina, supplements; show/hide/reorder; search; unlimited tags with usage-aware delete confirmation. |
| 3 | Advanced predictions | Implemented and verified | Documented engine in `js/cycle.js` (header). 6-cycle averages, 12-cycle prediction, configurable horizon (default 12 cycles), irregular → range, exclusion + manual override, ovulation from positive test / BBT. No confidence percentages. 19 tests in `tests/engine.test.cjs`. |
| 4 | Calendar filters | Implemented and verified | Up to 3 filters, selected-day details (observed vs estimated), edit from details. |
| 5 | Analysis | Implemented and verified | Length/variability, bleeding duration & intensity, history, side-by-side comparison, BBT chart, patterns by cycle day, feelings (timing + co-occurrence, non-causal), sleep. Each block shows range and data used. |
| 6 | Pain intensity & predictions | Implemented and verified | Intensity, cramp history, predictions for cramps/headache/back/breasts from last 3–4 cycles; weight chart. No medication advice. |
| 7 | Phase insights | Implemented but requires external verification | 6 estimated subphases, withheld with hormonal contraception or predicted cycle < 20 days. Text is a draft awaiting medical review. Community comparisons not shown (no real aggregate data). |
| 8 | Reminders | Implemented but requires external verification | 8 types, custom time/text (check-in fixed), discreet text, paused in pregnancy, deduplicated, local-time scheduling, calendar export. Background delivery while the app is closed is best-effort (periodic sync on supported Android browsers); reliable push needs a server (FCM + Cloud Functions, paid Blaze plan). |
| 9 | Trying to conceive | Implemented and verified | Separate card: more-fertile days, fertile window, timing guidance (draft), optional tests/BBT. |
| 10 | Pregnancy & postpartum | Implemented but requires external verification | Reference date, editable due date, week/day, trimester, fetal movement and pregnancy tracking, end pregnancy preserving history, 6-week postpartum card. Weekly development content blocked until reviewed content exists. |
| 11 | Perimenopause | Implemented and verified | Hot flashes / night sweats tracking, cycle-length trend, irregular ranges, no diagnosis. |
| 12 | Tracking without a period | Implemented and verified | User-chosen interval starts (not periods, no ovulation), interval comparison. |
| 13 | Sharing | Implemented but requires external verification | Owner-initiated single-use invites, multiple viewers, per-viewer revocation, paused in pregnancy. Viewers read only a calendar projection; logs/notes/settings are denied by Firestore rules (9 emulator tests in `tests/rules.test.mjs`). End-to-end test with two real accounts still needed. Notes/care-kit are an additional two-way couple feature, separate from her health data. |
| 14 | Wearables | Blocked | Needs registered developer apps and a backend for OAuth token exchange per provider; HealthKit / Health Connect are not reachable from a web browser. Data model already keeps manual BBT separate. |
| 15 | Library & support | Implemented but requires external verification | Articles carry author, reviewer, sources, review date, status; all are unreviewed drafts and hidden unless "show drafts" is on. Support form writes to a create-only Firestore `feedback` collection (read in the Firebase console). |
| 16 | Doctor's report | Implemented and verified | Last 6 completed cycles (hidden ones skipped and back-filled), >90-day cycles out of the trend only, heatmap ≥3 occurrences with the specified exclusions, optional personal details reviewed before export, PDF via the browser's print dialog, never sent automatically. |
| 17 | Chat with your data | Blocked | Requires a language-model provider with a server-side key and no-training settings; not available on the free static hosting. Engine functions that would supply the numbers exist. |
| 18 | Community | Blocked | Requires an operational moderation process and a separate pseudonymous identity service before activation. |
| 19 | Infrastructure | Implemented and verified | Persistence (Firestore + offline cache), ownership enforced by rules, JSON export, account deletion, local calendar dates, no health data in logs/analytics, measurement vs estimate labels. |
| 20 | Order & delivery | Implemented and verified | See checks below. |

## Checks run

- `npm test` — engine tests (19) pass in Europe/Berlin, Pacific/Auckland, America/Los_Angeles, Asia/Tehran.
- `npm run test:rules` — Firestore emulator rules tests (9) pass.
- Browser check (local mode): home, calendar filters, tracking search, analysis, report layout, pregnancy start/end.

## Remaining dependencies

- Medical reviewer for articles, phase text and pregnancy content.
- Push server (paid Firebase plan) for guaranteed background reminders.
- Developer accounts + backend for wearables; LLM provider for chat; moderation for community.
- Two-account test of sharing on the live site.

## Update 2026-11-08 (evening)

| Area | Status | Notes |
|---|---|---|
| Landing | Implemented and verified | Full-screen intro slides written only for her; no mention of a partner before sign-in. |
| Sign-up flow | Implemented and verified | Account type (track my own cycle / I have a code), consent (terms, privacy, health-data processing), goals (multi-select, sets the mode), encouragement screen, name, birth year, hormonal contraception, dates, reminder opt-in. |
| Partner joins with a code | Implemented but requires external verification | Code entry in sign-up as well as the invite link; needs a two-account test on the live site. |
| Her page ("Us") | Implemented and verified (local) | Gifts from him with a reveal, locked surprises, one-tap mood, one-tap requests with live status, "I need you now", gift wall, coupons she can redeem, messages. |
| His page ("Us") | Implemented and verified (local) | Her mood first, her requests with seen / on my way / done, send a note, photo, coupon, song link, ready-made compliment or a surprise locked until a date (e.g. her next period), idea of the day, care kit, sent history. |
| Gifts & requests rules | Implemented and verified | 11 emulator tests: partner can send gifts but not edit them; only she creates requests; partner can only acknowledge. |
| Live alerts between phones | Implemented but requires external verification | System notification when the other person's app is open or in the background; true push while closed needs a push server (paid Firebase plan). |
| Plus-style screens | Implemented and verified | Hormone pattern chart (textbook shape, labelled as not her measurements), "your typical cycle", cramp review by period day, period strength grid. |
| Install prompt | Implemented and verified | After sign-in, once per device: one-tap install on Android/Chrome, step-by-step on iPhone Safari. |
| Theme | Implemented and verified | Follows the phone's light/dark setting; dark theme matches the reference app's colours. |

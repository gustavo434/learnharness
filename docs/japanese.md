# Japanese fork

This fork adds a Japanese tutor profile, WaniKani vocabulary context, and input
method support. Upstream: <https://github.com/amosblomqvist/learnharness>.

## Run and connect

Use Node.js 24 (pinned in `.nvmrc` and CI; minimum 22.19), `npm ci`, then `npm run dev` for the browser app or
`npm run desktop:dev` for Electron. Configure your model provider as usual. Open
**Settings → Japanese**. Japanese mode is enabled by default; save preferences
after changing it, the default session length, or interests. Changes apply on
subsequent turns, including existing sessions. Turn Japanese mode off to restore
the upstream tutor and quizzing behavior. In Japanese mode free recall is the
default unless you explicitly selected a different quizzing mechanic in Agent
settings. Recognition remains available by switching that mechanic.

Start with: “Give me 15 minutes of Japanese practice. Choose a useful goal, mix
reading and expression, and use suitable words from my WaniKani progress.”

Generate a read-only personal access token at
<https://www.wanikani.com/settings/personal_access_tokens>, and enter it only in
the private WaniKani field. Connect, refresh, replace the token, and disconnect
from this panel. Do not put the token in chat. The password field masks and clears
the token on submission; saved credentials are owner-only plaintext, not a vault.
They live in `.japanese-credentials/credentials.json` beside the configured
`auth.json` (the `LH_AUTH_FILE` directory). They are excluded from Git and packaged
server output. Never move credentials into a source file or a lesson note.

Preferences and the replaceable progress cache live under `data/japanese/`, or
`<LH_DATA_DIR>/japanese/`. The first status/lesson request after startup refreshes
progress; subsequent requests share the result and refresh after 15 minutes.
Manual refresh is immediate. Network failures preserve the last complete cache
with a stale label. Invalid credentials disable cached context. Changing accounts
cannot reuse the previous token's cache; disconnect disables context immediately
and clears the saved connection, without writing to WaniKani.

Only started, unburned, accessible kanji and vocabulary supply material. A bounded
selection favors mistake signals, Apprentice items and due reviews, rotating
other active material. WaniKani's exact dashboard Recent Mistakes list is not
available to this integration: counter changes and short-streak candidates have
different uncertainty labels and expire. Stages are exposure signals, not proof
of comprehension or production. The token is never sent to a model; the selected
vocabulary summary is sent to the chosen model provider. Lessons continue when
WaniKani is unavailable.

Japanese diagnostics are brief, answers are judged semantically, and explanations
allow contextual usage and exceptions. The app's small activity map remains for
its question placement, without an extra plan approval. Existing upstream prompt
overrides for accuracy, local-file mechanics and formatting still compose. The
Japanese pedagogy lives in `src/agent/japanese.ts`; upstream Teacher/Prober prompt
edits are used when Japanese mode is off. This first pass does not migrate the old
`learn` journal or provide durable spaced reviews, listening playback, or
pronunciation assessment. A graph node is encountered material, not mastery.

## Pulling upstream changes

Keep `origin` pointing to `gustavo434/learnharness` and `upstream` pointing to
`amosblomqvist/learnharness`. Preserve upstream history; integrate updates on a
fresh branch and review them before landing:

```bash
git fetch upstream --tags
git fetch origin
git switch -c codex/update-upstream origin/main
git merge --no-ff upstream/main
npm ci
TZ=UTC npm test
npm run typecheck
npm run lint
npm run build
```

Open an update PR against the fork's `main`. Resolve conflicts there and exercise
Japanese settings, IME confirmation, WaniKani restart/failure behavior, and a short
lesson before landing. Do not force-push shared history. While the initial PRs are
stacked, the combined Japanese implementation is on `codex/japanese-learning`;
land the IME PR first, then retarget the Japanese PR to `main`.

Most fork code is in `src/agent/japanese.ts`, `src/core/japanese.ts`,
`src/store/japanese/`, `src/server/japanese.ts`, `app/api/japanese/`, and the
Japanese settings component. Connection points in upstream files are the agent
factory options, turn profile, settings navigation, barrel exports, and credential
packaging exclusions. Upstream's base prompt files and chat/graph/settings schemas
are unchanged. Keep future Japanese behavior in these modules; avoid formatting
or renaming unrelated upstream code. If a connection point changes upstream,
reconnect the module rather than copying the older host implementation wholesale.
Conflicts remain possible; this structure keeps their likely scope small.

The additive **Japanese fork checks** workflow runs the type check, lint, full
suite, production build, payload guard and restart smoke check on pull requests,
including future upstream-update PRs. It needs no provider or WaniKani secrets.
GitHub may require enabling Actions for the fork before its first run.

## Desktop packages and verification

No fork installer is published by this change. Upstream downloads do not contain
these features. When preparing a fork installer, use the additive
`electron-builder.japanese.yml` configuration so its app identity, data directory,
and update feed belong to the fork. Do not ship using the upstream builder
configuration: it targets Amos's releases. Local packaging must pass
`--config electron-builder.japanese.yml --publish never`; signing/notarization
and publishing require a separate, explicitly authorized release setup.

The fork's tests include actual response-component composition events, WaniKani
API fixtures, private credential persistence, account changes, offline recovery,
concurrent refresh, prompt/rubric isolation, and diagnostic handoff. Run the full
suite with `TZ=UTC` because an upstream sidebar date fixture assumes that timezone.
After `npm run build` and `node scripts/build-server.mjs`,
`node scripts/smoke-japanese.mjs` checks the standalone app's HTTP routes across a
restart with disposable files, simulated WaniKani data, and no provider calls.
These checks do not establish a live model's Japanese accuracy or educational
effectiveness. Test real IME input on the target OS as well as the simulated
composition-event regression tests.

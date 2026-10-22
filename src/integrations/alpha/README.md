# AI Potluck bridge

Live, two-way conversation sync between Thunderbolt and an account on
[AI Potluck](https://www.aipotluck.org), an open AI chat service built from open models and
components. "Alpha" is its chat app, and the code uses that name.

This is an unofficial fork of Thunderbolt 0.1.145, made by Justin Stimatze (AI Potluck). It is not
affiliated with the Thunderbolt team.

**Status: a proof of concept.** It is not a pull request to Thunderbolt and not a plan of record
for either project. It runs in a fork pinned at upstream 0.1.145 to show that live sync can work end
to end. Upstream Thunderbolt has no seam for an integration like this, so the touch points below are
hard-coded. See "What upstream would need" at the end.

The part most worth reading is the `ExternalSyncProvider` shape below. A provider is two calls, in
Thunderbolt-shaped rows (the row types are in `provider.ts`):

```ts
export type ExternalSyncProvider = {
  id: string
  /**
   * Live changes after `cursor` (null = everything). Yields until the remote closes the stream,
   * then returns; the engine reconnects with the last cursor. Throws on transport or auth failure.
   */
  changes: (cursor: string | null, signal: AbortSignal) => AsyncIterable<InboundBatch>
  /** Idempotent: pushing the same rows twice must not duplicate them remotely. */
  push: (batch: OutboundBatch, signal: AbortSignal) => Promise<PushAck>
}
```

## How it works

The bridge runs entirely inside the Thunderbolt web client. It signs in to AI Potluck with OAuth
2.1 (authorization code with PKCE, public client, endpoints from the server's RFC 8414 discovery
document, all required to sit on the configured origin), and then:

- **pulls** over a server-sent-event stream with a resumable cursor, and
- **pushes** when PowerSync reports a change to `chat_threads` or `chat_messages`, reading only
  the rows that may need syncing.

Every local write goes through Thunderbolt's DAL, so PowerSync encrypts it and carries it to the
account's other devices as usual. AI Potluck sees only what this device pushes, in plaintext, and
never holds a Thunderbolt key. Tokens, the id map and the cursor live in two local-only tables
(`alpha_sync_secrets`, `alpha_sync_state`), which never sync and are left out of data export.

Sync runs only while a Thunderbolt tab is open, in one tab per browser (a Web Lock picks it; the
others show its status). Nothing runs server-side for Thunderbolt.

Messages that came from AI Potluck carry `metadata.alpha`, which syncs with the message. Every
device can therefore tell them apart from the person's own. It never pushes them back and never
auto-runs a reply to them. A chat created from AI Potluck has an id derived from the conversation's
id; a chat started in Thunderbolt has a random one, which nothing AI Potluck sends can reproduce.
When a conversation is deleted on AI Potluck, the chat is removed only if it came from AI Potluck
and holds nothing but AI Potluck's messages. Otherwise only the messages that came from AI Potluck
are removed, and the chat stays here, no longer synced. A chat started in Thunderbolt is never
removed. When a message that came from AI Potluck leaves its live branch (after a regenerate or an
edit there), this device deletes its copy, never sends that delete back, and brings the copy back
if the branch switches back to it. The delete leaves a marker in the row's metadata, which syncs
with it, so every device can tell it from the person's own delete. A message written in Thunderbolt
is never deleted this way (see "Known limits").

Ids are minted from AI Potluck's own data (each row's id and creation time), never from the
device's clock, so every device gives the same row the same id.

| File                                    | Role                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `plan.ts`                               | Pure decisions: id map, echo suppression, what to push, what a push answer means |
| `engine.ts`                             | The pull and push loops, their status and backoff, writes through the DAL        |
| `local-reads.ts`                        | Incremental reads of the chat tables joined to the id map                        |
| `provider.ts`                           | The `ExternalSyncProvider` interface                                             |
| `alpha-provider.ts`, `map.ts`, `sse.ts` | AI Potluck's wire format (v1), limits and transport                              |
| `connect.ts`, `locks.ts`                | OAuth, single-flight token refresh, disconnect and revocation                    |
| `errors.ts`                             | Failure classes and jittered backoff                                             |
| `use-alpha-sync.ts`, `bridge.ts`        | Starts the bridge in one tab; the engine loads only once connected               |
| `alpha-sync-card.tsx`                   | Settings → Connections card                                                      |
| `alpha-oauth-callback.tsx`              | The `/oauth/alpha/callback` page that finishes connecting                        |
| `ids.ts`                                | Reads and mints UUIDv7 ids; the text fingerprint for changed replies             |
| `storage.ts`                            | Reads and writes the two local-only tables: connection, id map, cursor           |
| `tables.ts`                             | The two local-only tables' schemas                                               |
| `provenance.ts`                         | Reads `metadata.alpha`, where a message came from on AI Potluck                  |
| `synced-threads.ts`                     | Which chats may hold AI Potluck's text, for project search to quote              |
| `refresh-open-chats.ts`                 | Re-reads an open chat's messages after a pull writes into it                     |
| `channel.ts`                            | BroadcastChannel between tabs: status, Retry, connection changes                 |
| `store.ts`                              | The card's state: connection, engine status, connect error                       |
| `teardown.ts`                           | Disconnects on sign-out, device revocation and account deletion                  |
| `config.ts`                             | Build-time server and client id, OAuth scope, callback path, source link         |
| `error-messages.ts`                     | What the card says for each sync and connect failure                             |
| `index.ts`                              | What the app shell imports                                                       |

## Configuration

Both variables are read at build time. The code has no default: with either unset, the card is hidden
and no request is made.

- `VITE_ALPHA_ORIGIN`: the AI Potluck origin, `https://` only (plain `http://localhost` is allowed in
  development builds).
- `VITE_ALPHA_CLIENT_ID`: the OAuth client that deployment registered for this build, with redirect
  URI `<Thunderbolt origin>/oauth/alpha/callback` and scopes `conversations:sync offline_access`.

The Docker frontend build takes both as build arguments, empty by default. The public sandbox's
image is built with `VITE_ALPHA_ORIGIN=https://develop.aipotluck.org`, AI Potluck's development
deployment, and `VITE_ALPHA_CLIENT_ID=thunderbolt-sandbox`.

The sync routes speak wire format v1 (`"v": 1` in every body) under AI Potluck's v2 chat API,
`/chat/api/v2/sync/changes` and `/chat/api/v2/sync/push`.

## Trying it

The `thunderbolt-sandbox` client accepts exactly one Thunderbolt origin,
`https://aipotluck-thunderbolt-sandbox.fly.dev`. It is the only redirect URI registered for the
client and the only origin AI Potluck's sync routes answer for it. In the sandbox, go to Settings →
Connections → AI Potluck → Connect, and sign in to AI Potluck when it asks. Sync is turned on only
for AI Potluck accounts that have been given access; any other account gets a "not found" when it
connects. Signing in to the sandbox itself is limited to the AI Potluck team's accounts; to try sync
from your own Thunderbolt, see the next paragraph. The sandbox syncs with AI Potluck's development
server, whose data can be wiped at any time. Don't keep anything there you need.

Thunderbolt served from any other origin, `bun dev` on `http://localhost:1420` included, needs a
client registered for that origin by the AI Potluck team; clients can't be registered at
runtime. To ask for one, email justin@justinstimatze.com with the origin you will serve from and
the AI Potluck account to turn sync on for.
Then build with the client id you are given:

    VITE_ALPHA_ORIGIN=https://develop.aipotluck.org VITE_ALPHA_CLIENT_ID=<your client id> bun dev

or, for the Docker image:

    docker build -f deploy/docker/frontend.Dockerfile \
      --build-arg VITE_ALPHA_ORIGIN=https://develop.aipotluck.org \
      --build-arg VITE_ALPHA_CLIENT_ID=<your client id> -t thunderbolt-ai-potluck .

## Scope

- **Downloads all AI Potluck history.** The first connect copies every AI Potluck conversation into
  Thunderbolt; after that, new conversations, messages, renames and deletes follow.
- **Uploads only new chats.** Chats started after the account first connected are uploaded, on any
  of the account's devices, since they all reach the connected tab through Thunderbolt's sync. The
  time of that first connect syncs between devices as a Thunderbolt setting (`alpha_sync_from`),
  so a browser that connects later syncs the chats an earlier one already does, in both
  directions. Connecting does not upload older history. The window only moves earlier:
  Disconnect keeps it, so connecting again, or from a browser after every other one disconnected,
  syncs every chat that synced before, and uploads chats started since the first connect,
  including ones started while disconnected. A chat that has synced syncs whole, whatever the
  window. The bridge starts only once this device has downloaded everything Thunderbolt's sync
  holds for it.
- Assistant replies are pushed once they have finished and stopped changing for 4 seconds. A reply
  that still looks unfinished (a part still streaming, a tool call without its result) is pushed
  as it stands once it has not changed for 60 seconds, because a reply stopped or failed mid-stream
  stays that way. A reply that is still empty after 60 seconds is recorded as not synced. A reply
  AI Potluck fills in after first sending it is updated here, unless it was edited here in the
  meantime.
- Private chats are never uploaded.
- System messages are not synced in either direction. Messages past AI Potluck's size limits are
  recorded as not synced; the card shows how many, and Retry sends the ones AI Potluck refused again.
  A delete or rename that AI Potluck refuses only by refusing the whole push body (a 400 that names
  no row, as after a deploy with a stricter schema) is never recorded as done: it stays unsent, the
  push backs off, and it is sent again after the backoff or on Retry.
- An AI Potluck conversation this device can't apply (past the 5000-message limit, unreadable, or
  in an event over 8 million characters) is skipped and counted as not synced on the card, and the
  rest of the stream carries on. It is applied when it next arrives within the limits. An event
  listing more than 500 conversations is skipped whole. A skip that can't name its conversation (a
  whole event) is cleared by Retry, which reads the stream again from just before the first such
  event; if it still can't be read, it is counted again. Each record of a skip is a row here, so it
  counts as a chat against the daily budget (see "Known limits"), and at most 1,000 are kept
  (`maxSkipRecords` in `plan.ts`); past that, a skip is left to its event's replay on Retry.
  Disconnect clears them.
- Deleting a synced chat asks where to delete it: "Delete this chat from Thunderbolt and AI
  Potluck?" deletes it on AI Potluck with one conversation delete (the push's `deletedAt` row, which
  AI Potluck's sync API applies as a whole-conversation cascade), never one delete per message;
  "Remove from Thunderbolt only" sends nothing. Either way a whole chat's messages are never
  deleted one by one. The choice is kept in this device's `alpha_sync_state` until the bridge reads
  it, so a chat deleted on a device that is not connected, or by "delete all chats", has no choice:
  then a chat started in Thunderbolt is deleted there and one that came from AI Potluck stays.
  Deleting one message while the chat stays is pushed only for a message written in Thunderbolt,
  including one written into a chat that came from AI Potluck; a message that came from AI Potluck
  is never deleted there. The card says so.
- Signing out, device revocation and account deletion disconnect and revoke the grant. Chats
  already on AI Potluck stay there. Every OAuth request has a time limit. Disconnecting waits at
  most 5 seconds for another tab's token refresh, then up to 5 more for AI Potluck to revoke the
  grant, so AI Potluck can hold up a sign-out by at most about 10 seconds.

## Tests

    bun test src/integrations/alpha src/chats/use-chat-automation.test.tsx \
      src/dal/chat-messages.test.ts src/dal/chat-threads.test.ts src/db/powersync/schema.test.ts \
      src/acp/built-in-conversation.test.ts src/acp/acp-adapter.test.ts \
      src/components/chat/markdown-blocks.test.ts src/components/chat/memoized-markdown.test.tsx \
      src/components/chat/rewrite-math-upstream.test.ts src/components/chat/math-cap-macros.test.ts \
      src/components/delete-chat-dialog.test.tsx --timeout 5000

All but the first are the upstream tests this fork changes or adds. The project search tool and
skill resolution changes are tested in `src/integrations/alpha/synced-text-to-models.test.ts`.

## Known limits

- **Web only.** The desktop and mobile apps hide the card: their OAuth redirect is not wired up.
- **Live only while a tab is open.** Changes made while every tab is closed sync on the next open.
- **Edits to a sent message don't sync**, nor do attachments, tool calls or reasoning. A reply
  pushed after 60 seconds unchanged mid-tool-call stays as it was pushed.
- **Plaintext leaves end-to-end encryption.** That is inherent: AI Potluck stores what it is sent.
  The card says so before connecting.
- **AI Potluck is trusted with what it sends.** It can add turns to any synced chat, placed by
  their AI Potluck time but never before the chat began. They carry `metadata.alpha`, but nothing
  in the UI marks them yet: Thunderbolt's message views have no place for a label without changing
  each of them. A model that later reads the chat gets each such turn quoted, behind a note that it
  came from AI Potluck and is to be read as history (`quoteSyncedTurns` in `provenance.ts`): the
  chat pipeline, the built-in agent's harness, external ACP agents and hosted agents all apply it,
  and the project search tool quotes a hit from a synced chat, its title included, behind a like
  note. A synced user turn never picks the person's skills (`/name`) or the web-search intent, even
  when it is the latest one a request sends (`extractLastUserText`).
  That lowers the odds that text planted there (prompt injection) steers this device's tools; it
  can't rule it out. Each change event is bounded (500 conversations, 5000 messages each), and so
  is a day: once AI Potluck has written 2,000 chats, 50,000 messages or 100 million characters here
  within 24 hours, a change that would write more waits for the next day, and the card says so
  (`inboundDailyBudget` in `engine.ts`). A reply rewritten there counts its whole new text, and a
  rename its whole title, since both are stored and uploaded again. While a change waits, the pull
  keeps reading the changes after it and applies their deletes, so a chat deleted on AI Potluck
  meanwhile goes here too; everything else in them waits with it, in order. The change that
  crosses a limit lands whole, so a day can take one event more than the limit, and one event can
  carry up to 500 conversations and 8 million characters.
- **Text from AI Potluck is made safe to render.** Every `<` that opens a namespaced tag is escaped,
  so nothing it sends renders as a live widget, and runs of whitespace are cut to 100 characters,
  because Thunderbolt's widget parser backtracks on both. In a code block the escape shows, so
  namespaced XML there reads `&lt;xsl:template …>`. Every `![` gets an invisible word joiner after
  its `!`, so an image in the markdown renders as a link that loads nothing until it is clicked,
  rather than a beacon fetched when the chat opens; an image with no alt text shows nothing. Rows
  stored before this change keep their images. The markdown renderer's own math passes are
  linear (`markdown-blocks.ts`), but KaTeX's cost grows with what it is given: 200,000 characters
  of nested fractions took 38 seconds, and a wide display of that size grew past 3 GB. So no
  message hands KaTeX an expression over 2,000 characters, or more than 5,000 characters of math
  in all (each expression counting 4 more), and math past either cap shows as code
  (`components/chat/math-cap.ts`); the worst case measured at the caps took about 0.65 seconds.
  Those caps count source characters, and a macro expands: three nested `\def`s in 632 characters
  render as 40 MB of HTML under KaTeX's defaults. So an expression that defines a macro (`\def`,
  `\newcommand`, `\let` and the like) shows as code, and KaTeX runs with at most 200 macro
  expansions per expression and every user-given size capped at 20 em. These caps apply to every
  message, not only synced ones.
  remark-gfm's autolink-literal pass is not linear either, so a message at the 200,000-character
  cap built for it costs about a second each time the chat renders.
- **An edit or regenerate on AI Potluck of a turn written here leaves both versions here.** Only
  messages that came from AI Potluck are deleted when they leave its live branch. Deleting a turn
  written here on AI Potluck's word would let it erase the person's own text, which nothing else it
  sends can do, so the old version stays and the new one is added beside it.
- **Clocks.** A row AI Potluck dates more than a day ahead of this device's clock is skipped rather
  than given an id from the local clock; a copy of it already here is kept, never deleted. New
  local ids do use the device's clock, so a device whose clock runs fast can sort later AI Potluck
  turns above its own earlier messages.
- **Sync window across browsers.** Nothing deletes the account's shared sync window except a move
  to another server, so after Disconnect, connecting again uploads the chats started meanwhile.
  The setting is part of a data export, so an import carries the window with it.
- **No account binding.** The bridge does not check that the AI Potluck account belongs to the same
  person as the Thunderbolt account; whoever connects decides.
- **One server per build.** Pointing a build at another origin starts the id map over.
- **Idempotency key.** AI Potluck deduplicates pushes by this build's client id and the local row id.
  The AI Potluck account is not part of that key, and adding it needs a server change.
- **Not in one transaction.** A batch's rows are written first, then its map entries, then the
  stream cursor. A failure or crash in between saves neither, so the stream replays the batch from
  the last saved cursor and plans it again against the rows already written. A branch drop's
  marker is written in the same transaction as its delete, so the replay still reads that delete
  as the bridge's.
- **Renames.** A rename made here back to a title AI Potluck sent recently (one of the last five)
  is not pushed, because it can't be told apart from a late copy of AI Potluck's own rename.
- **Renames race across browsers.** A title change that reaches a connected browser through
  Thunderbolt's sync is pushed as the person's rename unless that browser has already pulled it
  from AI Potluck. So when AI Potluck renames a chat twice in quick succession (to A, then B), and
  browser 1 pulls both while browser 2 has pulled neither, browser 2 can receive title A through
  Thunderbolt's sync and push it back, undoing B everywhere. A title row carries no record of who
  wrote it, so the fix needs a conditional rename on the server (push the last agreed title with
  the new one, and refuse when the server's title has moved on).

## What upstream would need

If Thunderbolt wanted to support integrations like this, it would likely need:

1. a provider registry in place of the hard-coded hook, route and card;
2. a generic local-only `external_sync_state` table keyed by provider, in place of the two tables
   defined in this folder;
3. the `ExternalSyncProvider` contract, with the engine and `plan.ts` moving into core so each
   provider ships only its transport and wire mapping;
4. a desktop OAuth path (loopback or deep link) for the Tauri apps.

The upstream touch points today:

- `app.tsx` (hook and lazy route) and `settings/connections/connections-list.tsx` (card);
- `db/tables.ts` and `db/powersync/schema.ts` (two local-only tables), `dal/export.ts` (exclusions);
- `dal/chat-messages.ts` (`softDeleteChatMessages`, `restoreChatMessages`,
  `saveChatMessagesWithParents`), `dal/chat-threads.ts` (`deleteChatThreadIfEmpty`), and the four
  exported from `dal/index.ts`;
- `lib/cleanup.ts` (disconnect on sign-out);
- `components/delete-chat-dialog.tsx`, `components/ui/confirm-action-dialog.tsx` (an optional
  second choice) and `layout/sidebar/` (`index.tsx`, `chat-list.tsx`, `types.ts`), which ask where
  to delete a synced chat and record the answer;
- `chats/use-chat-automation.tsx` (never auto-run a synced thread) and
  `skills/resolve-skill-system-messages.ts` (a synced user turn picks no skills);
- `ai/fetch.ts`, `acp/built-in-conversation.ts`, `acp/acp-adapter.ts` and
  `acp/managed-http-adapter.ts` (quote synced turns in a model's input, on every path that sends
  prior turns to one), `projects/load-project-context.ts` and `projects/project-search-tool.ts`
  (quote search hits from a synced chat), `components/chat/markdown-blocks.ts` (its math passes
  made linear, since synced text reaches it at up to 200,000 characters), and `components/chat/memoized-markdown.tsx`
  with `components/chat/math-cap.ts` (what a message may hand KaTeX);
- `types.ts` (`metadata.alpha`) and `vite-env.d.ts` (the two build variables);
- `package.json` and `bun.lock` (`@noble/hashes` for id seeding, `eventsource-parser` for the
  change stream);
- the locale catalogs (`src/locales/*/messages.po`), for the card's and the delete dialog's strings;
- `deploy/docker/frontend.Dockerfile` (two build arguments), the top-level `README.md` (the
  fork notice) and `docs/internals/architecture/data-access-layer.md` (the bridge's direct reads).

`db/tables.ts` re-exports the bridge's two tables from this folder, so a core module imports from
an integration. That keeps the schema in one list for this proof of concept; the generic table in
point 2 would remove it.

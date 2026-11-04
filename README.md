# PackProof Communications

An independent TypeScript workspace for evidence-based voice conversations and continuous demo radio. It uses LiveKit Cloud for media; PackProof remains the authority for verification, accounts, ownership and signatures. No PackProof application source, database keys or signing keys are imported here.

## Verified status — 4 November 2026

| Capability             | Execution evidence                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent workspace  | Builds from this repository; pinned dependencies and lockfile. Node 22.23.3, pnpm 10.15.1, Docker 29.8.1, LiveKit CLI 2.19.3 used.                                                                                                                                                                                                                                                      |
| LiveKit Cloud          | Dedicated `packproof-voice`, project `p_3pioq5k9q4r`, hostname `packproof-voice-q0jp1pic.livekit.cloud`. Real room creation, named-agent dispatch creation, scoped token issuance and room deletion passed.                                                                                                                                                                             |
| Voice agent            | Real `AgentSession`, official Meta STT plugin, Muse Chat Completions and Kokoro via the official Node OpenAI-compatible TTS adapter. Scripted-provider SDK tests pass; **no deployed agent or live microphone call is claimed**.                                                                                                                                                        |
| Meta STT / Muse Spark  | Integration implemented. Live requests were not made: the initial tests had no runtime key or approved communications budget. An updated key is now present locally; live model access remains untested. Scripted SDK inference and HTTP-boundary fixtures are distinct from live Meta tests.                                                                                           |
| Kokoro                 | Real protected local inference. WAV: PCM16, 24 kHz mono, 6.885 seconds. Actual LiveKit TTS adapter: 114,789 samples, 4.783 seconds, 24 kHz mono. Missing service authorization returned 401.                                                                                                                                                                                            |
| Browser                | Mobile Chrome UI tests cover missing and expired authorization. No real Cloud browser audio exchange has been tested.                                                                                                                                                                                                                                                                   |
| PackProof API          | HTTP adapter and explicit fixtures implemented. Canonical Terminal 1 paths, DTO mapping, credentials and assertion/delegation approval remain external dependencies. No real PackProof API authentication is claimed.                                                                                                                                                                   |
| Radio                  | Local Kokoro, protected TTS proxy, worker, Liquidsoap 2.3.3 and Icecast 2.4.4 ran. A real FFmpeg Icecast client decoded continuous stereo 44.1 kHz audio.                                                                                                                                                                                                                               |
| Automatic announcement | Fixture bulletin generated real Kokoro audio and reached actual `started` and `completed` playback receipts with an active Icecast mount. A 90-second client capture contains speech followed by background music. Initial file-access and callback-URL failures were corrected; the bounded third attempt completed. This was **a fixture event, not a real signed PackProof notice**. |
| Telephone / Sonetel    | Restricted configuration generator and public-only SIP agent entry implemented. Sonetel signup is unavailable and this provider is deferred. No replacement route or public number has been confirmed. No trunk or number was purchased or provisioned, and no PSTN call was tested.                                                                                                    |
| SMS                    | Small adapter contract only. No provider or deployment.                                                                                                                                                                                                                                                                                                                                 |

Local artifacts, intentionally ignored by Git, include `.runtime/artifacts/kokoro-smoke.wav`, `livekit-kokoro.pcm`, `radio-listen.wav`, `radio-final.wav`, `radio-audio-evidence.json` and `web-demo-mobile.png`. The audio check measures actual decoded signal; it is not speech recognition or a claim of a human listening test. No caller recordings were made.

## Workspace

- `apps/voice-agent`: named `packproof-voice` LiveKit Node worker; Cloud deployment uses the root Dockerfile and build context.
- `apps/gateway`: independent HTTP gateway behind HTTPS ingress; JWT authorization, one-use invitations, room/token creation, dispatch, durable limits and cleanup.
- `apps/web-demo`: mobile React voice interface, Session API, transcripts, source references, optional radio player and authenticated iframe handoff.
- `apps/radio`: separate event worker, persistent SQLite delivery ledger, Liquidsoap queue and Icecast stream. SQLite stores communication delivery state only, not product or identity records.
- `packages/shared-contracts`: bounded DTOs, tool-provider interface, scoped access context and optional SMS boundary.
- `packages/verification-adapters`: HTTP and fixture implementations of the same interface; `PackProofVerificationProvider` is the first tool provider.
- `packages/speech`: bounded Muse script selection and protected Kokoro HTTP client shared by radio and voice.

Other applications can implement `ToolProvider`; there is no dynamic code loading, arbitrary URL ingestion or second verification engine.

## Build and test

Requires Node >=22.13, pnpm 10.15.1, and Docker Compose for audio services. FFmpeg and Python 3 are used by local audio checks. Chrome is used for browser tests; set `CHROME_PATH` if it is elsewhere.

```sh
npx --yes pnpm@10.15.1 install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:browser
pnpm format:check
```

Final local results: **62 application/SDK/security tests and 3 browser tests passed**. Build, type checks, formatting, standalone container build and container VAD loading passed.

The suite covers room-bound context forgery, expired and replayed assertions, asymmetric JWKS handoff, forged identities/roles, cross-session cleanup, public/private separation, tool bounds, exact identifiers, interrupted readback, source binding/applicability, stale/missing evidence, source prompt injection, malformed model output, TTS failures, forged radio events, duplicate delivery, playback ordering and dead-letter limits. SDK tests use a scripted provider and do not establish natural-language quality with live Muse. Live audio, turn-taking, network reconnection and telephone acceptance remain separate deployment checks.

## Filling `.env.local`

The root `.env.local` already has updated LiveKit credentials and `MODEL_API_KEY`; only their presence has been checked. `pnpm env:local` fills empty local settings using this repository's existing generated service secrets, preserves supplied keys, and makes secret files readable only by the owner. It also selects the existing protected local Kokoro proxy. Running it again does not rotate keys or enable paid requests.

```sh
pnpm env:local
pnpm env:check
```

| Variables                                                                                           | Where the values come from                                                                                                                                                                | Needed now?                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`                                              | Your dedicated LiveKit Cloud project's credentials. These are needed for the local worker and standalone gateway.                                                                         | Already present locally. Cloud-hosted agents receive them automatically.                                     |
| `MODEL_API_KEY`                                                                                     | [Meta Model API dashboard → API keys → Create API key](https://dev.meta.ai/docs/authentication). Use the same key for Muse Spark and Muse Voice Transcribe when the account permits both. | Already present; permissions and billing are unverified.                                                     |
| `VOICE_CONTEXT_SECRET`                                                                              | Generated by `pnpm env:local`; the gateway and worker must share it.                                                                                                                      | Filled locally. Include it in protected Cloud worker secrets later.                                          |
| `VOICE_INVITE_SECRET`                                                                               | Generated locally; signs one-use public demo invitations.                                                                                                                                 | Filled locally; gateway only.                                                                                |
| `KOKORO_SERVICE_TOKEN`, `RADIO_CONTROL_TOKEN`, `ICECAST_SOURCE_PASSWORD`, `ICECAST_ADMIN_PASSWORD`  | Generated locally; these protect our own services and are not provider-issued API keys.                                                                                                   | Filled locally; reuse the relevant values at approved service deployments.                                   |
| `KOKORO_BASE_URL`                                                                                   | Local: `http://127.0.0.1:8880/v1`. Cloud worker: the protected HTTPS `/v1` endpoint of the independently deployed Kokoro service.                                                         | Local value filled. A reachable Cloud endpoint is still required.                                            |
| `PACKPROOF_API_BASE_URL`, `PACKPROOF_API_TOKEN`, `PACKPROOF_ENDPOINT_PATHS`                         | Terminal 1's finalized API and scoped developer credential. Do not use a Supabase service-role key.                                                                                       | Leave empty and retain `PACKPROOF_MODE=fixtures`.                                                            |
| `VOICE_SESSION_AUTH_CONFIG`                                                                         | Terminal 1's explicitly approved assertion issuer, audience and JWKS URL.                                                                                                                 | Leave empty for one-use public demo invitations.                                                             |
| `RADIO_EVENT_SOURCE_URL`, `RADIO_EVENT_SOURCE_TOKEN`                                                | Terminal 1's authorized notice/event endpoint and scoped credential.                                                                                                                      | Leave empty and retain `RADIO_MODE=fixtures`.                                                                |
| `VOICE_ALLOWED_ORIGINS`, `VITE_VOICE_GATEWAY_URL`, `VITE_RADIO_STREAM_URL`, `VITE_PACKPROOF_ORIGIN` | Actual frontend/gateway/stream addresses chosen for this deployment. Local defaults are supplied.                                                                                         | Change to approved HTTPS origins when those hosts exist. Only `VITE_*` values enter browser code.            |
| `PORT`, `GATEWAY_STATE_PATH`, `RADIO_DATA_DIR`                                                      | Local runtime/storage settings in `.env.example`; `/data` is the radio container's mounted directory.                                                                                     | Defaults are sufficient for the documented local setup.                                                      |
| `LIVEKIT_ALLOWED_SIP_TRUNKS`                                                                        | IDs of verified restricted inbound trunks after choosing a replacement provider. Provider SIP usernames/passwords are separate credentials.                                               | Keep empty; Sonetel signup failed and telephone is deferred. A SIP account is not a public telephone number. |

The frontend explicitly reads the workspace root environment. The local Compose stack retains its separate ignored `.runtime/local.env`, so automatically generated local credentials do not become account credentials. The checker reports mismatches without printing values. `META_LIVE_ENABLED=false` remains the default; a supplied Meta key alone does not establish a spending budget.

LiveKit Cloud [injects its own three LiveKit credentials](https://docs.livekit.io/deploy/agents/secrets/) and does not accept them as custom worker secrets. After a protected public Kokoro endpoint and bounded Meta usage are approved, prepare a filtered worker file:

```sh
pnpm env:check --cloud
pnpm env:agent
# After approval to deploy to the selected project/plan:
lk --project packproof-voice agent create . --secrets-file .env.agent
# For an already-created agent; updates restart the worker:
lk --project packproof-voice agent update-secrets . --secrets-file .env.agent
```

The exporter refuses local-only speech endpoints and disabled Meta usage, omits LiveKit's injected credentials, gateway/radio/browser settings and provider SIP credentials, and writes `.env.agent` with mode 0600. These commands do not upload anything until an explicit LiveKit CLI deployment/update command is run. Empty PackProof credentials are not exported in fixture mode.

Kokoro and the radio stack run independently of Vercel. Modal is only an option to evaluate for Kokoro after measuring real latency, cold starts and cost under an approved testing budget. No Modal setup has been deployed, and it is not assumed to suit always-on Icecast/Liquidsoap streaming. The next external requirements for a Cloud voice test are the protected Kokoro HTTPS endpoint and a specified Meta test-spend cap; the PackProof scoped API credential can follow Terminal 1's finalization.

## Local radio and TTS

Initialize local-only service secrets once, then create the single original audio bed:

```sh
node scripts/init-local.mjs
python3 scripts/create-bed.py
pnpm radio:up
```

`init-local.mjs` writes randomly generated secrets to ignored `.runtime/local.env`, mode 0600, and refuses to overwrite them. It does not obtain provider credentials. The bed is synthesized from an original four-chord composition without samples; that composition and generated demonstration audio bed are dedicated to the public domain under CC0. Its provenance is in `scripts/create-bed.py`.

Local endpoints:

- Stream: `http://127.0.0.1:8000/packproof.mp3`.
- Protected speech: `http://127.0.0.1:8880/v1/audio/speech`.
- Worker health: `http://127.0.0.1:8787/healthz`; control routes require `RADIO_CONTROL_TOKEN`.

Only loopback ports are published. Raw Kokoro and Liquidsoap control are not published. The TTS proxy limits request size, request rate and concurrency, and streams PCM without proxy buffering. Radio data is mounted read-only into Liquidsoap; its UID matches the worker for shared audio access. The worker allows only generated local audio paths in queue commands.

```sh
node --env-file=.runtime/local.env scripts/local-tts-smoke.mjs
node --env-file=.runtime/local.env scripts/local-agent-tts-smoke.mjs
node --env-file=.runtime/local.env scripts/radio-control-smoke.mjs
ffmpeg -i http://127.0.0.1:8000/packproof.mp3 -t 90 .runtime/artifacts/radio-capture.wav
python3 scripts/inspect-radio-audio.py .runtime/artifacts/radio-capture.wav
```

A smoke test synthesizes short demo text locally; it spends no hosted inference credits. `pnpm radio:down` stops these containers while preserving the ledger and cursor.

For authoritative events set `RADIO_MODE=http`, an HTTPS `RADIO_EVENT_SOURCE_URL` and `RADIO_EVENT_SOURCE_TOKEN`. Poll responses are `{ "cursor": "opaque", "events": [BroadcastEnvelope] }`; the schema is exported from shared contracts. Each envelope carries the requested `BroadcastCandidate` plus authoritative `authorization: {eligible:true, signatureVerified:true, publication:"demo_public", expiresAt, sourceRecordId}`. The authenticated PackProof endpoint must establish those facts; this service does not independently verify signatures. Only four allowlisted demo categories, matching source record IDs, evidence references, policy version and fresh timestamps pass. Arbitrary summaries never reach speech. Invalid batches do not advance the cursor.

The ledger persists `accepted → generated → queued → started → completed`, failures, at most three attempts, dead letters and unique event/idempotency keys. Queue acceptance alone is insufficient. Liquidsoap reports final-source track selection and the next track boundary using authenticated callbacks off the audio clock. The worker also checks the Icecast source is active. An uncertain playback timeout can cause a bounded replay; this is not an exactly-once guarantee across process/network failures. Completed events remain deduplicated after restart. Run one worker per ledger; back up its durable volume and provision disk retention for generated demo audio.

## Gateway and web voice

Copy `.env.example` to ignored `.env.local` and fill the chosen runtime settings with real values. The code uses only the variables listed there. Never put secrets in `VITE_*`. For a local gateway, load `.env.local` then `.runtime/local.env` if using the generated development service secrets:

```sh
node --env-file=.env.local --env-file=.runtime/local.env apps/gateway/dist/main.js
pnpm dev:web
```

For production use the image with `SERVICE=gateway` and a writable persistent `/data` directory (`deploy/gateway.compose.yaml`). Run one gateway replica per SQLite ledger. Put it behind HTTPS; allow only exact application origins in `VOICE_ALLOWED_ORIGINS`. Limits are three concurrent rooms, five requests per subject/hour, ten per source IP/hour and twenty sessions per rolling day globally, with a five-minute session ceiling. The socket peer is the IP authority; forwarded headers are not trusted. A reverse proxy therefore shares that IP limit unless a separately reviewed proxy policy is added.

`POST /v1/voice/sessions` accepts an empty JSON object and a Bearer assertion. It rejects caller-supplied identities, roles, room names and agent selection. It returns `{serverUrl, participantToken, sessionId, expiresAt, cleanupToken}`. The token allows only joining that unique room, microphone publication, subscription and data. Room capacity is two. The 60-second join token does not replace the server/agent lifetime limit. `DELETE /v1/voice/sessions/:sessionId` requires that session's opaque cleanup token; expired leases are reaped every ten seconds and cleanup failures remain durable.

Without `VOICE_SESSION_AUTH_CONFIG`, only one-use five-minute public invitations signed using `VOICE_INVITE_SECRET` work. Generate one with `node --env-file=.runtime/local.env scripts/demo-invite.mjs`; this deliberately prints a short-lived caller invitation, not a service secret. Store neither invitations nor assertions in URLs or local storage.

Authenticated PackProof access is opt-in: `VOICE_SESSION_AUTH_CONFIG` contains exact `issuer`, `audience`, and HTTPS `jwksUrl`. Only RS256/ES256 assertions with trusted `sub`, unique `jti`, `exp` within ten minutes and signed `voice_scopes` are accepted. Valid scopes are `verification:public` and `verification:private`. PackProof must approve and implement this trust/delegation contract before it is enabled. Manufacturer/regular-user labels never grant voice authority.

The signed internal context is bound to room, caller, scopes and expiry. Private lookups require the original verified PackProof assertion, which is forwarded as `X-PackProof-Assertion` alongside the service API token; PackProof must independently authorize each request. Dispatch metadata is sensitive and must not be logged. SDK recording/export is disabled (`record:false`); application telemetry logs only opaque session IDs, states, usage counters and bounded error codes. Keep SDK debug logging off for real callers.

## Terminal 1 integration

The standalone frontend can be hosted on a separate HTTPS origin and embedded:

```html
<iframe
  title="Talk to PackProof"
  src="https://YOUR-VOICE-UI/"
  allow="microphone"
  referrerpolicy="no-referrer"
></iframe>
<audio
  controls
  preload="none"
  src="https://YOUR-RADIO-DOMAIN/packproof.mp3"
></audio>
```

Set `VITE_VOICE_GATEWAY_URL`, `VITE_PACKPROOF_ORIGIN` and optionally `VITE_RADIO_STREAM_URL` at frontend build time. Configure the static host's frame-ancestors and microphone permissions for the approved PackProof origin. No production UI domain is provisioned by this repository.

On Connect, the iframe sends `{type:"packproof.voice.request-assertion", requestId}` to its configured PackProof parent origin. Terminal 1 checks the exact iframe origin and `event.source === iframe.contentWindow`, obtains a fresh server-issued assertion through its existing authenticated backend, then responds to that exact origin/source with `{type:"packproof.voice.assertion", requestId, assertion}`. The iframe checks source, origin and nonce, waits at most ten seconds, and keeps the assertion in memory. It cannot register users or invent account roles. Top-level demo usage accepts a manually supplied public invitation.

`VoicePanel` is also exported by `@packproof/web-demo/VoicePanel`, with `{gatewayUrl, getAssertion, radioUrl?}`. The iframe/HTTP contract works across independent repositories without filesystem imports or a package publication. Inspector/ChainProof remain website continuations for images and signatures.

Terminal 1 must map its authoritative API into `VerificationResult` or agree on a revised DTO. Implemented operations are product, packaging, seller authority, notices, custody, ownership, verification, evidence references and offline-pack metadata. IDs are strings. Claims carry applicability and source IDs; permitted custody/ownership/offline metadata are typed and private by default. Seller responses must bind the requested seller ID. Statuses are `supported`, `blocked`, `needs_evidence`, `unavailable`, `stale`. Results preserve timestamps, expiry, limitations and source references. Unknown fields are stripped. Defaults under `/v1/products/{itemId}` are **proposed paths**, overridable per operation using `PACKPROOF_ENDPOINT_PATHS`; they are not a claim that those routes exist today. Fixture ID `0071842`, seller `SELLER-01`, is explicitly labeled in speech and UI.

## Deploying the voice worker

The deployed worker receives `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` automatically from LiveKit Cloud; only the local worker and independent gateway need those values configured here. First supply approved Meta access and a reachable protected Kokoro HTTPS endpoint. A Cloud worker cannot use this computer's loopback URL, a Docker hostname or an unauthenticated public TTS server. Use `pnpm env:agent` to prepare only actual external credentials/settings in a protected ignored `.env.agent` file; share `VOICE_CONTEXT_SECRET` with the gateway. API mode requires the approved PackProof endpoint and delegation contract. Use explicit `PACKPROOF_MODE=fixtures` for an honestly labeled demonstration.

```sh
pnpm build
lk --project packproof-voice agent dev apps/voice-agent/dist/main.js
lk --project packproof-voice agent start apps/voice-agent/dist/main.js
lk --project packproof-voice agent create . --secrets-file .env.agent
lk --project packproof-voice agent deploy . --secrets-file .env.agent
lk --project packproof-voice agent status .
lk --project packproof-voice agent versions .
lk --project packproof-voice agent logs . --log-type build
lk --project packproof-voice agent logs . --log-type deploy
```

Creation prompts for a deployment region and writes the agent ID into root `livekit.toml`. The root Docker context is required. The official starter was obtained using `lk agent init --lang node`; its session/worker conventions were adapted for this workspace. Agent Console must select `packproof-voice` and the development deployment printed by the CLI. Production dispatch targets the production deployment. Cloud health, registration, microphone access, live Muse STT, live Muse explanations, provider recovery and an actual browser conversation still require execution after those dependencies are supplied. The provider stream limit is 60 minutes; calls here expire after five minutes, and unrecoverable speech-provider closure ends the session.

For public services, `deploy/Caddyfile` is a TLS-ingress example requiring real DNS and `VOICE_GATEWAY_DOMAIN`, `KOKORO_DOMAIN`, `RADIO_DOMAIN` on the chosen host. Attach the proxy to the matching service networks. Radio ingress exposes only the audio mount, not admin or control routes. No recurring host, DNS or certificates have been provisioned.

## Telephone and SMS

Sonetel signup is unavailable, so this provider is deferred and no Sonetel account is required to continue web voice or radio. Its documentation describes SIP-address forwarding and separately priced phone numbers; a free SIP address is not proof of PSTN availability. Choose a replacement provider only when ready to test telephone access. Any replacement provider's external forwarding, ingress CIDRs and digest-auth compatibility must be confirmed. The generator in `deploy/telephony/configure.mjs` requires an existing approved E.164 number, confirmed `SIP_PROVIDER_CIDRS`, `SIP_AUTH_USERNAME`, `SIP_AUTH_PASSWORD` and then the assigned `LIVEKIT_SIP_TRUNK_ID` for dispatch-rule generation. It writes protected ignored trunk/rule JSON and performs no provider mutation. Create the inbound trunk with the official CLI, then regenerate the dispatch rule with its assigned ID:

```sh
node deploy/telephony/configure.mjs
lk --project packproof-voice sip inbound create .runtime/telephony/inbound-trunk.json
lk --project packproof-voice sip dispatch create .runtime/telephony/dispatch-rule.json
```

Set the deployed agent's `LIVEKIT_ALLOWED_SIP_TRUNKS` after verifying ingress. SIP participants always receive public scope; caller ID never authenticates a PackProof account. The rule uses separate per-caller rooms and hides phone numbers from other participants. LiveKit's individual-room names may still include caller numbers in provider logs; apply a reviewed telephony privacy policy before real calls. The generator/configuration has not been applied to an actual Sonetel route. If the account cannot provide compatible restricted ingress, retain web voice or adapt the provider boundary. The optional `SmsAdapter` contract requires provider signature verification, delivery IDs and controlled replies; no unauthenticated SMS webhook exists.

## Costs and remaining deployment dependencies

No hosted Meta calls, phone-number purchases, forwarding upgrades or recurring infrastructure were authorized or used. The existing PackProof reviewer's $5 is not treated as a communications budget. Remaining account balances and the project's actual plan usage were not available from the inspected CLI; do not infer them from advertised allowances.

As checked on 4 November 2026, [Meta pricing](https://dev.meta.ai/docs/pricing-rate-limits) lists standard Muse Spark input/output at $1.25/$4.25 per million tokens and Voice Transcribe at $0.18/hour. [LiveKit pricing](https://livekit.io/pricing) advertises Build allowances including 1,000 agent minutes, 5 concurrent sessions, one deployment and 1,000 third-party SIP minutes; telephone inventory and account-specific allowance must be checked before activation. No paid TTS provider is substituted. Kokoro/radio testing used local CPU, memory and disk.

Required credential names: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `MODEL_API_KEY`, `PACKPROOF_API_TOKEN`, `VOICE_CONTEXT_SECRET`, `VOICE_INVITE_SECRET`, `KOKORO_SERVICE_TOKEN`, `RADIO_CONTROL_TOKEN`, `RADIO_EVENT_SOURCE_TOKEN`, `ICECAST_SOURCE_PASSWORD`, `ICECAST_ADMIN_PASSWORD`; telephone additionally needs compatible SIP digest credentials. Addresses and exact optional settings are in `.env.example` and the deployment configurations.

Remaining external work: verified Meta model access and approved budget (key now present locally); protected publicly reachable Kokoro; a gateway/UI/radio HTTPS host and DNS; canonical PackProof API and approved assertion delegation; LiveKit worker deployment and real browser speech test; eligible real signed demo event; replacement SIP provider/route/number confirmation and an actual inbound call; optional SMS provider. No changes or deployments were made to PackProof Vercel, its Supabase data, other worktrees or GitHub.

Official implementation references: [voice quickstart](https://docs.livekit.io/agents/start/voice-ai/), [Meta STT](https://docs.livekit.io/agents/models/stt/meta/), [frontend sessions](https://docs.livekit.io/frontends/build/sessions/), [Cloud deployment](https://docs.livekit.io/deploy/agents/quickstart/), [Kokoro guide](https://docs.livekit.io/agents/models/tts/kokoro/), [Meta Chat Completions](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions), [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), [Liquidsoap](https://www.liquidsoap.info/), [Icecast](https://icecast.org/), [Sonetel SIP addressing](https://sonetel.com/en/help/help-topics/telephony/free-sip-address/).

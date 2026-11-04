// Generates restricted configuration only; does not create trunks, buy numbers, or forward calls.
import { mkdirSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
const {
  SIP_NUMBER,
  SIP_PROVIDER_CIDRS,
  SIP_AUTH_USERNAME,
  SIP_AUTH_PASSWORD,
  LIVEKIT_SIP_TRUNK_ID,
} = process.env
if (!SIP_NUMBER || !/^\+[1-9]\d{7,14}$/.test(SIP_NUMBER))
  throw new Error('An existing approved E.164 number is required')
if (!SIP_PROVIDER_CIDRS?.trim())
  throw new Error('Confirmed provider ingress CIDRs are required')
if (!SIP_AUTH_USERNAME || !SIP_AUTH_PASSWORD || SIP_AUTH_PASSWORD.length < 32)
  throw new Error('Provider-compatible SIP digest credentials are required')
const addresses = SIP_PROVIDER_CIDRS.split(',').map(s => s.trim())
for (const value of addresses) {
  const [ip, prefix, ...extra] = value.split('/')
  const kind = isIP(ip ?? '')
  if (
    !kind ||
    extra.length ||
    (prefix !== undefined &&
      (!/^\d+$/.test(prefix) ||
        Number(prefix) <= 0 ||
        Number(prefix) > (kind === 4 ? 32 : 128)))
  )
    throw new Error('Restricted provider IP addresses or CIDRs required')
}
const dir = '.runtime/telephony'
mkdirSync(dir, { recursive: true })
writeFileSync(
  dir + '/inbound-trunk.json',
  JSON.stringify(
    {
      trunk: {
        name: 'PackProof restricted inbound',
        numbers: [SIP_NUMBER],
        allowedAddresses: addresses,
        authUsername: SIP_AUTH_USERNAME,
        authPassword: SIP_AUTH_PASSWORD,
      },
    },
    null,
    2,
  ),
  { mode: 0o600 },
)
if (LIVEKIT_SIP_TRUNK_ID)
  writeFileSync(
    dir + '/dispatch-rule.json',
    JSON.stringify(
      {
        dispatchRule: {
          name: 'PackProof private per-caller rooms',
          trunkIds: [LIVEKIT_SIP_TRUNK_ID],
          hidePhoneNumber: true,
          rule: { dispatchRuleIndividual: { roomPrefix: 'pp-phone-' } },
          roomConfig: { agents: [{ agentName: 'packproof-voice' }] },
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
console.log(
  LIVEKIT_SIP_TRUNK_ID
    ? 'Restricted SIP configuration written under ignored .runtime/telephony. Review provider compatibility before applying.'
    : 'Inbound configuration written. After creating the trunk, rerun with LIVEKIT_SIP_TRUNK_ID to generate its dispatch rule.',
)

import { ParticipantKind } from '@livekit/rtc-node'

export function approvedInboundCall(
  participant: {
    kind: ParticipantKind
    attributes: Readonly<Record<string, string>>
  },
  env: NodeJS.ProcessEnv,
): boolean {
  if (participant.kind !== ParticipantKind.SIP) return false
  const list = (name: string) =>
    (env[name] ?? '')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
  const trunk = participant.attributes['sip.trunkID']
  if (trunk && list('LIVEKIT_ALLOWED_SIP_TRUNKS').includes(trunk)) return true
  // LiveKit-native numbers need no customer-configured inbound trunk. Bind to
  // the service's called number AND assigned dispatch rule; never caller ID.
  const called = participant.attributes['sip.trunkPhoneNumber']
  const rule = participant.attributes['sip.ruleID']
  return (
    !!called &&
    !!rule &&
    list('LIVEKIT_ALLOWED_PHONE_NUMBERS').includes(called) &&
    list('LIVEKIT_ALLOWED_SIP_DISPATCH_RULES').includes(rule)
  )
}

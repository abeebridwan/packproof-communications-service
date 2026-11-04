import { it, expect } from 'vitest'
import { ParticipantKind } from '../apps/voice-agent/node_modules/@livekit/rtc-node/dist/index.js'
import { approvedInboundCall } from '../apps/voice-agent/src/telephony.js'
const env = {
  LIVEKIT_ALLOWED_PHONE_NUMBERS: '+14155550100',
  LIVEKIT_ALLOWED_SIP_DISPATCH_RULES: 'SDR-approved',
}
it('accepts the service-provided called LiveKit number and assigned dispatch rule', () => {
  expect(
    approvedInboundCall(
      {
        kind: ParticipantKind.SIP,
        attributes: {
          'sip.trunkPhoneNumber': '+14155550100',
          'sip.ruleID': 'SDR-approved',
        },
      },
      env,
    ),
  ).toBe(true)
})
it('never treats caller ID as native-number authorization or a web participant as SIP', () => {
  expect(
    approvedInboundCall(
      {
        kind: ParticipantKind.SIP,
        attributes: {
          'sip.phoneNumber': '+14155550100',
          'sip.ruleID': 'SDR-approved',
        },
      },
      env,
    ),
  ).toBe(false)
  expect(
    approvedInboundCall(
      {
        kind: ParticipantKind.STANDARD,
        attributes: {
          'sip.trunkPhoneNumber': '+14155550100',
          'sip.ruleID': 'SDR-approved',
        },
      },
      env,
    ),
  ).toBe(false)
})
it('rejects an unapproved called number or dispatch rule and defaults to disabled', () => {
  for (const attrs of [
    { 'sip.trunkPhoneNumber': '+14155550101', 'sip.ruleID': 'SDR-approved' },
    { 'sip.trunkPhoneNumber': '+14155550100', 'sip.ruleID': 'SDR-other' },
  ])
    expect(
      approvedInboundCall(
        { kind: ParticipantKind.SIP, attributes: attrs },
        env,
      ),
    ).toBe(false)
  expect(
    approvedInboundCall(
      {
        kind: ParticipantKind.SIP,
        attributes: {
          'sip.trunkPhoneNumber': '+14155550100',
          'sip.ruleID': 'SDR-approved',
        },
      },
      {},
    ),
  ).toBe(false)
})
it('retains explicitly approved third-party trunk routing', () => {
  expect(
    approvedInboundCall(
      {
        kind: ParticipantKind.SIP,
        attributes: { 'sip.trunkID': 'ST-approved' },
      },
      { LIVEKIT_ALLOWED_SIP_TRUNKS: 'ST-approved' },
    ),
  ).toBe(true)
})

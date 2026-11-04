import { z } from 'zod'
import { jwtVerify, SignJWT } from 'jose'

export const Identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/)
export const Operation = z.enum([
  'product',
  'packaging',
  'seller',
  'notices',
  'custody',
  'ownership',
  'verification',
  'evidence',
  'offline_pack',
])
export type Operation = z.infer<typeof Operation>
export const SourceRef = z.object({
  id: z.string().min(1).max(128),
  url: z.url().refine(v => {
    const u = new URL(v)
    return u.protocol === 'https:' && !u.username && !u.password
  }),
  recordId: z.string().max(128),
  asOf: z.iso.datetime(),
})
export const ClaimCode = z.enum([
  'signed_product_record',
  'signed_packaging_record',
  'seller_authorized',
  'seller_not_authorized',
  'applicable_notice',
  'permitted_custody_history',
  'permitted_ownership_snapshot',
  'permitted_evidence',
  'permitted_offline_metadata',
  'additional_evidence_required',
])
export const VerificationResult = z.object({
  itemId: Identifier,
  batchId: Identifier.optional(),
  sellerId: Identifier.optional(),
  operation: Operation,
  status: z.enum([
    'supported',
    'blocked',
    'needs_evidence',
    'unavailable',
    'stale',
  ]),
  visibility: z.enum(['public', 'private']),
  fixture: z.boolean(),
  asOf: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  claims: z
    .array(
      z.object({
        code: ClaimCode,
        applicability: z.object({
          scope: z.string().min(1).max(128),
          applies: z.boolean(),
        }),
        sourceIds: z.array(z.string().max(128)).min(1).max(8),
      }),
    )
    .max(12),
  custody: z
    .array(
      z.object({
        actorId: Identifier,
        capacity: z.enum([
          'manufacturer',
          'distributor',
          'retailer',
          'seller',
          'buyer',
          'custodian',
        ]),
        handledAt: z.iso.datetime(),
        sourceIds: z.array(z.string().max(128)).min(1).max(8),
      }),
    )
    .max(10)
    .optional(),
  ownership: z
    .object({
      holderId: Identifier,
      asOf: z.iso.datetime(),
      sourceIds: z.array(z.string().max(128)).min(1).max(8),
    })
    .optional(),
  offlinePack: z
    .object({
      packId: Identifier,
      issuedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      signatureRef: z.string().min(1).max(128),
      sourceIds: z.array(z.string().max(128)).min(1).max(8),
    })
    .optional(),
  sources: z.array(SourceRef).max(16),
  limitations: z.array(z.string().max(300)).max(8),
  continuationUrl: z
    .url()
    .refine(v => v.startsWith('https://'))
    .optional(),
})
export type VerificationResult = z.infer<typeof VerificationResult>
export const AccessContext = z.object({
  sessionId: z.string().uuid(),
  room: z.string().min(1).max(128),
  identity: z.string().min(1).max(128),
  subject: z.string().min(1).max(128),
  access: z.enum(['public', 'authenticated']),
  scopes: z
    .array(z.enum(['verification:public', 'verification:private']))
    .max(2),
  expiresAt: z.number().int(),
  assertion: z.string().max(12000).optional(),
})
export type AccessContext = z.infer<typeof AccessContext>
export interface ConversationContext {
  itemId?: string
  sellerId?: string
  toolCalls: number
}
export interface ToolDefinition {
  name: string
  description: string
  parameters: z.ZodObject
}
export type ToolOutcome =
  | { ok: true; result: VerificationResult; speech: string }
  | {
      ok: false
      code: 'unauthorized' | 'invalid_input' | 'unavailable' | 'limit'
      speech: string
    }
export interface ToolProvider {
  readonly name: string
  readonly tools: readonly ToolDefinition[]
  invoke(
    name: string,
    args: unknown,
    access: AccessContext,
    conversation: ConversationContext,
  ): Promise<ToolOutcome>
}
export interface VerificationClient {
  lookup(
    operation: Operation,
    input: { itemId: string; sellerId?: string },
    access: AccessContext,
  ): Promise<VerificationResult>
}
export const SAFE_UNAVAILABLE =
  'Verification is unavailable right now. Please try again in PackProof.'
export const SAFE_PRIVATE =
  'Please sign in through PackProof to request permitted private records.'
export const SAFE_LIMIT =
  'This session has reached its lookup limit. Please start a new session in PackProof.'
export function activeAccess(ctx: AccessContext): boolean {
  return ctx.expiresAt > Math.floor(Date.now() / 1000)
}
export function requireSecret(value: string | undefined, name: string): string {
  if (!value || value.length < 32)
    throw new Error(`${name} must contain at least 32 characters`)
  return value
}
export async function signContext(
  context: AccessContext,
  secret: string,
): Promise<string> {
  return new SignJWT(AccessContext.parse(context))
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('packproof-voice-gateway')
    .setAudience('packproof-voice')
    .setExpirationTime(context.expiresAt)
    .setIssuedAt()
    .sign(
      new TextEncoder().encode(requireSecret(secret, 'VOICE_CONTEXT_SECRET')),
    )
}
export async function verifyContext(
  token: string,
  secret: string,
  room: string,
): Promise<AccessContext> {
  const { payload } = await jwtVerify(
    token,
    new TextEncoder().encode(requireSecret(secret, 'VOICE_CONTEXT_SECRET')),
    {
      algorithms: ['HS256'],
      issuer: 'packproof-voice-gateway',
      audience: 'packproof-voice',
    },
  )
  const ctx = AccessContext.parse(payload)
  if (ctx.room !== room || !activeAccess(ctx))
    throw new Error('Invalid session binding')
  return ctx
}
export async function boundedJson(
  response: Response,
  maxBytes = 32768,
): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('Upstream unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new Error('Upstream payload too large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return JSON.parse(new TextDecoder().decode(result))
}
export function trustedEndpoint(value: string, allowLocal = false): URL {
  const u = new URL(value)
  if (
    u.username ||
    u.password ||
    u.hash ||
    (u.protocol !== 'https:' && !(allowLocal && u.protocol === 'http:'))
  )
    throw new Error('HTTPS endpoint required')
  return u
}
export const BroadcastCandidate = z.object({
  eventId: z.string().min(1).max(128),
  itemId: Identifier,
  noticeRecordId: z.string().min(1).max(128),
  noticeType: z.enum([
    'demo_warning',
    'demo_recall',
    'demo_packaging_change',
    'demo_product_bulletin',
  ]),
  scope: z.literal('demo_public'),
  effectiveAt: z.iso.datetime(),
  asOf: z.iso.datetime(),
  evidenceRefs: z.array(z.string().min(1).max(128)).min(1).max(12),
  policyVersion: z.literal('packproof-demo-radio-v1'),
  demo: z.literal(true),
  publicSummary: z.string().max(600),
  idempotencyKey: z.string().min(1).max(128),
})
export type BroadcastCandidate = z.infer<typeof BroadcastCandidate>
// Eligibility is an assertion from the authenticated authoritative PackProof endpoint,
// not cryptographic verification or a signing root implemented by this service.
export const BroadcastEnvelope = z.object({
  candidate: BroadcastCandidate,
  authorization: z.object({
    eligible: z.literal(true),
    signatureVerified: z.literal(true),
    publication: z.literal('demo_public'),
    expiresAt: z.iso.datetime(),
    sourceRecordId: z.string().min(1).max(128),
  }),
})
export type BroadcastEnvelope = z.infer<typeof BroadcastEnvelope>
export interface SmsAdapter {
  verifyWebhook(
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string>>,
    now: number,
  ): Promise<{ deliveryId: string; replyAddress: string; productId: string }>
  sendReply(
    deliveryId: string,
    replyAddress: string,
    text: string,
  ): Promise<void>
}

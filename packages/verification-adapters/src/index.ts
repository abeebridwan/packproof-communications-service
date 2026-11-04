import { z } from 'zod'
import {
  Identifier,
  Operation,
  VerificationResult,
  activeAccess,
  boundedJson,
  trustedEndpoint,
  SAFE_UNAVAILABLE,
  SAFE_PRIVATE,
  SAFE_LIMIT,
  type AccessContext,
  type ConversationContext,
  type ToolProvider,
  type ToolOutcome,
  type VerificationClient,
} from '@packproof/shared-contracts'

export const privateOperations = new Set<Operation>([
  'ownership',
  'custody',
  'offline_pack',
])
export const defaultPaths: Record<Operation, string> = {
  product: '/v1/products/{itemId}',
  packaging: '/v1/products/{itemId}/packaging',
  seller: '/v1/products/{itemId}/seller-authority',
  notices: '/v1/products/{itemId}/notices',
  custody: '/v1/products/{itemId}/custody',
  ownership: '/v1/products/{itemId}/ownership',
  verification: '/v1/products/{itemId}/verification',
  evidence: '/v1/products/{itemId}/evidence',
  offline_pack: '/v1/products/{itemId}/offline-pack',
}
export function permitted(operation: Operation, ctx: AccessContext): boolean {
  return (
    activeAccess(ctx) &&
    ctx.scopes.includes('verification:public') &&
    (!privateOperations.has(operation) ||
      (ctx.access === 'authenticated' &&
        !!ctx.assertion &&
        ctx.scopes.includes('verification:private')))
  )
}
export function validateResult(
  raw: unknown,
  operation: Operation,
  itemId: string,
  access: AccessContext,
  sellerId?: string,
): VerificationResult {
  const r = VerificationResult.parse(raw)
  if (
    r.itemId !== itemId ||
    r.operation !== operation ||
    (operation === 'seller' && (!sellerId || r.sellerId !== sellerId)) ||
    (r.visibility === 'private' &&
      (access.access !== 'authenticated' ||
        !access.assertion ||
        !access.scopes.includes('verification:private')))
  )
    throw new Error('Source binding or authorization mismatch')
  if (
    (r.custody || r.ownership || r.offlinePack) &&
    (access.access !== 'authenticated' ||
      !access.assertion ||
      !access.scopes.includes('verification:private'))
  )
    throw new Error('Private details require delegated access')
  const sourceIds = new Set(r.sources.map(s => s.id))
  const referenced = [
    ...r.claims,
    ...(r.custody ?? []),
    ...(r.ownership ? [r.ownership] : []),
    ...(r.offlinePack ? [r.offlinePack] : []),
  ]
  if (referenced.some(c => c.sourceIds.some(id => !sourceIds.has(id))))
    throw new Error('Missing claim evidence')
  if (
    r.status === 'supported' &&
    (!r.claims.some(c => c.applicability.applies) || r.sources.length === 0)
  )
    throw new Error('Unsupported successful result')
  const now = Date.now()
  if (
    Date.parse(r.asOf) > now + 30000 ||
    Date.parse(r.expiresAt) <= Date.parse(r.asOf) ||
    r.sources.some(s => Date.parse(s.asOf) > now + 30000)
  )
    throw new Error('Invalid source time')
  if (Date.parse(r.expiresAt) <= now) r.status = 'stale'
  return r
}
const claimPhrases: Record<
  z.infer<typeof import('@packproof/shared-contracts').ClaimCode>,
  string
> = {
  signed_product_record: 'The source supports a signed product record.',
  signed_packaging_record: 'The source supports a signed packaging record.',
  seller_authorized: 'The source supports seller authority for this request.',
  seller_not_authorized:
    'The source does not support seller authority for this request.',
  applicable_notice:
    'The source reports an applicable notice. Please review it in PackProof.',
  permitted_custody_history:
    'A permitted custody history is available in PackProof.',
  permitted_ownership_snapshot:
    'A permitted ownership snapshot is available in PackProof.',
  permitted_evidence: 'Permitted evidence references are available.',
  permitted_offline_metadata:
    'Permitted signed offline pack metadata is available in PackProof.',
  additional_evidence_required:
    'More evidence is required. Please continue with Inspector in PackProof.',
}
export function explainResult(r: VerificationResult): string {
  const prefix = r.fixture ? 'This is a fixture-only demonstration. ' : ''
  const status = {
    supported: 'The evidence supports only the recorded checks.',
    blocked: 'The verification is blocked.',
    needs_evidence:
      'More evidence is required. Please continue with Inspector in PackProof.',
    unavailable: SAFE_UNAVAILABLE,
    stale: 'The source result is stale. Please refresh the check in PackProof.',
  }[r.status]
  const facts =
    r.status === 'supported'
      ? r.claims
          .filter(c => c.applicability.applies)
          .slice(0, 2)
          .map(c => claimPhrases[c.code])
          .join(' ')
      : ''
  const details =
    r.status !== 'supported'
      ? ''
      : r.operation === 'custody' && r.custody?.length
        ? 'Permitted handlers include ' +
          r.custody
            .slice(0, 2)
            .map(c => c.capacity + ' ' + c.actorId)
            .join(' and ') +
          '.'
        : r.operation === 'ownership' && r.ownership
          ? 'The permitted holder reference is ' + r.ownership.holderId + '.'
          : ''
  return [
    prefix + status,
    facts,
    details,
    'This does not guarantee that the physical item is genuine.',
  ]
    .filter(Boolean)
    .join(' ')
}
export class HttpVerificationClient implements VerificationClient {
  readonly base: URL
  constructor(
    private options: {
      baseUrl: string
      serviceToken: string
      paths?: Partial<Record<Operation, string>>
      fetch?: typeof fetch
      allowLocal?: boolean
    },
  ) {
    this.base = trustedEndpoint(options.baseUrl, options.allowLocal)
    if (!options.serviceToken) throw new Error('PACKPROOF_API_TOKEN required')
  }
  async lookup(
    operation: Operation,
    input: { itemId: string; sellerId?: string },
    access: AccessContext,
  ): Promise<VerificationResult> {
    if (!permitted(operation, access)) throw new Error('Unauthorized')
    Identifier.parse(input.itemId)
    if (input.sellerId) Identifier.parse(input.sellerId)
    const path = this.options.paths?.[operation] ?? defaultPaths[operation]
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      !path.includes('{itemId}')
    )
      throw new Error('Invalid API path')
    const url = new URL(
      path.replace('{itemId}', encodeURIComponent(input.itemId)),
      this.base,
    )
    if (url.origin !== this.base.origin) throw new Error('Invalid API origin')
    if (input.sellerId) url.searchParams.set('sellerId', input.sellerId)
    const response = await (this.options.fetch ?? fetch)(url, {
      headers: {
        Authorization: `Bearer ${this.options.serviceToken}`,
        ...(access.assertion
          ? { 'X-PackProof-Assertion': access.assertion }
          : {}),
      },
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    })
    return validateResult(
      await boundedJson(response),
      operation,
      input.itemId,
      access,
      input.sellerId,
    )
  }
}
export class FixtureVerificationClient implements VerificationClient {
  async lookup(
    operation: Operation,
    input: { itemId: string; sellerId?: string },
    access: AccessContext,
  ): Promise<VerificationResult> {
    if (!permitted(operation, access)) throw new Error('Unauthorized')
    const now = new Date().toISOString()
    const known = input.itemId === '0071842'
    const code = {
      product: 'signed_product_record',
      packaging: 'signed_packaging_record',
      seller: 'seller_authorized',
      notices: 'applicable_notice',
      custody: 'permitted_custody_history',
      ownership: 'permitted_ownership_snapshot',
      verification: 'signed_product_record',
      evidence: 'permitted_evidence',
      offline_pack: 'permitted_offline_metadata',
    }[operation]
    const supported =
      known && (operation !== 'seller' || input.sellerId === 'SELLER-01')
    return validateResult(
      {
        itemId: input.itemId,
        ...(operation === 'seller' ? { sellerId: input.sellerId } : {}),
        ...(operation === 'custody' && supported
          ? {
              custody: [
                {
                  actorId: 'DEMO-PRODUCER',
                  capacity: 'manufacturer',
                  handledAt: now,
                  sourceIds: ['sample-record'],
                },
                {
                  actorId: 'DEMO-RETAILER',
                  capacity: 'retailer',
                  handledAt: now,
                  sourceIds: ['sample-record'],
                },
              ],
            }
          : {}),
        ...(operation === 'ownership' && supported
          ? {
              ownership: {
                holderId: 'DEMO-HOLDER',
                asOf: now,
                sourceIds: ['sample-record'],
              },
            }
          : {}),
        ...(operation === 'offline_pack' && supported
          ? {
              offlinePack: {
                packId: 'DEMO-PACK',
                issuedAt: now,
                expiresAt: new Date(Date.now() + 600000).toISOString(),
                signatureRef: 'sample-signature-ref',
                sourceIds: ['sample-record'],
              },
            }
          : {}),
        operation,
        status: supported ? 'supported' : 'needs_evidence',
        fixture: true,
        visibility: privateOperations.has(operation) ? 'private' : 'public',
        asOf: now,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        claims: supported
          ? [
              {
                code,
                applicability: { scope: 'product', applies: true },
                sourceIds: ['sample-record'],
              },
            ]
          : [],
        sources: supported
          ? [
              {
                id: 'sample-record',
                recordId: 'sample-0071842',
                asOf: now,
                url: 'https://packproof-p0.vercel.app/review',
              },
            ]
          : [],
        limitations: [
          'Fixture only; no real signed records have been checked.',
        ],
        continuationUrl: 'https://packproof-p0.vercel.app/review',
      },
      operation,
      input.itemId,
      access,
      input.sellerId,
    )
  }
}
const lookupArgs = z
  .object({
    operation: Operation,
    itemId: Identifier.optional(),
    sellerId: Identifier.optional(),
  })
  .strict()
export class PackProofVerificationProvider implements ToolProvider {
  readonly name = 'packproof'
  readonly tools = [
    {
      name: 'packproof_lookup',
      description:
        'Retrieve authorized PackProof evidence for a confirmed product identifier. Choose the specific operation requested. Seller authority requires the seller identifier; never infer it from a user account role. Private custody, ownership and offline metadata require authenticated access. Only read operations are supported.',
      parameters: lookupArgs,
    },
  ]
  constructor(
    private client: VerificationClient,
    private maxToolCalls = 12,
  ) {}
  async invoke(
    name: string,
    args: unknown,
    access: AccessContext,
    conversation: ConversationContext,
  ): Promise<ToolOutcome> {
    if (!activeAccess(access))
      return { ok: false, code: 'unauthorized', speech: SAFE_PRIVATE }
    if (conversation.toolCalls++ >= this.maxToolCalls)
      return { ok: false, code: 'limit', speech: SAFE_LIMIT }
    const parsed = lookupArgs.safeParse(args)
    if (name !== 'packproof_lookup' || !parsed.success)
      return {
        ok: false,
        code: 'invalid_input',
        speech: 'Please tell me the exact product identifier.',
      }
    const { operation, sellerId } = parsed.data
    const itemId = parsed.data.itemId ?? conversation.itemId
    if (!itemId || itemId !== conversation.itemId)
      return {
        ok: false,
        code: 'invalid_input',
        speech: 'Please confirm the product identifier before I check it.',
      }
    if (!permitted(operation, access))
      return { ok: false, code: 'unauthorized', speech: SAFE_PRIVATE }
    if (operation === 'seller' && !sellerId)
      return {
        ok: false,
        code: 'invalid_input',
        speech: 'Please tell me the seller identifier for this product.',
      }
    try {
      const result = await this.client.lookup(
        operation,
        { itemId, sellerId },
        access,
      )
      if (sellerId) conversation.sellerId = sellerId
      return { ok: true, result, speech: explainResult(result) }
    } catch {
      return { ok: false, code: 'unavailable', speech: SAFE_UNAVAILABLE }
    }
  }
}
export function clientFromEnv(env: NodeJS.ProcessEnv): VerificationClient {
  if (env.PACKPROOF_MODE === 'fixtures') return new FixtureVerificationClient()
  if (
    env.PACKPROOF_MODE !== 'http' ||
    !env.PACKPROOF_API_BASE_URL ||
    !env.PACKPROOF_API_TOKEN
  )
    throw new Error(
      'Configure PACKPROOF_MODE=http and API credentials, or explicitly select fixtures',
    )
  const paths = env.PACKPROOF_ENDPOINT_PATHS
    ? z
        .record(Operation, z.string())
        .parse(JSON.parse(env.PACKPROOF_ENDPOINT_PATHS))
    : undefined
  return new HttpVerificationClient({
    baseUrl: env.PACKPROOF_API_BASE_URL,
    serviceToken: env.PACKPROOF_API_TOKEN,
    paths,
  })
}

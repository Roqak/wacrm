// ============================================================
// OpenAPI 3.1 document for the public API.
//
// Single source of truth served at `GET /api/v1/openapi.json` (no
// auth — a spec is a contract, and gating it saves nobody anything).
// Built from the same constants the routes use so it can't drift:
// scopes come from `API_SCOPES`/`SCOPE_DESCRIPTIONS`, webhook event
// names from `WEBHOOK_EVENTS`, rate-limit headers from `respond.ts`.
//
// The prose contract remains `docs/public-api.md`; this file is the
// machine-readable mirror of it — when they disagree, fix both.
// ============================================================

import { API_SCOPES, SCOPE_DESCRIPTIONS, type ApiScope } from '@/lib/api-keys/scopes';
import { WEBHOOK_EVENTS } from '@/lib/webhooks/events';

type JsonObject = { [k: string]: unknown };

/** An OpenAPI schema object loose enough to build fluently. */
type SchemaObject = { properties?: Record<string, unknown>; [k: string]: unknown };

const jsonSchema = (s: SchemaObject): SchemaObject => ({ type: 'object', ...s }) as SchemaObject;

/** All error responses reference the one shared Error schema. */
const ERROR_SCHEMA_REF = { $ref: '#/components/schemas/Error' };

const envelope = (data: JsonObject, description: string) =>
  ({
    type: 'object',
    description,
    required: ['data'],
    properties: { data },
  }) as JsonObject;

const listEnvelope = (items: JsonObject) =>
  ({
    type: 'object',
    required: ['data', 'meta'],
    properties: {
      data: { type: 'array', items },
      meta: {
        type: 'object',
        properties: { next_cursor: { type: ['string', 'null'] as string[] } },
      },
    },
  }) as JsonObject;

const errorSchema = jsonSchema({
  description: "Failure envelope — `{ error: { code, message } }`.",
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          enum: [
            'unauthorized',
            'forbidden',
            'rate_limited',
            'bad_request',
            'not_found',
            'internal',
          ],
          description:
            'Machine-matchable code. `rate_limited` carries `Retry-After` and `X-RateLimit-*` headers.',
        },
        message: {
          type: 'string',
          description: 'Human-facing; may be reworded — branch on `code`.',
        },
      },
    },
  },
});

const rateLimitHeaders = () => ({
  'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait before retrying.' },
  'X-RateLimit-Limit': { schema: { type: 'integer' } },
  'X-RateLimit-Remaining': { schema: { type: 'integer' } },
  'X-RateLimit-Reset': { schema: { type: 'integer' }, description: 'Unix millis when the window resets.' },
});

const paginatedResponses = (items: JsonObject) => ({
  '200': { description: 'One page, newest first.', content: { 'application/json': { schema: listEnvelope(items) } } },
  '400': { description: 'Malformed cursor or filter.', content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
  '429': { description: 'Per-key budget exhausted.', headers: rateLimitHeaders(), content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
});

const scoped = (...scopes: ApiScope[]) => ({
  security: [{ bearerAuth: [] }],
  'x-wacrm-scopes': scopes,
  description: `Scope${scopes.length > 1 ? 's' : ''}: ${scopes.map((s) => `\`${s}\``).join(', ')}. ${scopes.map((s) => `${s} = ${SCOPE_DESCRIPTIONS[s]}`).join(' ')}`,
});

const notFound = { description: 'Foreign or missing id.', content: { 'application/json': { schema: ERROR_SCHEMA_REF } } };

// ------------------------------------------------------------
// Component schemas — projected from the shared serializers
// (src/lib/api/v1/*, src/lib/webhooks/endpoints.ts), which are the
// wire. Add a public column here AND to the serializer.
// ------------------------------------------------------------

const tagSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, name: { type: 'string' }, color: { type: 'string' } },
} as JsonObject;

const contactSchema = jsonSchema({
  description: 'One contact (from `serializeContact`).',
  properties: {
    id: { type: 'string' },
    phone: { type: 'string', description: 'E.164.' },
    name: { type: ['string', 'null'] as string[] },
    email: { type: ['string', 'null'] as string[] },
    company: { type: ['string', 'null'] as string[] },
    avatar_url: { type: ['string', 'null'] as string[] },
    tags: { type: 'array', items: tagSchema },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
});

const conversationSchema = jsonSchema({
  description: 'One conversation (from `serializeConversation`).',
  properties: {
    id: { type: 'string' },
    contact_id: { type: 'string' },
    status: { type: 'string', enum: ['open', 'pending', 'closed'] },
    assigned_agent_id: { type: ['string', 'null'] as string[] },
    last_message_text: { type: ['string', 'null'] as string[] },
    last_message_at: { type: ['string', 'null'] as string[], format: 'date-time' },
    unread_count: { type: 'integer' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    contact: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            id: { type: 'string' },
            phone: { type: 'string' },
            name: { type: ['string', 'null'] as string[] },
            email: { type: ['string', 'null'] as string[] },
            company: { type: ['string', 'null'] as string[] },
            tags: { type: 'array', items: tagSchema },
          },
        },
      ],
    },
  },
});

const messageSchema = jsonSchema({
  description: 'One message (from `serializeMessage`); `whatsapp_message_id` is Meta\u2019s id.',
  properties: {
    id: { type: 'string' },
    conversation_id: { type: 'string' },
    direction: { type: 'string', enum: ['inbound', 'outbound'] },
    sender_type: { type: 'string' },
    content_type: { type: 'string', description: 'text | image | video | document | audio | sticker | location | reaction | interactive | template' },
    content_text: { type: ['string', 'null'] as string[] },
    media_url: { type: ['string', 'null'] as string[] },
    template_name: { type: ['string', 'null'] as string[] },
    whatsapp_message_id: { type: ['string', 'null'] as string[] },
    status: { type: 'string', description: 'Delivery ladder: pending → sent → delivered → read / replied; `failed` is a side branch.' },
    reply_to_message_id: { type: ['string', 'null'] as string[] },
    interactive_reply_id: { type: ['string', 'null'] as string[] },
    created_at: { type: 'string', format: 'date-time' },
  },
});

const templateSchema = jsonSchema({
  description: 'One message template (from `serializeTemplate`). Meta review is asynchronous: `PENDING` until reviewed; body changes re-trigger review.',
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION'] },
    name: { type: 'string' },
    category: { type: 'string', enum: ['Marketing', 'Utility', 'Authentication'] },
    language: { type: 'string', description: 'Meta language code, e.g. `en_US`.' },
    header_type: { type: ['string', 'null'] as string[], enum: [null, 'none', 'text', 'image', 'video', 'document'] },
    header_content: { type: ['string', 'null'] as string[], description: 'Header text when `header_type=text`.' },
    header_media_url: { type: ['string', 'null'] as string[], description: 'Source URL for media headers; converted to a resumable-upload handle at submit time.' },
    body_text: { type: 'string', description: '`{{1}}`-style positional variables.' },
    footer_text: { type: ['string', 'null'] as string[] },
    buttons: { description: 'URL / PHONE_NUMBER / QUICK_REPLY / COPY_CODE button definitions.', type: ['array', 'null'] as string[] },
    sample_values: { description: 'Review samples for the variables: `{ body: [...], header: [...] }`.', type: ['object', 'null'] as string[] },
    meta_template_id: { type: ['string', 'null'] as string[], description: 'Meta’s id once submitted; null while DRAFT.' },
    submission_error: { type: ['string', 'null'] as string[] },
    rejection_reason: { type: ['string', 'null'] as string[] },
    last_submitted_at: { type: ['string', 'null'] as string[] },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
});

const webhookEndpointSchema = jsonSchema({
  description: 'One outbound webhook endpoint. The `secret` (whsec_…) is returned exactly once, at creation.',
  properties: {
    id: { type: 'string' },
    url: { type: 'string', format: 'uri', description: 'https://, public address — SSRF-guarded.' },
    events: { type: 'array', items: { type: 'string', enum: [...WEBHOOK_EVENTS] } },
    is_active: { type: 'boolean' },
    last_delivery_at: { type: ['string', 'null'] as string[] },
    failure_count: { type: 'integer', description: 'Consecutive delivery failures; an auto-disabled endpoint (past the threshold) is re-enabled via PATCH.' },
    created_at: { type: 'string', format: 'date-time' },
  },
});

// ------------------------------------------------------------
// Request bodies
// ------------------------------------------------------------

const sendMessageSchema = jsonSchema({
  description:
    'Send to a phone (E.164) — contact + conversation are resolved-or-created. ' +
    '`text` is the body (also the media caption); media types need `media_url`; ' +
    '`type=template` needs `template` `{ name, language, params }` where params is a ' +
    'positional body array or a structured `{ body: [...] }` object.',
  required: ['to'],
  properties: {
    to: { type: 'string', description: 'E.164, e.g. +14155550123.' },
    type: { type: 'string', enum: ['text', 'template', 'image', 'video', 'document', 'audio'], default: 'text' },
    text: { type: 'string', description: 'Body text, or caption for media types. Required for `text`.' },
    media_url: { type: 'string', description: 'Required for image/video/document/audio.' },
    filename: { type: 'string', description: 'Optional document filename.' },
    template: {
      type: 'object',
      description: 'Required when type=template.',
      properties: {
        name: { type: 'string' },
        language: { type: 'string' },
        params: {
          description: 'Positional body params as an array, or structured `{ body: [...] }`.',
          oneOf: [
            { type: 'array', items: {} },
            { type: 'object', properties: { body: { type: 'array', items: {} } } },
          ],
        },
      },
      required: ['name', 'language'],
    },
    reply_to_message_id: { type: 'string', description: 'Optional; must belong to the same conversation.' },
    name: { type: 'string', description: 'Names a newly-created contact.' },
  },
});

const broadcastSchema = jsonSchema({
  description:
    'Launch a template broadcast. Fan-out begins after the response; poll the broadcast id.',
  required: ['template_name', 'recipients'],
  properties: {
    name: { type: 'string', description: 'Optional label.' },
    template_name: { type: 'string', description: 'An APPROVED template.' },
    template_language: { type: 'string', default: 'en_US' },
    recipients: {
      type: 'array',
      minItems: 1,
      maxItems: 1000,
      items: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'E.164.' },
          params: { type: 'array', items: { type: 'string' }, description: 'Positional template params for this recipient.' },
        },
        required: ['to'],
      },
    },
  },
});

const contactWriteSchema = jsonSchema({
  description: '`phone` is the identity (find-or-create by phone, so POST is idempotent). `tags` replaces the tag set with tag NAMES.',
  properties: {
    phone: { type: 'string' },
    name: { type: ['string', 'null'] as string[] },
    email: { type: ['string', 'null'] as string[] },
    company: { type: ['string', 'null'] as string[] },
    tags: { type: 'array', items: { type: 'string' }, description: 'Tag names — existing names are reused, otherwise created.' },
  },
  required: ['phone'],
});

const webhookCreateSchema = jsonSchema({
  required: ['url', 'events'],
  properties: {
    url: { type: 'string', description: 'https:// and publicly reachable.' },
    events: { type: 'array', minItems: 1, items: { type: 'string', enum: [...WEBHOOK_EVENTS] } },
  },
});

const templateSubmitSchema = jsonSchema({
  description:
    'Create + submit for Meta approval. AUTHENTICATION category is refused (create it in Meta WhatsApp Manager and sync instead). Media headers must be reachable from the server (converted to a resumable-upload handle before submission).',
  properties: {
    name: { type: 'string', description: 'lowercase letters, digits, underscores.' },
    category: { type: 'string', enum: ['Marketing', 'Utility'] },
    language: { type: 'string' },
    header_type: { type: 'string', enum: ['none', 'text', 'image', 'video', 'document'] },
    header_content: { type: 'string' },
    header_media_url: { type: 'string' },
    body_text: { type: 'string' },
    footer_text: { type: 'string' },
    buttons: { type: 'array', maxItems: 10, description: 'QUICK_REPLY buttons must come before URL / phone / copy-code buttons.' },
    sample_values: { type: 'object' },
  },
  required: ['name', 'category', 'language', 'body_text'],
});

const idParam = () => ({
  id: {
    schema: { type: 'string' },
    required: true,
    description: 'A uuid — a foreign id is a 404, never a 403.',
  },
});

const jsonBody = (schema: JsonObject, required = true) => ({
  required,
  content: { 'application/json': { schema } },
});

export function buildOpenApiDocument(): JsonObject {
  return {
    openapi: '3.1.0',
    info: {
      title: 'wacrm Public API',
      version: '1.0.0',
      summary: 'WhatsApp-first CRM REST API — send, read, sync, broadcast, and hook in, scoped by API key and account.',
      description:
        'One envelope everywhere: `{"data": …}` on success, `{"error": {"code", "message"}}` on failure. ' +
        'Authorization is scope-based (`Authorization: Bearer wacrm_live_…`); every query is scoped to the key\u2019s account — a foreign id reads as a 404. ' +
        'Lists are keyset-paginated: follow `meta.next_cursor`. Rate limits are per key; a miss returns 429 with `Retry-After` and `X-RateLimit-*` headers. ' +
        'The prose contract is `docs/public-api.md` — when it and this document disagree, one of them is a bug.\n\n' +
        'Scopes: ' + API_SCOPES.map((s) => `\`${s}\` (${SCOPE_DESCRIPTIONS[s]})`).join(', ') + '.',
    },
    paths: {
      '/api/v1/me': {
        get: {
          ...scoped(),
          summary: 'Key identity — key id, granted scopes, account id/name',
          'x-wacrm-scopes-any': true,
          responses: {
            '200': {
              description: 'Works even with zero scopes — a key liveness check.',
              content: {
                'application/json': {
                  schema: envelope(
                    jsonSchema({
                      properties: {
                        account: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
                        key: { type: 'object', properties: { id: { type: 'string' }, scopes: { type: 'array', items: { type: 'string', enum: [...API_SCOPES] } } } },
                      },
                    }),
                    'Key + account identity.',
                  ),
                },
              },
            },
          } as JsonObject,
        },
      },
      '/api/v1/messages': {
        post: {
          summary: 'Send a WhatsApp message',
          ...scoped('messages:send'),
          requestBody: { ...jsonBody(sendMessageSchema) },
          responses: {
            '201': {
              description: 'Accepted by the pipeline.',
              content: {
                'application/json': {
                  schema: envelope(
                    jsonSchema({
                      properties: {
                        message_id: { type: 'string', description: 'The stored row id (for `reply_to_message_id`).' },
                        whatsapp_message_id: { type: 'string', description: 'Meta’s id.' },
                        conversation_id: { type: 'string' },
                        contact_id: { type: 'string' },
                        contact_created: { type: 'boolean' },
                      },
                    }),
                    'The send.',
                  ),
                },
              },
            },
            '400': { description: 'Validation failed (bad phone, missing text, unknown template…).', content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
            '429': { description: 'Per-key budget exhausted.', headers: rateLimitHeaders(), content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
          } as JsonObject,
        },
      },
      '/api/v1/conversations': {
        get: {
          summary: 'List conversations',
          ...scoped('conversations:read'),
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'pending', 'closed'] } },
            { name: 'contact_id', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, max: 100 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' }, description: '`meta.next_cursor` from the previous page.' },
          ],
          responses: paginatedResponses(conversationSchema) as JsonObject,
        },
      },
      '/api/v1/conversations/{id}/messages': {
        get: {
          summary: 'Read a conversation’s thread',
          ...scoped('conversations:read'),
          parameters: [idParam(), { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, max: 100 } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }],
          responses: paginatedResponses(messageSchema) as JsonObject,
        },
      },
      '/api/v1/conversations/{id}': {
        get: {
          summary: 'Read one conversation',
          ...scoped('conversations:read'),
          parameters: [idParam()],
          responses: {
            '200': { description: 'The conversation.', content: { 'application/json': { schema: envelope(conversationSchema, 'One conversation.') } } },
            '404': notFound,
            '429': { description: 'Per-key budget exhausted.', headers: rateLimitHeaders(), content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
          } as JsonObject,
        },
      },
      '/api/v1/contacts': {
        get: {
          summary: 'List contacts',
          ...scoped('contacts:read'),
          parameters: [
            { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Matches name or phone.' },
            { name: 'tag', in: 'query', schema: { type: 'string' }, description: 'A tag id; only contacts holding it.' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, max: 100 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: paginatedResponses(contactSchema) as JsonObject,
        },
        post: {
          summary: 'Create (or match) a contact',
          ...scoped('contacts:write'),
          requestBody: { ...jsonBody(contactWriteSchema) },
          responses: {
            '201': { description: 'New contact.', content: { 'application/json': { schema: envelope(contactSchema, 'Contacts.') } } },
            '200': { description: 'Existing contact matched by phone.', content: { 'application/json': { schema: envelope(contactSchema, 'Contacts.') } } },
            '400': { description: 'Validation failed.', content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
            '429': { description: 'Per-key budget exhausted.', headers: rateLimitHeaders(), content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
          } as JsonObject,
        },
      },
      '/api/v1/contacts/{id}': {
        get: {
          summary: 'Read one contact',
          ...scoped('contacts:read'),
          parameters: [idParam()],
          responses: {
            '200': { description: 'The contact.', content: { 'application/json': { schema: envelope(contactSchema, 'Contacts.') } } },
            '404': notFound,
          } as JsonObject,
        },
        patch: {
          summary: 'Update a contact',
          ...scoped('contacts:write'),
          parameters: [idParam()],
          requestBody: { ...jsonBody(contactWriteSchema, false) },
          responses: {
            '200': { description: 'Updated (fields present in the body; `tags` replaces the set).', content: { 'application/json': { schema: envelope(contactSchema, 'Contacts.') } } },
            '404': notFound,
            '429': { description: 'Per-key budget exhausted.', headers: rateLimitHeaders(), content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
          } as JsonObject,
        },
      },
      '/api/v1/broadcasts': {
        post: {
          summary: 'Launch a template broadcast',
          ...scoped('broadcasts:send'),
          requestBody: { ...jsonBody(broadcastSchema) },
          responses: {
            '202': {
              description: 'Accepted — fan-out runs after the response. `rejected` counts recipients we refused (bad phone, disconnected WhatsApp, over cap).',
              content: {
                'application/json': {
                  schema: envelope(
                    jsonSchema({
                      properties: {
                        broadcast_id: { type: 'string' },
                        status: { type: 'string', description: '`sending` — moves to `sent` as fan-out completes.' },
                        total_recipients: { type: 'integer' },
                        accepted: { type: 'integer' },
                        rejected: { type: 'integer' },
                      },
                    }),
                    'Broadcast accepted.',
                  ),
                },
              },
            },
            '400': { description: 'Validation failed.', content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
            '429': { description: 'Per-key budget exhausted.', headers: rateLimitHeaders(), content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
          } as JsonObject,
        },
      },
      '/api/v1/broadcasts/{id}': {
        get: {
          summary: 'Broadcast status + counts',
          ...scoped('broadcasts:send'),
          parameters: [idParam()],
          responses: {
            '200': {
              description: 'Poll until `status` is `sent`; delivered/read counts keep climbing as Meta webhooks arrive.',
              content: {
                'application/json': {
                  schema: envelope(
                    jsonSchema({
                      properties: {
                        id: { type: 'string' },
                        name: { type: ['string', 'null'] as string[] },
                        status: { type: 'string', enum: ['sending', 'sent'] },
                        total_recipients: { type: 'integer' },
                        delivered_count: { type: 'integer' },
                        read_count: { type: 'integer' },
                        created_at: { type: 'string', format: 'date-time' },
                      },
                    }),
                    'Broadcast progress.',
                  ),
                },
              },
            },
            '404': notFound,
          } as JsonObject,
        },
      },
      '/api/v1/webhooks': {
        get: {
          summary: 'List outbound webhook endpoints',
          ...scoped('webhooks:manage'),
          responses: {
            '200': { description: 'The whole roster (small, settings-class — no pagination).', content: { 'application/json': { schema: listEnvelope(webhookEndpointSchema) } } },
          } as JsonObject,
        },
        post: {
          summary: 'Register an endpoint',
          ...scoped('webhooks:manage'),
          requestBody: { ...jsonBody(webhookCreateSchema) },
          responses: {
            '201': {
              description: 'Created. **Includes `secret` exactly once — store it**; verify deliveries with `X-Wacrm-Signature: t=<unix>,v1=HMAC-SHA256(secret, "`${t}.${rawBody}`")`.',
              content: {
                'application/json': {
                  schema: envelope(
                    jsonSchema({
                      properties: { ...webhookEndpointSchema.properties, secret: { type: 'string' } },
                    }),
                    'Endpoint + one-time secret.',
                  ),
                },
              },
            },
            '400': { description: 'Validation failed.', content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
          } as JsonObject,
        },
      },
      '/api/v1/webhooks/{id}': {
        get: {
          summary: 'Read one endpoint',
          ...scoped('webhooks:manage'),
          parameters: [idParam()],
          responses: {
            '200': { description: 'The endpoint (never includes the secret).', content: { 'application/json': { schema: envelope(webhookEndpointSchema, 'Endpoints.') } } },
            '404': notFound,
          } as JsonObject,
        },
        patch: {
          summary: 'Update an endpoint',
          ...scoped('webhooks:manage'),
          parameters: [idParam()],
          requestBody: {
            ...jsonBody(
              jsonSchema({
                properties: {
                  url: { type: 'string' },
                  events: { type: 'array', minItems: 1, items: { type: 'string', enum: [...WEBHOOK_EVENTS] } },
                  is_active: { type: 'boolean', description: 'Re-enabling clears the failure counter.' },
                },
              }),
              false
            ),
          },
          responses: {
            '200': { description: 'Updated.', content: { 'application/json': { schema: envelope(webhookEndpointSchema, 'Endpoints.') } } },
            '404': notFound,
          } as JsonObject,
        },
        delete: {
          summary: 'Remove an endpoint',
          ...scoped('webhooks:manage'),
          parameters: [idParam()],
          responses: {
            '200': { description: 'Removed; deliveries stop.', content: { 'application/json': { schema: envelope(jsonSchema({ properties: { id: { type: 'string' }, deleted: { type: 'boolean' } } }), 'Removed.') } } },
            '404': notFound,
          } as JsonObject,
        },
      },
      '/api/v1/templates': {
        get: {
          summary: 'List templates',
          ...scoped('templates:manage'),
          parameters: [
            { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Matches the name.' },
            { name: 'status', in: 'query', schema: { type: 'string', description: 'One of Meta\u2019s status words, e.g. APPROVED.' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, max: 100 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: paginatedResponses(templateSchema) as JsonObject,
        },
        post: {
          summary: 'Create + submit for approval',
          ...scoped('templates:manage'),
          requestBody: { ...jsonBody(templateSubmitSchema) },
          responses: {
            '201': { description: 'Stored; `status: PENDING` (or DRAFT under dry-run).', content: { 'application/json': { schema: envelope(jsonSchema({ properties: { ...templateSchema.properties, dry_run: { type: 'boolean' } } }), 'The template as stored.') } } },
            '400': { description: 'Validation failed (bad name, non-contiguous variables, missing samples, AUTHENTICATION category…).', content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
            '429': { description: 'Meta’s 100-creates-per-hour cap, or the per-key budget.', headers: rateLimitHeaders(), content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
            '502': { description: 'Meta rejected the submission — the row is kept as DRAFT with the reason; fix and re-POST.', content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
          } as JsonObject,
        },
      },
      '/api/v1/templates/{id}': {
        get: {
          summary: 'Read one template',
          ...scoped('templates:manage'),
          parameters: [idParam()],
          responses: {
            '200': { description: 'The template.', content: { 'application/json': { schema: envelope(templateSchema, 'Templates.') } } },
            '404': notFound,
          } as JsonObject,
        },
        patch: {
          summary: 'Edit + re-submit (approved / rejected / paused only)',
          ...scoped('templates:manage'),
          parameters: [idParam()],
          requestBody: { ...jsonBody(templateSubmitSchema) },
          responses: {
            '200': { description: 'Re-submitted; status back to `PENDING`.', content: { 'application/json': { schema: envelope(jsonSchema({ properties: { ...templateSchema.properties, dry_run: { type: 'boolean' } } }), 'The template as stored.') } } },
            '400': { description: 'Not editable in this status (or invalid body).', content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
            '404': notFound,
            '502': { description: 'Meta rejected the edit.', content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
          } as JsonObject,
        },
        delete: {
          summary: 'Delete on Meta + locally',
          ...scoped('templates:manage'),
          parameters: [idParam()],
          responses: {
            '200': { description: 'Removed both sides (local-only rows skip the Meta call).', content: { 'application/json': { schema: envelope(jsonSchema({ properties: { deleted: { type: 'boolean' }, dry_run: { type: 'boolean' } } }), 'Deleted.') } } },
            '404': notFound,
            '502': { description: 'Meta refused the delete.', content: { 'application/json': { schema: ERROR_SCHEMA_REF } } },
          } as JsonObject,
        },
      },
    } as JsonObject,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'API key `Authorization: Bearer wacrm_live_…` — mint one in Settings → API keys (admin+), grant scopes, and note it is locked to the account it was minted in. This is NOT a JWT.',
        },
      },
      schemas: {
        Error: errorSchema,
        Contact: contactSchema,
        Conversation: conversationSchema,
        Message: messageSchema,
        Template: templateSchema,
        WebhookEndpoint: webhookEndpointSchema,
      },
    },
  } as JsonObject;
}
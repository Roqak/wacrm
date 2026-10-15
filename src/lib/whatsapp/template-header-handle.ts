import {
  resolveMetaAppId,
  uploadResumableMedia,
} from '@/lib/whatsapp/meta-api'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with a media HEADER (image, video or
 * document) — a plain public URL is not accepted at creation time.
 * This helper turns the template's `header_media_url` (whether the user
 * uploaded a file or pasted a link) into a handle and writes it onto
 * the payload, so the submit/edit flow succeeds whatever the caller
 * stored in Settings.
 *
 * The Resumable Upload session is opened on the app that owns the
 * access token: `resolveMetaAppId` reads it straight from the token,
 * with `META_APP_ID` as a fallback for deployments where Graph can't
 * answer. A single deployment-wide app id is not enough here anyway —
 * multi-account setups can carry tokens from different Meta apps (the
 * same split migration 048 handles for webhook signatures), and Meta
 * rejects an upload session keyed on an app the token doesn't belong
 * to.
 */

interface MediaSpec {
  /** Content types accepted for this header format (case-insensitive). */
  allowedTypes: string[]
  /** Human list used in the "wrong type" error. */
  acceptedLabel: string
  /**
   * Pre-upload guardrail so the caller gets a readable error instead of
   * an opaque Meta 4xx. Meta re-validates the sample when the template
   * is submitted; these constants mirror Meta's template-sample limits
   * (image 5 MB; video/document generous ceilings — Meta rejects the
   * template itself if the sample is genuinely too big).
   */
  maxBytes: number
  /** Filename used for the upload session when the content type is absent. */
  defaultType: string
}

const MEDIA_SPECS: Record<
  Exclude<NonNullable<TemplatePayload['header_type']>, 'text'>,
  MediaSpec
> = {
  image: {
    allowedTypes: ['image/jpeg', 'image/png'],
    acceptedLabel: 'JPEG or PNG',
    maxBytes: 5 * 1024 * 1024,
    defaultType: 'image/jpeg',
  },
  video: {
    allowedTypes: ['video/mp4', 'video/3gpp'],
    acceptedLabel: 'MP4 or 3GP',
    maxBytes: 25 * 1024 * 1024,
    defaultType: 'video/mp4',
  },
  document: {
    allowedTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
    ],
    acceptedLabel: 'PDF, DOC(X), XLS(X), PPT(X) or TXT',
    maxBytes: 100 * 1024 * 1024,
    defaultType: 'application/pdf',
  },
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
  'text/plain': 'txt',
}

export async function ensureMediaHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
): Promise<void> {
  const headerType = payload.header_type
  if (!headerType || headerType === 'text') return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const spec = MEDIA_SPECS[headerType]

  // The upload session is keyed on the app the token belongs to. The
  // token's own app is always right; META_APP_ID only saves the edge
  // case where Graph won't name it.
  const fromToken = await resolveMetaAppId(accessToken)
  const appId = fromToken || process.env.META_APP_ID?.trim() || null
  if (!appId) {
    throw new Error(
      'Could not determine which Meta App owns this WhatsApp token — ' +
        'reading it from Graph failed and META_APP_ID is not set. Set ' +
        'META_APP_ID, or check that the access token in Settings → ' +
        'WhatsApp is still valid.',
    )
  }

  // SSRF guard: `header_media_url` is caller-supplied (any authenticated
  // member can submit a template) and the fetch below happens server-side,
  // so refuse any destination that resolves to a private / loopback /
  // link-local / reserved address. Same guard, same message as the two
  // other outbound-fetch call sites (see lib/webhooks/ssrf.ts) — matching
  // the unreachable-host message keeps the failure from being an oracle.
  if (!(await isDeliverableUrl(payload.header_media_url))) {
    throw new Error('Could not fetch the header media URL. Make sure it is publicly reachable.')
  }

  // Fetch the sample media bytes (works for our uploaded chat-media URL
  // and for a manually-pasted public link).
  let res: Response
  try {
    res = await fetch(payload.header_media_url, {
      // Do NOT follow redirects — a public URL could 3xx-bounce to an
      // internal address, defeating the guard above. Bound the request so
      // a hung host can't tie up the template-submit handler.
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error('Could not fetch the header media URL. Make sure it is publicly reachable.')
  }
  if (!res.ok) {
    throw new Error(`Header media URL returned ${res.status}. It must be publicly reachable.`)
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !spec.allowedTypes.includes(contentType)) {
    throw new Error(
      `Header ${headerType} must be ${spec.acceptedLabel} (got ${contentType}).`,
    )
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new Error('Header media is empty.')
  }
  if (bytes.byteLength > spec.maxBytes) {
    throw new Error(
      `Header ${headerType} is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB — the limit is ${(
        spec.maxBytes / (1024 * 1024)
      ).toFixed(0)} MB.`,
    )
  }

  const mimeType = contentType && spec.allowedTypes.includes(contentType) ? contentType : spec.defaultType
  const fileName = `header.${EXT_BY_TYPE[mimeType]}`

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  })
  payload.header_handle = handle
}
/**
 * WhatsApp Flows data-exchange encryption.
 *
 * Meta encrypts every request to a flow's data endpoint:
 *
 *   1. A fresh AES-128 key (+ 16-byte IV) encrypts the JSON body with
 *      AES-GCM; the 16-byte auth tag is appended to the ciphertext.
 *   2. The AES key is wrapped with the business public key we
 *      registered (RSA-OAEP, SHA-256).
 *
 * The response goes back AES-GCM-encrypted with the SAME key but the
 * IV bit-flipped (every byte inverted), base64'd, as text/plain.
 *
 *   https://developers.facebook.com/docs/whatsapp/flows/guides/implementingyourflowendpoint#request-decryption-and-encryption
 */

import {
  constants,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
} from 'node:crypto'

const TAG_LENGTH = 16

/** An RSA-2048 keypair in the PEM shapes Meta and node expect. */
export function generateFlowKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { publicKeyPem: publicKey, privateKeyPem: privateKey }
}

export interface EncryptedFlowRequest {
  encrypted_flow_data: string
  encrypted_aes_key: string
  initial_vector: string
}

export function isEncryptedFlowRequest(body: unknown): body is EncryptedFlowRequest {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return (
    typeof b.encrypted_flow_data === 'string' &&
    typeof b.encrypted_aes_key === 'string' &&
    typeof b.initial_vector === 'string'
  )
}

export class FlowDecryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlowDecryptionError'
  }
}

function gcmAlgorithm(key: Buffer): 'aes-128-gcm' | 'aes-192-gcm' | 'aes-256-gcm' {
  switch (key.length) {
    case 16:
      return 'aes-128-gcm'
    case 24:
      return 'aes-192-gcm'
    case 32:
      return 'aes-256-gcm'
    default:
      throw new FlowDecryptionError(`Unexpected AES key length ${key.length}.`)
  }
}

export interface DecryptedFlowRequest {
  body: Record<string, unknown>
  aesKey: Buffer
  iv: Buffer
}

/**
 * Unwrap the AES key with our private key and decrypt the body.
 * Any failure is a FlowDecryptionError — the endpoint answers 421,
 * which tells Meta's client to re-fetch the public key and retry.
 */
export function decryptFlowRequest(
  request: EncryptedFlowRequest,
  privateKeyPem: string,
): DecryptedFlowRequest {
  let aesKey: Buffer
  try {
    aesKey = privateDecrypt(
      {
        key: privateKeyPem,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(request.encrypted_aes_key, 'base64'),
    )
  } catch (e) {
    throw new FlowDecryptionError(
      `Could not unwrap the AES key: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  const iv = Buffer.from(request.initial_vector, 'base64')
  const data = Buffer.from(request.encrypted_flow_data, 'base64')
  if (data.length <= TAG_LENGTH) {
    throw new FlowDecryptionError('Encrypted payload is too short.')
  }
  const ciphertext = data.subarray(0, data.length - TAG_LENGTH)
  const tag = data.subarray(data.length - TAG_LENGTH)

  let plaintext: string
  try {
    const decipher = createDecipheriv(gcmAlgorithm(aesKey), aesKey, iv)
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch (e) {
    if (e instanceof FlowDecryptionError) throw e
    throw new FlowDecryptionError(
      `Could not decrypt the payload: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  let body: unknown
  try {
    body = JSON.parse(plaintext)
  } catch {
    throw new FlowDecryptionError('Decrypted payload is not JSON.')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FlowDecryptionError('Decrypted payload is not a JSON object.')
  }
  return { body: body as Record<string, unknown>, aesKey, iv }
}

/** Encrypt a response with the request's key and the flipped IV. */
export function encryptFlowResponse(response: unknown, aesKey: Buffer, iv: Buffer): string {
  const flipped = Buffer.from(iv.map((byte) => ~byte & 0xff))
  const cipher = createCipheriv(gcmAlgorithm(aesKey), aesKey, flipped)
  return Buffer.concat([
    cipher.update(JSON.stringify(response), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64')
}

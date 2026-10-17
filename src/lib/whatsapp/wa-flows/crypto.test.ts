import {
  constants,
  createCipheriv,
  createDecipheriv,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  decryptFlowRequest,
  encryptFlowResponse,
  FlowDecryptionError,
  generateFlowKeyPair,
  isEncryptedFlowRequest,
} from './crypto';

const { publicKeyPem, privateKeyPem } = generateFlowKeyPair();

/** What Meta's client does to build an endpoint request. */
function metaEncrypt(body: unknown) {
  const aesKey = randomBytes(16);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-gcm', aesKey, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(body), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const wrapped = publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey,
  );
  return {
    request: {
      encrypted_flow_data: data.toString('base64'),
      encrypted_aes_key: wrapped.toString('base64'),
      initial_vector: iv.toString('base64'),
    },
    aesKey,
    iv,
  };
}

describe('flow endpoint crypto', () => {
  it('decrypts a Meta-shaped request', () => {
    const { request } = metaEncrypt({ action: 'ping', version: '3.0' });
    const { body } = decryptFlowRequest(request, privateKeyPem);
    expect(body).toEqual({ action: 'ping', version: '3.0' });
  });

  it('encrypts the response with the flipped IV, as Meta decrypts it', () => {
    const { request, aesKey, iv } = metaEncrypt({ action: 'INIT' });
    const decrypted = decryptFlowRequest(request, privateKeyPem);
    const encoded = encryptFlowResponse({ screen: 'A', data: {} }, decrypted.aesKey, decrypted.iv);

    const raw = Buffer.from(encoded, 'base64');
    const flipped = Buffer.from(iv.map((b) => ~b & 0xff));
    const decipher = createDecipheriv('aes-128-gcm', aesKey, flipped);
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - 16)),
      decipher.final(),
    ]).toString('utf8');
    expect(JSON.parse(plain)).toEqual({ screen: 'A', data: {} });
  });

  it('rejects a payload wrapped for another key', () => {
    const other = generateFlowKeyPair();
    const { request } = metaEncrypt({ action: 'ping' });
    expect(() => decryptFlowRequest(request, other.privateKeyPem)).toThrow(FlowDecryptionError);
  });

  it('rejects a tampered ciphertext (GCM tag mismatch)', () => {
    const { request } = metaEncrypt({ action: 'ping' });
    const data = Buffer.from(request.encrypted_flow_data, 'base64');
    data[0] ^= 0xff;
    expect(() =>
      decryptFlowRequest({ ...request, encrypted_flow_data: data.toString('base64') }, privateKeyPem),
    ).toThrow(FlowDecryptionError);
  });

  it('recognises the request envelope', () => {
    expect(isEncryptedFlowRequest(metaEncrypt({}).request)).toBe(true);
    expect(isEncryptedFlowRequest({ encrypted_flow_data: 'x' })).toBe(false);
    expect(isEncryptedFlowRequest(null)).toBe(false);
  });
});

import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "./webhook-signature";

const SECRET = process.env.META_APP_SECRET!;

function signedHeader(body: string, secret: string = SECRET): string {
  const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
}

describe("verifyWebhookSignature", () => {
  it("accepts a request signed with the correct secret", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    expect(verifyWebhookSignature(body, signedHeader(body))).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const body = "{}";
    expect(
      verifyWebhookSignature(body, signedHeader(body, "wrong")),
    ).toBe(false);
  });

  it("rejects when the body has been tampered with after signing", () => {
    const original = '{"entry":[]}';
    const header = signedHeader(original);
    const tampered = '{"entry":[{"id":"injected"}]}';
    expect(verifyWebhookSignature(tampered, header)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyWebhookSignature("anything", null)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const body = "{}";
    const hex = crypto
      .createHmac("sha256", SECRET)
      .update(body)
      .digest("hex");
    expect(verifyWebhookSignature(body, hex)).toBe(false);
    expect(verifyWebhookSignature(body, `sha512=${hex}`)).toBe(false);
  });

  it("rejects a header of the wrong length without throwing", () => {
    // timingSafeEqual would throw on length mismatch — the guard inside
    // the verifier should catch this and return false instead.
    expect(verifyWebhookSignature("{}", "sha256=tooshort")).toBe(false);
  });

  // Multi-app deployments (migration 048): a business's number can be
  // delivered by a Meta app other than the deployment's, so its row
  // carries that app's secret and the verifier must accept it.
  const APP_B_SECRET = "b".repeat(32);

  it("accepts a request signed by a per-account app secret", () => {
    const body = '{"entry":[]}';
    expect(
      verifyWebhookSignature(body, signedHeader(body, APP_B_SECRET), [
        APP_B_SECRET,
      ]),
    ).toBe(true);
  });

  it("does not let the env secret shadow a per-account secret", () => {
    const body = '{"entry":[]}';
    // Signed by app A (the env secret) must still verify while app B
    // secrets are present, and vice versa.
    expect(
      verifyWebhookSignature(body, signedHeader(body), [APP_B_SECRET]),
    ).toBe(true);
    expect(
      verifyWebhookSignature(body, signedHeader(body, APP_B_SECRET), [
        APP_B_SECRET,
      ]),
    ).toBe(true);
  });

  it("ignores empty per-account secrets without rejecting valid ones", () => {
    const body = '{"entry":[]}';
    expect(
      verifyWebhookSignature(body, signedHeader(body), ["", APP_B_SECRET]),
    ).toBe(true);
  });

  it("rejects with extras when nothing matches", () => {
    const body = '{"entry":[]}';
    expect(
      verifyWebhookSignature(body, signedHeader(body, "wrong-entirely"), [
        APP_B_SECRET,
      ]),
    ).toBe(false);
  });

  describe("fail-closed when secret is missing", () => {
    const originalSecret = process.env.META_APP_SECRET;
    beforeEach(() => {
      delete process.env.META_APP_SECRET;
    });
    afterEach(() => {
      process.env.META_APP_SECRET = originalSecret;
    });

    it("rejects even a correctly-formed signature when no secret is configured", () => {
      const body = "{}";
      // Use the original secret to produce the header so we can verify
      // the rejection is solely due to missing config.
      const header = signedHeader(body, originalSecret!);
      expect(verifyWebhookSignature(body, header)).toBe(false);
    });

    it("accepts a per-account-secret-signed request even without the env secret", () => {
      const body = '{"entry":[]}';
      const header = signedHeader(body, APP_B_SECRET);
      expect(verifyWebhookSignature(body, header, [APP_B_SECRET])).toBe(true);
    });

    it("still rejects when neither the env nor any per-account secret is set", () => {
      expect(verifyWebhookSignature("{}", null, [])).toBe(false);
      expect(verifyWebhookSignature("{}", "sha256=whatever", [""])).toBe(false);
    });
  });
});
import { describe, expect, it } from "vitest";
import { listProtocolIntegrations } from "../src/protocols.js";

describe("protocol integration registry", () => {
  it("tracks the requested protocol set with honest status", () => {
    const protocols = listProtocolIntegrations({ slugs: ["navi", "suilend", "bucket", "kaio", "turbos", "abyss"] });
    expect(protocols.map((protocol) => protocol.slug)).toEqual(["navi", "suilend", "bucket", "kaio", "turbos", "abyss"]);
    expect(protocols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "navi", status: "adapter_needed" }),
        expect.objectContaining({ slug: "suilend", status: "implemented" }),
        expect.objectContaining({ slug: "bucket", status: "partially_implemented" }),
        expect.objectContaining({ slug: "kaio", status: "implemented" }),
        expect.objectContaining({ slug: "turbos", status: "implemented" }),
        expect.objectContaining({ slug: "abyss", status: "adapter_needed" }),
      ]),
    );
  });

  it("tracks v2-compatible top-30 candidates without marking them executable too early", () => {
    const protocols = listProtocolIntegrations({ slugs: ["ember-protocol", "springsui", "alphalend"] });
    expect(protocols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "ember-protocol", status: "adapter_needed", sdk: expect.objectContaining({ suiCompatibility: "v2_compatible" }) }),
        expect.objectContaining({ slug: "springsui", status: "adapter_needed" }),
        expect.objectContaining({ slug: "alphalend", status: "adapter_needed", sdk: expect.objectContaining({ suiCompatibility: "v1_or_legacy" }) }),
      ]),
    );
  });
});

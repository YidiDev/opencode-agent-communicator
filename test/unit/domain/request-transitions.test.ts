import { describe, expect, test } from "bun:test";

import {
  canTransitionRequestDelivery,
  canTransitionRequestResolution,
  canTransitionRequestResult,
  resolutionAppliesToRequestKind,
} from "../../../src/domain/request-transitions";
import {
  requestDeliveryStates,
  requestResolutionStates,
  requestResultStates,
} from "../../../src/domain/request-types";

describe("request state machines", () => {
  test("allows exactly one pending resolution and no terminal replacement", () => {
    for (const from of requestResolutionStates) {
      for (const to of requestResolutionStates) {
        expect(canTransitionRequestResolution(from, to)).toBe(
          from === "pending" && to !== "pending",
        );
      }
    }
    expect(resolutionAppliesToRequestKind("ask", "answered")).toBe(true);
    expect(resolutionAppliesToRequestKind("ask", "reached")).toBe(false);
    expect(resolutionAppliesToRequestKind("wait", "reached")).toBe(true);
    expect(resolutionAppliesToRequestKind("wait", "answered")).toBe(false);
  });

  test("implements the exact independent delivery graph", () => {
    const edges = new Set([
      "prepared->submitting",
      "submitting->delivery_unknown",
      "submitting->admitted",
      "submitting->promoted",
      "submitting->delivery_failed",
      "delivery_unknown->admitted",
      "delivery_unknown->promoted",
      "delivery_unknown->delivery_failed",
      "admitted->promoted",
    ]);
    for (const from of requestDeliveryStates) {
      for (const to of requestDeliveryStates) {
        expect(canTransitionRequestDelivery(from, to)).toBe(edges.has(`${from}->${to}`));
      }
    }
  });

  test("expires or acknowledges available results monotonically", () => {
    const edges = new Set([
      "none->available",
      "available->expired",
      "available->acknowledged",
      "expired->acknowledged",
    ]);
    for (const from of requestResultStates) {
      for (const to of requestResultStates) {
        expect(canTransitionRequestResult(from, to)).toBe(edges.has(`${from}->${to}`));
      }
    }
  });
});

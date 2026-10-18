import { describe, expect, test } from "bun:test";
import {
  isOpenCode2ParticipantActivityEvent,
  parseOpenCode2ParticipantActivityEvent,
  parseOpenCode2ParticipantStatus,
} from "../../../src/application/participant-stop-evidence";
import { validateSessionId } from "../../../src/domain/sessions";

const participantResult = validateSessionId("ses_participant");
if (!participantResult.ok) throw new Error("invalid participant fixture");
const participant = participantResult.value;

function idleEvent() {
  return { id: "evt_idle", created: 1, type: "session.idle", data: { sessionID: participant } };
}

function statusEvent(activity: "busy" | "idle" | "retry") {
  return {
    id: `evt_${activity}`,
    created: 1,
    type: "session.status",
    data: {
      sessionID: participant,
      status:
        activity === "retry"
          ? { type: "retry", attempt: 1, message: "retrying", next: 10 }
          : { type: activity },
    },
  };
}

describe("OpenCode 2.0.26 participant activity evidence", () => {
  test("parses only exact public idle and status shapes", () => {
    expect(parseOpenCode2ParticipantActivityEvent(idleEvent())).toEqual({
      sessionId: participant,
      activity: "idle",
    });
    expect(
      parseOpenCode2ParticipantActivityEvent({
        ...idleEvent(),
        location: { directory: "/workspace", workspaceID: "wrk_1" },
      }),
    ).toEqual({
      sessionId: participant,
      activity: "idle",
      directory: "/workspace",
    });
    for (const activity of ["busy", "idle", "retry"] as const) {
      expect(parseOpenCode2ParticipantActivityEvent(statusEvent(activity))).toEqual({
        sessionId: participant,
        activity,
      });
    }
    expect(
      parseOpenCode2ParticipantActivityEvent({
        ...statusEvent("retry"),
        data: {
          sessionID: participant,
          status: {
            type: "retry",
            attempt: 1,
            message: "retrying",
            action: {
              reason: "quota",
              provider: "provider",
              title: "Retry later",
              message: "Rate limited",
              label: "Details",
              link: "https://example.invalid/help",
            },
            next: 10,
          },
        },
      }),
    ).toEqual({ sessionId: participant, activity: "retry" });
    expect(parseOpenCode2ParticipantActivityEvent({ type: "message.updated" })).toBeUndefined();
    expect(isOpenCode2ParticipantActivityEvent(idleEvent())).toBe(true);
    expect(isOpenCode2ParticipantActivityEvent(null)).toBe(false);
  });

  test("rejects hostile or malformed relevant events without invoking accessors", () => {
    for (const value of [
      { ...idleEvent(), extra: true },
      { ...idleEvent(), id: "" },
      { ...idleEvent(), id: 1 },
      { ...idleEvent(), created: Number.NaN },
      { ...idleEvent(), data: { sessionID: "bad" } },
      { ...statusEvent("idle"), data: { sessionID: participant, status: { type: "other" } } },
      {
        id: "evt_retry",
        created: 1,
        type: "session.status",
        data: {
          sessionID: participant,
          status: { type: "retry", attempt: -1, message: "x", next: 1 },
        },
      },
      {
        id: "evt_retry",
        created: 1,
        type: "session.status",
        data: {
          sessionID: participant,
          status: {
            type: "retry",
            attempt: 1,
            message: "x",
            action: { reason: "quota" },
            next: 1,
          },
        },
      },
    ]) {
      expect(() => parseOpenCode2ParticipantActivityEvent(value)).toThrow("malformed");
    }
    expect(
      parseOpenCode2ParticipantActivityEvent(
        Object.create({
          id: "evt_idle",
          created: 1,
          type: "session.idle",
          data: { sessionID: participant },
        }),
      ),
    ).toBeUndefined();
    let accessed = false;
    const accessor = Object.create(null);
    Object.defineProperty(accessor, "type", {
      enumerable: true,
      get() {
        accessed = true;
        return "session.idle";
      },
    });
    Object.defineProperty(accessor, "data", {
      enumerable: true,
      value: { sessionID: participant },
    });
    expect(isOpenCode2ParticipantActivityEvent(accessor)).toBe(false);
    expect(accessed).toBe(false);

    const hostile = new Proxy(idleEvent(), {
      ownKeys() {
        throw new Error("hostile reflection");
      },
    });
    expect(() => parseOpenCode2ParticipantActivityEvent(hostile)).toThrow("malformed");
  });
});

describe("OpenCode 2.0.26 participant status evidence", () => {
  test("accepts the exact public v2 envelope and retry action variants", () => {
    const metadata = Object.assign(Object.create(null), { source: "event-stream" });
    const location = Object.assign(Object.create(null), { directory: "/workspace" });
    const parsed = parseOpenCode2ParticipantActivityEvent({
      ...idleEvent(),
      location,
      metadata,
    });
    expect(parsed).toEqual({ sessionId: participant, activity: "idle", directory: "/workspace" });
    expect(Object.isFrozen(parsed)).toBe(true);

    for (const action of [
      {
        reason: "quota",
        provider: "provider",
        title: "Retry later",
        message: "Rate limited",
        label: "Details",
      },
      {
        reason: "",
        provider: "",
        title: "",
        message: "",
        label: "",
        link: "",
      },
    ]) {
      expect(
        parseOpenCode2ParticipantStatus({
          type: "retry",
          attempt: 0,
          message: "",
          action,
          next: 0,
        }),
      ).toBe("retry");
    }
    expect(parseOpenCode2ParticipantStatus({ type: "busy" })).toBe("busy");
    expect(parseOpenCode2ParticipantStatus({ type: "idle" })).toBe("idle");
  });

  test("rejects malformed retry and action status records", () => {
    const retry = {
      type: "retry",
      attempt: 1,
      message: "retrying",
      next: 10,
    };
    const action = {
      reason: "quota",
      provider: "provider",
      title: "Retry later",
      message: "Rate limited",
      label: "Details",
    };
    for (const status of [
      null,
      [],
      Object.assign(Object.create({ inherited: true }), { type: "idle" }),
      { type: "busy", extra: true },
      { ...retry, attempt: 1.5 },
      { ...retry, attempt: -1 },
      { ...retry, attempt: Number.MAX_SAFE_INTEGER + 1 },
      { ...retry, message: 1 },
      { ...retry, message: "x".repeat(65_537) },
      { ...retry, next: 1.5 },
      { ...retry, next: -1 },
      { ...retry, next: Number.MAX_SAFE_INTEGER + 1 },
      { ...retry, action: null },
      { ...retry, action: { reason: "quota" } },
      { ...retry, action: { ...action, reason: 1 } },
      { ...retry, action: { ...action, provider: "x".repeat(65_537) } },
      { ...retry, action: { ...action, link: 1 } },
      { ...retry, action: { ...action, link: "x".repeat(65_537) } },
      { ...retry, action: { ...action, extra: true } },
      { ...retry, action: Object.assign(Object.create({}), action) },
    ]) {
      expect(parseOpenCode2ParticipantStatus(status)).toBeUndefined();
    }

    let accessed = false;
    const accessorStatus = { ...retry };
    Object.defineProperty(accessorStatus, "message", {
      enumerable: true,
      get() {
        accessed = true;
        return "do not read";
      },
    });
    expect(parseOpenCode2ParticipantStatus(accessorStatus)).toBeUndefined();
    expect(accessed).toBe(false);
  });
});

describe("OpenCode 2.0.26 participant envelope hardening", () => {
  test("rejects malformed public metadata, location, data, and envelope records", () => {
    const tooManyMetadataEntries = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => [`key${index}`, index]),
    );
    const symbolMetadata = { [Symbol("metadata")]: true };
    const hiddenMetadata = {};
    Object.defineProperty(hiddenMetadata, "hidden", { enumerable: false, value: true });
    const accessorMetadata = {};
    Object.defineProperty(accessorMetadata, "value", {
      enumerable: true,
      get: () => "untrusted",
    });
    const hostileMetadata = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile metadata");
        },
      },
    );

    const malformedMetadata = [
      null,
      [],
      "metadata",
      Object.create({ inherited: true }),
      tooManyMetadataEntries,
      symbolMetadata,
      hiddenMetadata,
      accessorMetadata,
      hostileMetadata,
    ];
    for (const metadata of malformedMetadata) {
      expect(() => parseOpenCode2ParticipantActivityEvent({ ...idleEvent(), metadata })).toThrow(
        "malformed",
      );
    }

    for (const location of [
      null,
      [],
      {},
      { directory: "" },
      { directory: 1 },
      { directory: "x".repeat(4_097) },
      { directory: "/workspace", workspaceID: "" },
      { directory: "/workspace", workspaceID: 1 },
      { directory: "/workspace", workspaceID: "x".repeat(513) },
      { directory: "/workspace", extra: true },
      Object.assign(Object.create({ inherited: true }), { directory: "/workspace" }),
    ]) {
      expect(() => parseOpenCode2ParticipantActivityEvent({ ...idleEvent(), location })).toThrow(
        "malformed",
      );
    }

    const symbolData = { sessionID: participant, [Symbol("data")]: true };
    const hiddenData = {};
    Object.defineProperty(hiddenData, "sessionID", { enumerable: false, value: participant });
    const accessorData = {};
    let dataAccessed = false;
    Object.defineProperty(accessorData, "sessionID", {
      enumerable: true,
      get() {
        dataAccessed = true;
        return participant;
      },
    });
    for (const data of [
      null,
      [],
      {},
      { sessionID: participant, extra: true },
      symbolData,
      hiddenData,
      accessorData,
      Object.assign(Object.create({ inherited: true }), { sessionID: participant }),
    ]) {
      expect(() => parseOpenCode2ParticipantActivityEvent({ ...idleEvent(), data })).toThrow(
        "malformed",
      );
    }
    expect(dataAccessed).toBe(false);

    const customPrototypeEnvelope = Object.assign(Object.create({ inherited: true }), idleEvent());
    for (const event of [
      { ...idleEvent(), id: "x".repeat(257) },
      { ...idleEvent(), created: "1" },
      { ...idleEvent(), created: Number.POSITIVE_INFINITY },
      customPrototypeEnvelope,
    ]) {
      expect(() => parseOpenCode2ParticipantActivityEvent(event)).toThrow("malformed");
    }
  });

  test("rejects accessors, reflection traps, and legacy participant evidence", () => {
    let idAccessed = false;
    const accessorEnvelope = idleEvent();
    Object.defineProperty(accessorEnvelope, "id", {
      enumerable: true,
      get() {
        idAccessed = true;
        return "evt_accessor";
      },
    });
    expect(() => parseOpenCode2ParticipantActivityEvent(accessorEnvelope)).toThrow("malformed");
    expect(idAccessed).toBe(false);

    const hostileDetector = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile descriptor");
        },
      },
    );
    expect(isOpenCode2ParticipantActivityEvent(hostileDetector)).toBe(false);
    expect(isOpenCode2ParticipantActivityEvent([])).toBe(false);
    expect(isOpenCode2ParticipantActivityEvent({ type: "message.updated" })).toBe(false);

    const hiddenType = { ...idleEvent() };
    Object.defineProperty(hiddenType, "type", { enumerable: false, value: "session.idle" });
    expect(isOpenCode2ParticipantActivityEvent(hiddenType)).toBe(false);

    for (const legacy of [
      { type: "session.idle", properties: { sessionID: participant } },
      {
        type: "session.status",
        properties: { sessionID: participant, status: { type: "idle" } },
      },
    ]) {
      expect(() => parseOpenCode2ParticipantActivityEvent(legacy)).toThrow("malformed");
    }
  });
});

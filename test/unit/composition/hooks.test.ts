import { describe, expect, test } from "bun:test";
import {
  registerBundledSkills,
  registerCommunicatorPrimaryTools,
} from "../../../src/composition/plugin";
import { communicatorToolIds } from "../../../src/composition/tools";

describe("plugin configuration hook", () => {
  test("preserves experimental configuration and registers communicator tools once", () => {
    const config = {
      experimental: {
        batch_tool: true,
        primary_tools: ["existing_primary", "session_list"],
      },
    };
    registerCommunicatorPrimaryTools(config);
    registerCommunicatorPrimaryTools(config);
    expect(config.experimental.batch_tool).toBe(true);
    expect(config.experimental.primary_tools).toEqual(["existing_primary", ...communicatorToolIds]);
  });

  test("creates the experimental shape with the exact communicator tool set", () => {
    const config: { experimental?: { primary_tools?: string[] } } = {};
    registerCommunicatorPrimaryTools(config);
    expect(config.experimental?.primary_tools).toEqual([...communicatorToolIds]);
  });

  test("rejects malformed reflective primary tool values", () => {
    expect(() => registerCommunicatorPrimaryTools({ experimental: [] })).toThrow("malformed");
    expect(() => registerCommunicatorPrimaryTools({ experimental: null })).toThrow("malformed");
    expect(() =>
      registerCommunicatorPrimaryTools({ experimental: { primary_tools: "session_list" } }),
    ).toThrow("malformed");
    expect(() =>
      registerCommunicatorPrimaryTools({ experimental: { primary_tools: [3] } }),
    ).toThrow("malformed");
  });

  test("preserves existing skill configuration and deduplicates the bundled path", () => {
    const config = { skills: { paths: ["/existing"], urls: ["https://skills.example/"] } };
    registerBundledSkills(config);
    registerBundledSkills(config);
    expect(config.skills.paths[0]).toBe("/existing");
    expect(config.skills.paths).toHaveLength(2);
    expect(config.skills.paths[1]).toEndWith("/skills");
    expect(config.skills.urls).toEqual(["https://skills.example/"]);
  });

  test("rejects malformed reflective skills values", () => {
    expect(() => registerBundledSkills({ skills: [] })).toThrow("malformed");
    expect(() => registerBundledSkills({ skills: null })).toThrow("malformed");
    expect(() => registerBundledSkills({ skills: { paths: [3] } })).toThrow("malformed");
    expect(() => registerBundledSkills({ skills: { paths: "not-an-array" } })).toThrow("malformed");
  });

  test("creates the skills shape when the host has no prior skill configuration", () => {
    const config: { skills?: { paths: string[] } } = {};
    registerBundledSkills(config);
    expect(config.skills?.paths).toHaveLength(1);
    expect(config.skills?.paths[0]).toEndWith("/skills");
  });
});

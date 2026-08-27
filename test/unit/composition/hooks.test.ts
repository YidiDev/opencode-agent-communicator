import { describe, expect, test } from "bun:test";
import { registerBundledSkills } from "../../../src/composition/plugin";

describe("plugin configuration hook", () => {
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

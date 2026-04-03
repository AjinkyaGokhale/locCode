import { describe, expect, it } from "vitest";
import { createPermissionPolicy } from "../src/permissions.js";

const INPUT = {};

describe("createPermissionPolicy — read-only", () => {
  const policy = createPermissionPolicy("read-only");

  it("allows read_file", () => {
    expect(policy.authorize("read_file", INPUT).outcome).toBe("allow");
  });

  it("allows glob_search", () => {
    expect(policy.authorize("glob_search", INPUT).outcome).toBe("allow");
  });

  it("allows grep_search", () => {
    expect(policy.authorize("grep_search", INPUT).outcome).toBe("allow");
  });

  it("denies write_file", () => {
    expect(policy.authorize("write_file", INPUT).outcome).toBe("deny");
  });

  it("denies edit_file", () => {
    expect(policy.authorize("edit_file", INPUT).outcome).toBe("deny");
  });

  it("denies bash", () => {
    expect(policy.authorize("bash", INPUT).outcome).toBe("deny");
  });
});

describe("createPermissionPolicy — workspace-write", () => {
  const policy = createPermissionPolicy("workspace-write");

  it("allows read_file", () => {
    expect(policy.authorize("read_file", INPUT).outcome).toBe("allow");
  });

  it("allows glob_search", () => {
    expect(policy.authorize("glob_search", INPUT).outcome).toBe("allow");
  });

  it("allows grep_search", () => {
    expect(policy.authorize("grep_search", INPUT).outcome).toBe("allow");
  });

  it("allows write_file", () => {
    expect(policy.authorize("write_file", INPUT).outcome).toBe("allow");
  });

  it("allows edit_file", () => {
    expect(policy.authorize("edit_file", INPUT).outcome).toBe("allow");
  });

  it("prompts for bash", () => {
    expect(policy.authorize("bash", INPUT).outcome).toBe("prompt");
  });

  it("denies unknown tools", () => {
    expect(policy.authorize("unknown_tool", INPUT).outcome).toBe("deny");
  });
});

describe("createPermissionPolicy — allow-all", () => {
  const policy = createPermissionPolicy("allow-all");

  it("allows bash", () => {
    expect(policy.authorize("bash", INPUT).outcome).toBe("allow");
  });

  it("allows write_file", () => {
    expect(policy.authorize("write_file", INPUT).outcome).toBe("allow");
  });

  it("allows edit_file", () => {
    expect(policy.authorize("edit_file", INPUT).outcome).toBe("allow");
  });

  it("allows read_file", () => {
    expect(policy.authorize("read_file", INPUT).outcome).toBe("allow");
  });
});

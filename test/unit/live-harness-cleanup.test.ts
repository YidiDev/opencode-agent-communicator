import { expect, test } from "bun:test";

import { cleanupAll } from "../live/harness/cleanup";

test("cleanup attempts every boundary and preserves the first cleanup failure", async () => {
  const attempted: string[] = [];
  const first = new Error("server cleanup failed");
  const later = new Error("provider cleanup failed");

  await expect(
    cleanupAll([
      () => {
        attempted.push("server");
        throw first;
      },
      () => {
        attempted.push("provider");
        throw later;
      },
      () => {
        attempted.push("isolation");
      },
    ]),
  ).rejects.toBe(first);
  expect(attempted).toEqual(["server", "provider", "isolation"]);
});

test("cleanup after readiness failure preserves setup failure while attempting all boundaries", async () => {
  const readiness = new Error("server readiness failed");
  const attempted: string[] = [];

  await expect(
    cleanupAll(
      [
        () => {
          attempted.push("server");
          throw new Error("termination failed");
        },
        () => {
          attempted.push("provider");
        },
        () => {
          attempted.push("isolation");
        },
      ],
      readiness,
    ),
  ).rejects.toBe(readiness);
  expect(attempted).toEqual(["server", "provider", "isolation"]);
});

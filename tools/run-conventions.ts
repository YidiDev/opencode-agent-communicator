import { checkConventions } from "./check-conventions";

const diagnostics = checkConventions({ rootDirectory: process.cwd() });
for (const item of diagnostics) {
  const location = item.line === undefined ? item.path : `${item.path}:${item.line}`;
  console.error(`${item.severity.toUpperCase()} ${location} [${item.rule}] ${item.message}`);
}
if (diagnostics.some((item) => item.severity === "error")) process.exitCode = 1;

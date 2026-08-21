import { checkCoverage } from "./check-coverage";

const diagnostics = checkCoverage({ rootDirectory: process.cwd() });
for (const item of diagnostics) console.error(`ERROR ${item.path} [coverage] ${item.message}`);
if (diagnostics.length > 0) process.exitCode = 1;

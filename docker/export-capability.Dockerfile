ARG BASE_IMAGE=oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef
FROM ${BASE_IMAGE}

WORKDIR /app
COPY package.json bun.lock tsconfig.json biome.json ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY test/acceptance/export-capability.test.ts ./test/acceptance/export-capability.test.ts
COPY test/integration/adapters/export/linux-export-destination.test.ts ./test/integration/adapters/export/linux-export-destination.test.ts
COPY test/integration/adapters/export/opencode-cli-export-adapter.test.ts ./test/integration/adapters/export/opencode-cli-export-adapter.test.ts
COPY test/support/linux-export-capability.ts ./test/support/linux-export-capability.ts
COPY tools/run-secure-export-capability-tests.mjs ./tools/run-secure-export-capability-tests.mjs

ENV REQUIRE_SECURE_EXPORT_CAPABILITY=1
ENTRYPOINT ["bun", "tools/run-secure-export-capability-tests.mjs"]

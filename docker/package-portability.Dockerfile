FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS source
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY test/unit/adapters/export/a-linux-syscalls.test.ts ./test/unit/adapters/export/a-linux-syscalls.test.ts
COPY test/unit/composition/plugin-factory.test.ts ./test/unit/composition/plugin-factory.test.ts
COPY skills ./skills
COPY docs ./docs
COPY CHANGELOG.md LICENSE README.md SECURITY.md ./
RUN bun -e 'import plugin from "./src/index.ts"; if (plugin.id !== "opencode-agent-communicator" || typeof plugin.effect !== "function") throw new Error("source entry is not a v2 Effect plugin")'
RUN bun test test/unit/adapters/export/a-linux-syscalls.test.ts test/unit/composition/plugin-factory.test.ts

FROM source AS packed
RUN mkdir /package && bun pm pack --ignore-scripts --destination /package
RUN apk add --no-cache npm
RUN mkdir /consumer
WORKDIR /consumer
RUN npm install --ignore-scripts --no-audit --no-fund /package/opencode-agent-communicator-0.9.0.tgz
RUN bun -e 'import plugin from "opencode-agent-communicator"; if (plugin.id !== "opencode-agent-communicator" || typeof plugin.effect !== "function") throw new Error("packed entry is not a v2 Effect plugin")'

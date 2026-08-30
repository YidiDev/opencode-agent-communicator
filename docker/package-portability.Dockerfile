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
RUN bun -e 'import plugin from "./src/index.ts"; if (typeof plugin !== "function") throw new Error("source entry is not a plugin")'
RUN bun test test/unit/adapters/export/a-linux-syscalls.test.ts test/unit/composition/plugin-factory.test.ts

FROM source AS packed
RUN mkdir /package && bun pm pack --ignore-scripts --destination /package
RUN mkdir /consumer
WORKDIR /consumer
RUN bun init -y && bun add /package/opencode-agent-communicator-0.5.0.tgz --ignore-scripts
RUN bun -e 'import plugin from "opencode-agent-communicator"; if (typeof plugin !== "function") throw new Error("packed entry is not a plugin")'

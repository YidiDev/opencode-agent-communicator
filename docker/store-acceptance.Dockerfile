FROM oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef AS debian
USER root
RUN groupadd --gid 10001 victim && useradd --uid 10001 --gid 10001 --no-create-home victim \
  && groupadd --gid 10002 attacker && useradd --uid 10002 --gid 10002 --no-create-home attacker \
  && mkdir -p /app /acceptance-overlay /control \
  && chown 10001:10001 /acceptance-overlay \
  && chmod 0700 /acceptance-overlay \
  && chmod 0777 /control
WORKDIR /app
COPY package.json bun.lock tsconfig.json biome.json ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY test/acceptance ./test/acceptance
ENTRYPOINT ["bun", "test/acceptance/store/driver.ts"]

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS alpine
USER root
RUN addgroup -g 10001 victim && adduser -D -H -u 10001 -G victim victim \
  && addgroup -g 10002 attacker && adduser -D -H -u 10002 -G attacker attacker \
  && mkdir -p /app /acceptance-overlay /control \
  && chown 10001:10001 /acceptance-overlay \
  && chmod 0700 /acceptance-overlay \
  && chmod 0777 /control
WORKDIR /app
COPY package.json bun.lock tsconfig.json biome.json ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY test/acceptance ./test/acceptance
ENTRYPOINT ["bun", "test/acceptance/store/driver.ts"]

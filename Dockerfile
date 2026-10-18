# Stage 1: build the React client.
FROM oven/bun:1.4 AS client
WORKDIR /client
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./
RUN bun run build

# Stage 2: the Bun server, serving web/dist.
FROM oven/bun:1.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY --from=client /client/dist ./web/dist
ENV PORT=10000
EXPOSE 10000
CMD ["bun", "src/server.ts"]

FROM oven/bun:1.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public
ENV PORT=10000
EXPOSE 10000
CMD ["bun", "src/server.ts"]

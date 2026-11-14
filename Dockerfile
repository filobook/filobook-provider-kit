# Standalone server image (Node). Build after editing src/rules.ts:
#   docker build -t filobook-provider .
#   docker run -d --name filobook-provider -p 8787:8787 -v filobook-state:/data \
#     -e FILOBOOK_API_KEY=fb_live_… -e WEBHOOK_SECRET=whsec_… filobook-provider

FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 STATE_FILE=/data/state.json
COPY --from=build /app/dist/server.mjs ./server.mjs
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "server.mjs"]

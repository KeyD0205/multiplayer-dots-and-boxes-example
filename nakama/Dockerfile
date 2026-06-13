FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache git

COPY package.json package-lock.json tsconfig.json jest.config.js rollup.config.js ./
COPY src ./src
RUN npm ci && npm run build

FROM registry.heroiclabs.com/heroiclabs/nakama:3.22.0
COPY --from=builder /app/build/*.js /nakama/data/modules/build/
COPY local.yml /nakama/data/local.yml

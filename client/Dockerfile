FROM node:20-alpine AS builder
WORKDIR /app
ARG VITE_NAKAMA_HOST=localhost
ARG VITE_NAKAMA_PORT=7350
ARG VITE_NAKAMA_SCHEME=http
ARG NAKAMA_CLIENT_PUBLIC=defaultkey
ARG NAKAMA_CONNECT_SRC="http://localhost:7350 ws://localhost:7350"
ENV VITE_NAKAMA_HOST=$VITE_NAKAMA_HOST
ENV VITE_NAKAMA_PORT=$VITE_NAKAMA_PORT
ENV VITE_NAKAMA_SCHEME=$VITE_NAKAMA_SCHEME
ENV NAKAMA_CONNECT_SRC=$NAKAMA_CONNECT_SRC
COPY package.json package-lock.json tsconfig.json vite.config.ts ./
COPY src ./src
COPY index.html ./index.html
COPY default.conf.template ./default.conf.template
RUN apk add --no-cache gettext && \
    npm ci && VITE_NAKAMA_SERVER_KEY=$NAKAMA_CLIENT_PUBLIC npm run build && \
    envsubst '${NAKAMA_CONNECT_SRC}' < default.conf.template > default.conf

FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY --from=builder /app/default.conf /etc/nginx/conf.d/default.conf

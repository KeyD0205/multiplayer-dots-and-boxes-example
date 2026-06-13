FROM node:20-alpine AS builder
WORKDIR /app
ARG VITE_NAKAMA_HOST=localhost
ARG VITE_NAKAMA_PORT=7350
ARG VITE_NAKAMA_SCHEME=http
ARG NAKAMA_CLIENT_PUBLIC=defaultkey
ENV VITE_NAKAMA_HOST=$VITE_NAKAMA_HOST
ENV VITE_NAKAMA_PORT=$VITE_NAKAMA_PORT
ENV VITE_NAKAMA_SCHEME=$VITE_NAKAMA_SCHEME
COPY package.json package-lock.json tsconfig.json vite.config.ts ./
COPY src ./src
COPY index.html ./index.html
COPY default.conf ./default.conf
RUN npm ci && VITE_NAKAMA_SERVER_KEY=$NAKAMA_CLIENT_PUBLIC npm run build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY default.conf /etc/nginx/conf.d/default.conf

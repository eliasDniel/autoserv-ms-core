# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssl netcat-openbsd dos2unix

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit --no-fund

COPY . .

COPY docker-entrypoint.sh /usr/local/bin/
RUN dos2unix /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

RUN --mount=type=cache,target=/root/.cache/prisma npx prisma generate

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "start:dev"]

FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser

COPY package.json package-lock.json ./
RUN npm ci
RUN npx cloakbrowser install
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/nohuman-labs/twitee"

RUN apt-get update \
 && npx --yes playwright@1.60.0 install-deps chromium \
 && apt-get install -y --no-install-recommends dumb-init fluxbox novnc websockify x11-utils x11vnc xvfb \
 && rm -rf /var/lib/apt/lists/* /root/.npm /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/yarn

WORKDIR /app
ENV NODE_ENV=production \
    DISPLAY=:99 \
    CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser \
    CLOAKBROWSER_AUTO_UPDATE=false \
    TWITEE_DATA_DIR=/data \
    TWITEE_PROFILE_ROOT=/tmp/twitee-profiles \
    TWITEE_HEADLESS=true \
    TWITEE_HUMANIZE=true

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /opt/cloakbrowser /opt/cloakbrowser
COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/twitee-entrypoint

RUN mkdir -p /data && chown node:node /data && chmod 0755 /usr/local/bin/twitee-entrypoint

USER node
EXPOSE 8080 6080
VOLUME ["/data"]
ENTRYPOINT ["dumb-init", "--", "twitee-entrypoint"]

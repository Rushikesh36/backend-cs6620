# check=skip=InvalidDefaultArgInFrom
# ZAP (DAST) scanner image, Task 21. Build it with scripts/build_scanner_images.sh, which passes
# the pinned versions from scanners/versions.env. Build context: the repo root.
# The version ARGs have no defaults on purpose: versions.env is the one place they are set.
ARG NODE_VERSION
ARG ZAP_VERSION

# 1. Bundle the wrapper.
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY common common
COPY scanners scanners
COPY scripts/package_scanners.mjs scripts/
RUN node scripts/package_scanners.mjs zap

# 2. The image: ZAP (Debian), plus Node.js and the wrapper.
FROM ghcr.io/zaproxy/zaproxy:${ZAP_VERSION}
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app/build/scanners/zap/index.mjs /opt/scanner/index.mjs
USER root
RUN mkdir -p /zap/wrk && chown zap:zap /zap/wrk
USER zap
# zap-full-scan.py downloads the beta scan rules at start-up unless ZAP runs with -silent. The
# scanner has no internet, so install them now; the wrapper always passes -silent.
RUN zap.sh -cmd -addonupdate -addoninstall pscanrulesBeta -addoninstall ascanrulesBeta \
    && node --version
# PYTHONUNBUFFERED: whatever zap-full-scan.py prints reaches the logs straight away, even if the
# scan is stopped at the timeout (otherwise Python holds it back until the script ends).
ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1
WORKDIR /zap/wrk
ENTRYPOINT ["node", "/opt/scanner/index.mjs"]

# check=skip=InvalidDefaultArgInFrom
# Semgrep (SAST) scanner image, Task 21. Build it with scripts/build_scanner_images.sh, which
# passes the pinned versions from scanners/versions.env. Build context: the repo root.
# The version ARGs have no defaults on purpose: versions.env is the one place they are set.
ARG NODE_VERSION
ARG SEMGREP_VERSION

# 1. Bundle the wrapper and download the rule packs (the only step that uses the internet).
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG SEMGREP_RULE_PACKS
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY common common
COPY scanners scanners
COPY scripts/package_scanners.mjs scripts/
RUN node scripts/package_scanners.mjs semgrep
RUN mkdir rules && for pack in ${SEMGREP_RULE_PACKS}; do \
      node -e 'const [p, f] = process.argv.slice(1); fetch("https://semgrep.dev/c/p/" + p).then(async (r) => { if (!r.ok) throw new Error(p + ": HTTP " + r.status); require("fs").writeFileSync(f, await r.text()); });' \
        "$pack" "rules/$pack.yml" || exit 1; \
    done

# 2. Node.js built for Alpine, which the Semgrep image is based on.
FROM node:${NODE_VERSION}-alpine3.22 AS node

# 3. The image: Semgrep, plus Node.js, the wrapper and the rules.
FROM semgrep/semgrep:${SEMGREP_VERSION}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app/rules /opt/semgrep-rules
COPY --from=build /app/build/scanners/semgrep/index.mjs /opt/scanner/index.mjs
RUN adduser -D -u 10001 scanner
# Offline: no metrics, no version check. Semgrep keeps its settings and logs under HOME.
ENV HOME=/home/scanner \
    SEMGREP_SEND_METRICS=off \
    SEMGREP_ENABLE_VERSION_CHECK=0 \
    NODE_ENV=production
USER scanner
WORKDIR /home/scanner
# Fail the build if Node.js does not run here or the rules do not load.
RUN node --version && mkdir -p /tmp/empty \
    && semgrep scan --config /opt/semgrep-rules --metrics off --disable-version-check --quiet /tmp/empty \
    && rm -rf /tmp/empty
ENTRYPOINT ["node", "/opt/scanner/index.mjs"]

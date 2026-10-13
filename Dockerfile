# Image for running `mithril eval` in isolation. Use scripts/eval-docker.sh,
# which applies the hardening flags; see "Running evals in a container" in
# the README.
FROM node:22-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# The image's built-in unprivileged user. The wrapper script overrides the
# uid/gid at run time so files written to the results volume belong to you.
USER node

# The container's root filesystem is read-only at run time; /tmp is a tmpfs.
ENV HOME=/tmp

# `node --import tsx` rather than npx: nothing here needs a writable home.
ENTRYPOINT ["node", "--import", "tsx", "src/index.ts", "eval"]

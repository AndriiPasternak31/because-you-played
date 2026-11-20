# Runs the service where there is Docker and no Node.js 24:   docker compose up --build
# Without the Compose plugin:   docker build -t because-you-played . && docker run --rm --init -p 127.0.0.1:8787:8787 because-you-played
# For running locally. Nothing here deploys anything.
FROM node:24-slim
WORKDIR /app
# npm's notice of a newer npm is a network call and noise; nothing here needs it.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# The dependencies first, so that a change to the code does not install them again.
# npm ci runs the Node.js version check as its `preinstall` step, so that file has to be here.
# npm runs it after the packages are in place, not before.
COPY package.json package-lock.json ./
COPY tools/check-node.cjs tools/
RUN npm ci

# Owned by the unprivileged user, because the evaluation writes its report under eval/results/.
COPY --chown=node:node . .
USER node

EXPOSE 8787
# Inside a container the service has to listen on every interface to be reachable through the published port.
CMD ["node", "src/service/serve.ts", "--host", "0.0.0.0"]

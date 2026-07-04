FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /commons-keeper

COPY package.json .
RUN npm install --omit=dev 2>/dev/null || true

COPY src/ src/
COPY config/github-labels.json config/github-labels.json
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# State and reports persist via volume mount at /commons-keeper/state and /commons-keeper/reports
RUN mkdir -p state reports

ENTRYPOINT ["/entrypoint.sh"]

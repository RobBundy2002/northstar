FROM node:20-bookworm-slim

ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && KUBECTL_VERSION="$(curl -fsSL https://dl.k8s.io/release/stable.txt)" \
  && KUBECTL_ARCH="${TARGETARCH:-amd64}" \
  && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${KUBECTL_ARCH}/kubectl" \
  && chmod +x /usr/local/bin/kubectl \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js start-all.js docker-entrypoint.sh index.html prometheus.yml ./
COPY k8s ./k8s
RUN mkdir -p /app/data && chown -R node:node /app

USER node
ENTRYPOINT ["/app/docker-entrypoint.sh"]

EXPOSE 5173
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:5173/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && mkdir -p /workspace && chown node:node /workspace
COPY --chown=node:node src ./src
COPY --chown=node:node bin ./bin
USER node
ENV NODE_ENV=production
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "bin/cursodex.mjs", "cloud", "--project", "/workspace", "--host", "0.0.0.0", "--port", "8787"]

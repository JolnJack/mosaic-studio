FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /app/data && chown -R node:node /app
COPY --chown=node:node . .
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 DATA_DIR=/app/data LOCAL_WORKSPACE=0
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

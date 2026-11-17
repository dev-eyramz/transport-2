FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
ENV NODE_ENV=production DB=/data/transport.db BACKUP_DIR=/data/backups UPLOAD_DIR=/data/uploads TRUST_PROXY=1 PORT=3000
RUN mkdir /data && chown node /data
USER node
VOLUME /data
HEALTHCHECK CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]

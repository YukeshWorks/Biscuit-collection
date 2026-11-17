FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=1m --timeout=5s CMD wget -qO- http://127.0.0.1:8787/api/session >/dev/null || exit 1
CMD ["node", "server.js"]

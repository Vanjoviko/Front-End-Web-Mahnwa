# Front-end Lembar (Node 20, tanpa dependensi npm). Poppler dibutuhkan untuk merender PDF chapter (fitur upload PDF yang sudah ada).
FROM node:20-alpine

RUN apk add --no-cache poppler-utils
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

# Data (db.json + media) disimpan di volume; di container, server harus bind ke 0.0.0.0.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 LEMBAR_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]

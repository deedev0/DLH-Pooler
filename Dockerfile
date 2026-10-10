FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    DATA_DIR=/app/data

WORKDIR /app

COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public/ ./public/

RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3001

CMD ["node", "server.js"]

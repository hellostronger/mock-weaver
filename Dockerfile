FROM node:20-alpine
WORKDIR /app
COPY server.js package.json ./
COPY public ./public
ENV PORT=9100 \
    DATA_FILE=/app/data/orgs.json
VOLUME ["/app/data"]
EXPOSE 9100
CMD ["node", "server.js"]

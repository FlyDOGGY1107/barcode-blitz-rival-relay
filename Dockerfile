FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY server.js feedback.js ./
ENV PORT=10000
EXPOSE 10000
USER node
CMD ["node", "server.js"]

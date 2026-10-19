FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && npm prune --omit=dev
ENV NODE_ENV=production PORT=8811
EXPOSE 8811
CMD ["node", "dist/index.js"]

FROM mcr.microsoft.com/playwright:v1.57.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]

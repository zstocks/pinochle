FROM node:22-alpine

WORKDIR /app

# Install production deps first (just `ws`) for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "src/server.js"]

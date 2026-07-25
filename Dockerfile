# Railway Dockerfile для extract-archives-aksioma
FROM node:20-slim

# Системные зависимости
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm install --omit=dev

# Копируем исходники
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

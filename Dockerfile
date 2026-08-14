# Railway Dockerfile для extract-archives-aksioma
FROM node:20-slim

# Системные зависимости
# unzip — для .zip, p7zip-full — для .7z (и частично .rar)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    unzip \
    p7zip-full \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Официальный unrar от RARLAB — поддерживает ВСЕ rar5/rar4 (включая зашифрованные)
ARG UNRAR_VERSION=7.1.10
RUN curl -L -o /tmp/unrar.deb \
    https://www.rarlab.com/rar/unrarlinux-x64-${UNRAR_VERSION}.deb \
    && dpkg -i /tmp/unrar.deb \
    && rm /tmp/unrar.deb \
    && unrar | head -1

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm install --omit=dev

# Копируем исходники
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

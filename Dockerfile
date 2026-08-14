# Railway Dockerfile для extract-archives-aksioma
FROM node:20-slim

# Локали с UTF-8 (нужно для архивов с кириллическими именами)
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV LANGUAGE=C.UTF-8

# Системные зависимости
# unzip — для .zip, p7zip-full — для .7z (и частично .rar), locales — для UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    unzip \
    p7zip-full \
    curl \
    locales \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
    && locale-gen

# Официальный unrar от RARLAB — поддерживает ВСЕ rar5/rar4 (включая зашифрованные)
RUN curl -L -o /tmp/unrar.deb \
    https://www.rarlab.com/rar/unrar_5.2.5-0.1_amd64.deb \
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

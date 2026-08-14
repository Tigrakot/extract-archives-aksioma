# Extract Archives АКСИОМА (Railway)

Бот для распаковки архивов с фото из поля `u_Attachments` в `u_photo2_source`.

## Поддерживаемые форматы

- **.zip** — через `unzip` (с фоллбэком на JSZip если утилита недоступна)
- **.7z** — через `7z` (p7zip-full)
- **.rar** — через `unrar` (unrar-free)

## Что делает

1. Сотрудник получает задачу с архивами в поле «Документы от СК» (`u_Attachments`)
2. Бот автоматически находит архивы .zip / .7z / .rar
3. Распаковывает их системными утилитами
4. Загружает найденные фото (jpg/png/webp/heic/tiff) в поле «Фото осмотра» (`u_photo2_source`)
5. Архивы остаются на месте (не удаляются)
6. Дедупликация по имени файла — одинаковые фото из разных архивов не дублируются

## Endpoints

- `GET  /` — health
- `GET  /health` — health check
- `POST /api/extract-archives` `{ "task_id": 368399727 }` — ручной запуск
- `POST /api/pyrus-webhook` — webhook от Pyrus (event: comment.added)

## Env vars (Railway Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `PYRUS_BOT_LOGIN` | — | Pyrus API login (bot email) |
| `PYRUS_BOT_KEY` | — | Pyrus security key |
| `PORT` | 3000 | Server port |
| `MAX_TASK_AGE_DAYS` | 30 | Skip tasks older than N days |

## Deploy

```bash
# Push to GitHub
git push origin main

# Railway auto-detects Dockerfile and deploys
```

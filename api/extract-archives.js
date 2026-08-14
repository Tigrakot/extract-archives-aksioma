/**
 * Распаковка архивов из u_Attachments → фото в u_photo2_source
 *
 * POST /api/extract-archives
 * { task_id: 368399727 }
 *
 * Логика:
 * 1. Берём задачу
 * 2. Ищем архивы (.zip/.7z/.rar) в u_Attachments
 * 3. Скачиваем каждый
 * 4. Распаковываем
 * 5. Берём только картинки (jpg, jpeg, png, heic)
 * 6. Загружаем в u_photo2_source (через Pyrus upload + field_update)
 * 7. Архивы НЕ удаляем (как просил)
 */

import JSZip from 'jszip';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readdir, stat, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pyrusRequest, downloadPyrusFile, uploadPyrusFile } from './_pyrus.js';

const execFileAsync = promisify(execFile);

const ARCHIVE_EXTENSIONS = /\.(zip|7z|rar)$/i;
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif|tiff?)$/i;

// Лимиты
const MAX_UNPACKED_SIZE = 500 * 1024 * 1024; // 500 МБ
const MAX_FILE_COUNT = 500;

/**
 * Распаковка через системные утилиты (для 7z, rar и надёжного zip)
 * Возвращает массив { name, buffer }
 */
async function extractWithSystem(archiveBuffer, archiveName) {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'extract-'));
  const archivePath = join(tmpRoot, archiveName);
  const extractDir = join(tmpRoot, 'out');

  // Пишем архив на диск
  const { writeFile } = await import('fs/promises');
  await writeFile(archivePath, archiveBuffer);

  try {
    // Выбираем команду по расширению
    if (/\.zip$/i.test(archiveName)) {
      // -o: overwrite, -d: destination
      await execFileAsync('unzip', ['-o', '-q', archivePath, '-d', extractDir], { timeout: 60000 });
    } else if (/\.7z$/i.test(archiveName)) {
      // 7z x: extract with full paths, -o: destination, -y: yes to all
      await execFileAsync('7z', ['x', archivePath, `-o${extractDir}`, '-y', '-bb0'], { timeout: 120000 });
    } else if (/\.rar$/i.test(archiveName)) {
      // 7z умеет и RAR (включая RAR5), unrar-free не всегда работает с RAR5
      try {
        await execFileAsync('7z', ['x', archivePath, `-o${extractDir}`, '-y', '-bb0'], { timeout: 120000 });
      } catch (e) {
        // Если 7z не справился — пробуем unrar (если установлен)
        console.warn(`[EXTRACT] 7z failed for ${archiveName}: ${e.message}. Trying unrar...`);
        await execFileAsync('unrar', ['x', '-o+', '-idq', archivePath, extractDir + '/'], { timeout: 120000 });
      }
    } else {
      throw new Error(`Unsupported archive: ${archiveName}`);
    }

    // Проверяем что что-то распаковалось
    let allFiles = [];
    async function listAll(dir) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            await listAll(join(dir, e.name));
          } else {
            allFiles.push(e.name);
          }
        }
      } catch (e) {
        // Директория не создана — архив пустой или распаковка молча упала
      }
    }
    await listAll(extractDir);
    if (allFiles.length === 0) {
      throw new Error(`Archive extracted but directory is empty (archive may be corrupt or empty)`);
    }
    console.log(`[EXTRACT] ${archiveName}: found ${allFiles.length} files inside, sample: ${allFiles.slice(0, 5).join(', ')}`);

    // Рекурсивно собираем файлы
    const results = [];
    let totalSize = 0;

    async function walk(dir, prefix = '') {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(dir, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(full, rel);
        } else if (e.isFile()) {
          if (!IMAGE_EXTENSIONS.test(e.name)) continue;
          if (results.length >= MAX_FILE_COUNT) return;
          const st = await stat(full);
          totalSize += st.size;
          if (totalSize > MAX_UNPACKED_SIZE) return;
          const { readFile } = await import('fs/promises');
          const buf = await readFile(full);
          results.push({ name: e.name, buffer: buf });
        }
      }
    }

    await walk(extractDir);
    return results;
  } finally {
    // Чистим временные файлы
    try { await rm(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', service: 'extract-archives-aksioma' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  const { task_id: taskId } = req.body || {};

  if (!taskId) {
    return res.status(400).json({ error: 'No task_id' });
  }

  try {
    console.log(`[EXTRACT] task=${taskId} start`);

    // 1. Получаем задачу
    const taskRes = await pyrusRequest(`/tasks/${taskId}`);
    if (taskRes.error || !taskRes.task) {
      return res.status(403).json({ error: taskRes.error || 'No access to task' });
    }
    const task = taskRes.task;

    // Защита: не трогаем старые задачи
    const MAX_TASK_AGE_DAYS = parseInt(process.env.MAX_TASK_AGE_DAYS || '30', 10);
    const createDate = new Date(task.create_date);
    const ageDays = (Date.now() - createDate.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > MAX_TASK_AGE_DAYS) {
      console.log(`[EXTRACT] task=${taskId} too old (${ageDays.toFixed(1)} days), skip`);
      return res.status(200).json({ skipped: 'too old', age_days: ageDays.toFixed(1) });
    }

    // 2. Ищем поле u_Attachments
    const attachmentsField = (task.fields || []).find(f => f.code === 'u_Attachments');
    if (!attachmentsField) {
      return res.status(200).json({ skipped: 'no u_Attachments field' });
    }
    const files = attachmentsField.value || [];
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(200).json({ skipped: 'no files in u_Attachments' });
    }

    // 3. Фильтруем только архивы
    const archives = files.filter(f => f.name && ARCHIVE_EXTENSIONS.test(f.name));
    if (archives.length === 0) {
      return res.status(200).json({ skipped: 'no archives' });
    }

    console.log(`[EXTRACT] task=${taskId} found ${archives.length} archive(s): ${archives.map(a => a.name).join(', ')}`);

    // 4. Скачиваем и распаковываем каждый архив
    const allImages = [];

    for (const archive of archives) {
      console.log(`[EXTRACT] task=${taskId} downloading ${archive.name} (${(archive.size / 1024 / 1024).toFixed(2)} МБ)...`);
      try {
        const archiveBuffer = await downloadPyrusFile(archive.id);
        console.log(`[EXTRACT] task=${taskId} ${archive.name} downloaded, unpacking...`);

        if (/\.(zip|7z|rar)$/i.test(archive.name)) {
          // Все архивы идут через системные утилиты (7z, unzip, unrar)
          let extracted;
          try {
            extracted = await extractWithSystem(archiveBuffer, archive.name);
          } catch (e) {
            // Если системная утилита не найдена — фоллбэк на JSZip для .zip
            if (/\.zip$/i.test(archive.name) && /ENOENT|not found/i.test(e.message || '')) {
              console.warn(`[EXTRACT] task=${taskId} unzip not found, falling back to JSZip for ${archive.name}`);
              const zip = await JSZip.loadAsync(archiveBuffer);
              extracted = [];
              let totalSize = 0;
              for (const [filename, entry] of Object.entries(zip.files)) {
                if (entry.dir) continue;
                if (!IMAGE_EXTENSIONS.test(filename)) continue;
                if (extracted.length >= MAX_FILE_COUNT) break;
                const content = await entry.async('nodebuffer');
                totalSize += content.length;
                if (totalSize > MAX_UNPACKED_SIZE) break;
                extracted.push({ name: filename.split('/').pop(), buffer: content });
              }
            } else {
              throw e;
            }
          }

          // Дедупликация по имени (если одинаковые файлы в разных архивах)
          let addedFromThis = 0;
          for (const img of extracted) {
            if (allImages.length >= MAX_FILE_COUNT) {
              console.warn(`[EXTRACT] task=${taskId} hit MAX_FILE_COUNT, stopping`);
              break;
            }
            // Проверяем что такого имени ещё нет
            if (allImages.some(x => x.name === img.name)) {
              console.log(`[EXTRACT] task=${taskId} skip duplicate: ${img.name}`);
              continue;
            }
            allImages.push(img);
            addedFromThis++;
          }
          console.log(`[EXTRACT] task=${taskId} ${archive.name}: extracted ${extracted.length}, added ${addedFromThis} images`);
        } else {
          console.warn(`[EXTRACT] task=${taskId} ${archive.name}: unknown archive format, skipping`);
        }
      } catch (err) {
        console.error(`[EXTRACT] task=${taskId} failed to process ${archive.name}:`, err.message);
        // Помечаем архив как проблемный — будет упомянут в комментарии
        if (err.code === 'ENOENT') {
          const ext = archive.name.match(/\.(\w+)$/)?.[1] || '?';
          archive.unsupported = ext;
        } else {
          archive.error = err.message;
        }
      }
    }

    // Сохраняем список всех файлов из архивов для диагностики
    if (allImages.length === 0) {
      // Собираем имена файлов которые БЫ распаковались, если бы прошли по регексу
      console.log(`[EXTRACT] task=${taskId} no images extracted. Summary so far: ${JSON.stringify(archives.map(a => ({name: a.name, error: a.error, unsupported: a.unsupported})))}`);
    }

    if (allImages.length === 0) {
      console.log(`[EXTRACT] task=${taskId} no images extracted`);
      // Пишем комментарий чтобы юзер видел что произошло
      // Разделяем причины: неподдерживаемый формат vs реально пустой архив
      const unsupported = archives.filter(a => a.unsupported);
      const supported = archives.filter(a => !a.unsupported);

      let commentText;
      if (unsupported.length > 0 && supported.length === 0) {
        // Все архивы — неподдерживаемые форматы (системная утилита не найдена)
        const exts = [...new Set(unsupported.map(a => a.unsupported))].join('/');
        commentText = `⚠️ Нашёл ${unsupported.length} архив(ов) в формате .${exts}, но на сервере не установлена утилита для распаковки.\n` +
                      `Архивы: ${unsupported.map(a => a.name).join(', ')}\n` +
                      `Пережмите, пожалуйста, в .zip — бот их точно распакует.`;
      } else if (unsupported.length > 0) {
        // Смесь: есть и неподдерживаемые, и пустые
        commentText = `ℹ️ Нашёл ${archives.length} архив(ов) в «Документы от СК»:\n` +
                      `• Неподдерживаемые форматы (${unsupported.length}): ${unsupported.map(a => a.name).join(', ')}\n` +
                      `• Без картинок (${supported.length}): ${supported.map(a => a.name).join(', ')}`;
      } else {
        // Только .zip — реально пустые или не картинки внутри
        const withErrors = archives.filter(a => a.error);
        if (withErrors.length > 0) {
          commentText = `⚠️ Не удалось распаковать ${withErrors.length} архив(ов):\n` +
                        withErrors.map(a => `• ${a.name}: ${a.error}`).join('\n');
        } else {
          commentText = `ℹ️ Нашёл ${archives.length} архив(ов) в «Документы от СК», но внутри нет картинок (jpg/png/heic).\n` +
                        `Архивы: ${archives.map(a => a.name).join(', ')}`;
        }
      }

      try {
        await pyrusRequest(`/tasks/${taskId}/comments`, {
          method: 'POST',
          body: JSON.stringify({ text: commentText }),
        });
      } catch (e) {}
      return res.status(200).json({
        success: true,
        task_id: taskId,
        archives_processed: archives.length,
        images_extracted: 0,
      });
    }

    // 5. Пишем прогресс-комментарий
    try {
      await pyrusRequest(`/tasks/${taskId}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          text: `📦 Распаковал ${archives.length} архив(ов): ${allImages.length} фото\n⏳ Загружаю в «Фото осмотра»...`,
        }),
      });
    } catch (e) {}

    // 6. Загружаем каждое фото в Pyrus (получаем attachment_id)
    console.log(`[EXTRACT] task=${taskId} uploading ${allImages.length} images to Pyrus...`);
    const attachmentIds = [];
    for (let i = 0; i < allImages.length; i++) {
      const img = allImages[i];
      try {
        // Timeout 30 сек на каждый файл
        const uploadPromise = uploadPyrusFile(img.name, img.buffer);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Upload timeout 30s')), 30000)
        );
        const uploaded = await Promise.race([uploadPromise, timeoutPromise]);
        attachmentIds.push(uploaded.id);
        if ((i + 1) % 10 === 0 || i === allImages.length - 1) {
          console.log(`[EXTRACT] task=${taskId} uploaded ${i + 1}/${allImages.length} (${img.name})`);
        }
      } catch (err) {
        console.error(`[EXTRACT] task=${taskId} failed to upload ${img.name}:`, err.message);
        // Не падаем — пропускаем проблемный файл
      }
    }
    console.log(`[EXTRACT] task=${taskId} upload done: ${attachmentIds.length}/${allImages.length} succeeded`);

    if (attachmentIds.length === 0) {
      return res.status(500).json({ error: 'All uploads failed' });
    }

    // 7. Привязываем к полю u_photo2_source
    // Pyrus API требует сначала прикрепить файлы к комменту (attachments = [guid1, guid2, ...])
    // потом использовать полученные attachment_id в field_updates
    let realAttachmentIds = [];
    try {
      // Шаг 1: прикрепляем файлы к "техническому" комменту (attachmentIds уже = guids)
      // text: ' ' (пробел) — Pyrus требует непустой text, но визуально невидимо
      const attachResult = await pyrusRequest(`/tasks/${taskId}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          text: ' ',  // пробел — минимально видимый, чтобы не мозолил глаза
          attachments: attachmentIds,  // массив guid строк
        }),
      });
      console.log(`[EXTRACT] task=${taskId} attached ${attachmentIds.length} files to comment`);

      // Шаг 2: перечитываем задачу чтобы получить реальные attachment_id
      const freshTaskRes = await pyrusRequest(`/tasks/${taskId}`);
      const freshTask = freshTaskRes.task || freshTaskRes;
      const comments = freshTask.comments || [];

      // Берём последний комментарий (наш технический) и его attachments
      if (comments.length > 0) {
        const lastComment = comments[comments.length - 1];
        if (lastComment && lastComment.attachments) {
          // Берём id'шники только что прикреплённых файлов
          // guid'ы могут не совпадать напрямую, берём по имени или просто последние N
          realAttachmentIds = lastComment.attachments
            .map(a => a.id)
            .filter(id => id); // truthy
          console.log(`[EXTRACT] task=${taskId} got ${realAttachmentIds.length} attachment_ids from last comment`);
        }
      }
    } catch (e) {
      console.error(`[EXTRACT] task=${taskId} attach to comment failed:`, e.message);
    }

    if (realAttachmentIds.length > 0) {
      await pyrusRequest(`/tasks/${taskId}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          text: '',
          field_updates: [
            { code: 'u_photo2_source', value: realAttachmentIds.map(id => ({ attachment_id: id })) },
          ],
        }),
      });
      console.log(`[EXTRACT] task=${taskId} field updated: ${realAttachmentIds.length} photos → u_photo2_source`);
    } else {
      console.error(`[EXTRACT] task=${taskId} no real attachment_ids, skipping field update`);
    }

    // 8. Финальный комментарий
    await pyrusRequest(`/tasks/${taskId}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        text: `✅ Готово! ${attachmentIds.length} фото загружено в «Фото осмотра».\n` +
              `📦 Архивы: ${archives.map(a => a.name).join(', ')}\n` +
              `📂 Исходные архивы оставлены в «Документы от СК».\n` +
              `⏱ Время: ${((Date.now() - startTime) / 1000).toFixed(1)} сек`,
      }),
    });

    console.log(`[EXTRACT] task=${taskId} done in ${Date.now() - startTime}ms, ${attachmentIds.length} images uploaded`);

    return res.status(200).json({
      success: true,
      task_id: taskId,
      archives_processed: archives.length,
      images_extracted: allImages.length,
      images_uploaded: attachmentIds.length,
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    console.error('[EXTRACT ERROR]', error);
    return res.status(500).json({ error: error.message });
  }
}

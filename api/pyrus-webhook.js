/**
 * Webhook от Pyrus → автоматически распаковывать архивы в u_Attachments
 *
 * Pyrus шлёт:
 * POST { event: "comment.added", task_id, ... }
 *
 * Логика: если у задачи в u_Attachments есть .zip/.7z/.rar архивы
 * → запускаем распаковку.
 */

import { pyrusRequest } from './_pyrus.js';

const ARCHIVE_EXTENSIONS = /\.(zip|7z|rar)$/i;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', service: 'pyrus-webhook' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const data = req.body || {};
  const taskId = data.task_id || data.id;
  const event = data.event;

  console.log(`[WEBHOOK] event=${event} task=${taskId}`);

  if (!taskId) {
    return res.status(400).json({ error: 'No task_id' });
  }

  try {
    // Получаем задачу
    const taskRes = await pyrusRequest(`/tasks/${taskId}`);
    if (taskRes.error || !taskRes.task) {
      console.warn(`[WEBHOOK] no access to task ${taskId}:`, taskRes.error);
      return res.status(200).json({ skipped: 'no access' });
    }

    const task = taskRes.task;

    // Защита от старых задач
    const MAX_TASK_AGE_DAYS = parseInt(process.env.MAX_TASK_AGE_DAYS || '30', 10);
    const createDate = new Date(task.create_date);
    const ageDays = (Date.now() - createDate.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > MAX_TASK_AGE_DAYS) {
      console.log(`[WEBHOOK] task=${taskId} too old (${ageDays.toFixed(1)} days), skip`);
      return res.status(200).json({ skipped: 'too old' });
    }

    // Ищем u_Attachments
    const attachmentsField = (task.fields || []).find(f => f.code === 'u_Attachments');
    if (!attachmentsField) {
      return res.status(200).json({ skipped: 'no u_Attachments field' });
    }
    const files = attachmentsField.value || [];
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(200).json({ skipped: 'no files' });
    }

    // Есть ли архивы?
    const archives = files.filter(f => f.name && ARCHIVE_EXTENSIONS.test(f.name));
    if (archives.length === 0) {
      console.log(`[WEBHOOK] task=${taskId} no archives, skip`);
      return res.status(200).json({ skipped: 'no archives' });
    }

    // Проверяем: в u_photo2_source уже есть фото? (защита от двойной обработки)
    const photoField = (task.fields || []).find(f => f.code === 'u_photo2_source');
    const existingPhotos = photoField?.value;
    if (existingPhotos && Array.isArray(existingPhotos) && existingPhotos.length > 0) {
      console.log(`[WEBHOOK] task=${taskId} u_photo2_source already has ${existingPhotos.length} photos, skip`);
      return res.status(200).json({ skipped: 'u_photo2_source not empty' });
    }

    console.log(`[WEBHOOK] task=${taskId} starting extract (${archives.length} archives)`);

    // Запускаем асинхронно (Pyrus ждёт ответ 60 сек)
    extractAsync(taskId).catch(err => {
      console.error(`[WEBHOOK] extract FAILED for task ${taskId}:`, err);
    });

    return res.status(200).json({ accepted: true, task_id: taskId });
  } catch (error) {
    console.error('[WEBHOOK ERROR]', error);
    return res.status(500).json({ error: error.message });
  }
}

async function extractAsync(taskId) {
  const { default: extractHandler } = await import('./extract-archives.js');

  const mockReq = {
    method: 'POST',
    body: { task_id: taskId },
  };

  const mockRes = {
    status: (code) => ({
      json: (data) => {
        console.log(`[WEBHOOK] extract result for task ${taskId}:`, code, JSON.stringify(data).substring(0, 300));
        return mockRes;
      },
    }),
    json: (data) => {
      console.log(`[WEBHOOK] extract result for task ${taskId}:`, JSON.stringify(data).substring(0, 300));
      return mockRes;
    },
  };

  await extractHandler(mockReq, mockRes);
}

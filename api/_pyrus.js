/**
 * Pyrus API helpers
 */

const PYRUS_LOGIN = process.env.PYRUS_BOT_LOGIN;
const PYRUS_SECURITY_KEY = process.env.PYRUS_BOT_KEY;
const PYRUS_API_BASE = 'https://api.pyrus.com/v4';

let _token = null;
let _tokenExpires = 0;

/**
 * Получить/обновить токен Pyrus (живёт ~1 час)
 */
export async function getPyrusToken() {
  if (_token && Date.now() < _tokenExpires) {
    return _token;
  }

  const response = await fetch('https://accounts.pyrus.com/api/v4/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      login: PYRUS_LOGIN,
      security_key: PYRUS_SECURITY_KEY,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pyrus auth failed: ${response.status} ${text.substring(0, 200)}`);
  }

  const data = await response.json();
  _token = data.access_token;
  _tokenExpires = Date.now() + 50 * 60 * 1000; // 50 минут
  console.log('[PYRUS] token refreshed, valid for 50 min');
  return _token;
}

/**
 * Универсальный запрос к Pyrus API
 */
export async function pyrusRequest(path, options = {}) {
  const token = await getPyrusToken();
  const response = await fetch(`${PYRUS_API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pyrus API ${response.status} on ${path}: ${text.substring(0, 300)}`);
  }

  return await response.json();
}

/**
 * Скачать файл Pyrus по id
 */
export async function downloadPyrusFile(fileId) {
  const token = await getPyrusToken();
  const response = await fetch(`${PYRUS_API_BASE}/files/download/${fileId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const arrayBuf = await response.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Залить файл в Pyrus (multipart/form-data)
 */
export async function uploadPyrusFile(filename, content) {
  const token = await getPyrusToken();
  const boundary = '----formdata' + Math.random().toString(36);

  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

  const body = Buffer.concat([header, content, footer]);

  const response = await fetch(`${PYRUS_API_BASE}/files/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed: ${response.status} ${text.substring(0, 200)}`);
  }

  const data = await response.json();
  return { id: data.id, name: data.name || filename, size: data.size || content.length };
}

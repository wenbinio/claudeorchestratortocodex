import { randomBytes } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_RETRY_MS = 25;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const REVIEW_VERDICTS = new Set(['approve', 'needs_work', 'reject']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStorePath(storePath) {
  if (typeof storePath !== 'string' || storePath.trim() === '') {
    throw new TypeError('path must be a non-empty string');
  }
  if (storePath.includes('\0')) {
    throw new TypeError('path must not contain NUL');
  }
  return resolve(storePath);
}

function requireString(name, value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string without NUL`);
  }
}

function requireBoolean(name, value) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean`);
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function removeIfStale(lockPath) {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs <= LOCK_STALE_MS) {
      return false;
    }
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw error;
      }
      return handle;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      if (await removeIfStale(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        const lockError = new Error(`timed out waiting for verdict-store lock: ${lockPath}`);
        lockError.code = 'ELOCKTIMEOUT';
        throw lockError;
      }

      const jitter = randomBytes(1)[0] % LOCK_RETRY_MS;
      await delay(LOCK_RETRY_MS + jitter);
    }
  }
}

async function withLock(lockPath, operation) {
  const handle = await acquireLock(lockPath);
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch((error) => {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, 'r');
    await handle.sync();
  } catch (error) {
    // Directory fsync is unavailable on some platforms/filesystems. The data
    // file itself has already been fsynced before the atomic rename.
    if (!['EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWriteJson(storePath, value) {
  const directoryPath = dirname(storePath);
  const tempPath = resolve(
    directoryPath,
    `.${basename(storePath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let tempHandle;
  let renamed = false;

  try {
    tempHandle = await open(tempPath, 'wx', 0o600);
    await tempHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;

    await rename(tempPath, storePath);
    renamed = true;
    await syncDirectory(directoryPath);
  } finally {
    await tempHandle?.close().catch(() => {});
    if (!renamed) {
      await unlink(tempPath).catch((error) => {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  }
}

export async function readStore(storePath) {
  const normalizedPath = normalizeStorePath(storePath);
  let contents;
  try {
    contents = await readFile(normalizedPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(contents.replace(/^\uFEFF/, ''));
  } catch (cause) {
    throw new SyntaxError(`invalid verdict store JSON at ${normalizedPath}`, { cause });
  }
  if (!isRecord(parsed)) {
    throw new TypeError(`verdict store root must be an object: ${normalizedPath}`);
  }

  return parsed;
}

export async function writeVerdict(
  storePath,
  {
    repoKey,
    branch,
    sha,
    reviewVerdict,
    driverVerifyPassed,
    reviewVerifyPassed,
    allowUnverified,
  } = {},
) {
  const normalizedPath = normalizeStorePath(storePath);
  requireString('repoKey', repoKey);
  requireString('branch', branch);
  requireString('sha', sha);
  requireString('reviewVerdict', reviewVerdict);
  requireBoolean('driverVerifyPassed', driverVerifyPassed);
  requireBoolean('reviewVerifyPassed', reviewVerifyPassed);
  requireBoolean('allowUnverified', allowUnverified);

  if (!/^codex\/[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new TypeError('branch must be a codex/* branch name');
  }
  if (!SHA_PATTERN.test(sha)) {
    throw new TypeError('sha must be a 40- or 64-character hexadecimal object id');
  }
  if (!REVIEW_VERDICTS.has(reviewVerdict)) {
    throw new TypeError('reviewVerdict must be approve, needs_work, or reject');
  }

  const eligible = reviewVerdict === 'approve'
    && (reviewVerifyPassed || (allowUnverified && driverVerifyPassed));
  const entry = {
    sha,
    verdict: reviewVerdict,
    reviewVerdict,
    driverVerifyPassed,
    reviewVerifyPassed,
    allowUnverified,
    eligible,
  };

  await mkdir(dirname(normalizedPath), { recursive: true });
  return withLock(`${normalizedPath}.lock`, async () => {
    const store = await readStore(normalizedPath);
    const currentRepoEntry = store[repoKey];
    if (currentRepoEntry !== undefined && !isRecord(currentRepoEntry)) {
      throw new TypeError(`verdict store repo entry must be an object: ${repoKey}`);
    }

    const nextStore = {
      ...store,
      [repoKey]: {
        ...(currentRepoEntry ?? {}),
        [branch]: entry,
      },
    };
    await atomicWriteJson(normalizedPath, nextStore);
    return entry;
  });
}

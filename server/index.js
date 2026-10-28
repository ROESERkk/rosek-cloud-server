
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const TMP = '/tmp/rosek';

const MAX_MB = Math.min(100, Math.max(1, Number(process.env.MAX_UPLOAD_MB || 50)));
const RETENTION_MINUTES = Math.max(1, Number(process.env.RETENTION_MINUTES || 10));
const JOB_TIMEOUT_MS = Math.max(60_000, Number(process.env.JOB_TIMEOUT_MS || 30 * 60_000));
const MAX_CONCURRENT = Math.max(1, Math.min(2, Number(process.env.MAX_CONCURRENT_JOBS || 1)));

const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

const allowedExtensions = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi'
]);

const jobs = new Map();
let activeJobs = 0;

await fs.mkdir(TMP, { recursive: true });

app.disable('x-powered-by');

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origen no permitido.'));
  }
}));

app.use(express.json({ limit: '16kb' }));

function safeJobId(id) {
  return /^[0-9a-f-]{36}$/i.test(id);
}

function reserveSlot(req, res, next) {
  if (activeJobs >= MAX_CONCURRENT) {
    return res.status(429).json({
      error: 'El servidor está ocupado. Intentá nuevamente más tarde.'
    });
  }

  activeJobs++;
  req.rosekSlotReserved = true;
  next();
}

function releaseSlot(req) {
  if (req.rosekSlotReserved) {
    req.rosekSlotReserved = false;
    activeJobs = Math.max(0, activeJobs - 1);
  }
}

const upload = multer({
  dest: TMP,
  limits: {
    fileSize: MAX_MB * 1024 * 1024,
    files: 1,
    fields: 5,
    fieldSize: 1024
  },
  fileFilter(_req, file, callback) {
    const extension = path.extname(file.originalname || '').toLowerCase();

    if (!allowedExtensions.has(extension)) {
      return callback(new Error(
        'Formato no admitido. Usá MP4, MOV, MKV, WebM, M4V o AVI.'
      ));
    }

    callback(null, true);
  }
});

async function removeFile(filePath) {
  if (!filePath) return;
  await fs.rm(filePath, { force: true }).catch(() => {});
}

function cleanExpiredJobs() {
  const now = Date.now();

  for (const [id, job] of jobs) {
    if (
      job.expiresAt &&
      now >= job.expiresAt &&
      job.status !== 'processing' &&
      job.downloads === 0
    ) {
      jobs.delete(id);
      void removeFile(job.inputPath);
      void removeFile(job.outputPath);
    }
  }
}

const cleanupTimer = setInterval(cleanExpiredJobs, 15_000);
cleanupTimer.unref();

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'rosek-cloud-server',
    activeJobs,
    maxConcurrentJobs: MAX_CONCURRENT
  });
});

app.post(
  '/api/convert',
  reserveSlot,
  upload.single('video'),
  async (req, res) => {
    if (!req.file) {
      releaseSlot(req);
      return res.status(400).json({
        error: 'Falta el archivo de video en el campo "video".'
      });
    }

    const fps = String(req.body.fps || 'source');
    const quality = String(req.body.quality || '20');
    const size = String(req.body.size || 'source');
    const audio = String(req.body.audio ?? 'true') !== 'false';

    const validFps = ['source', '30', '60', '120'];
    const validQuality = ['16', '18', '20', '23', '26'];
    const validSizes = [
      'source',
      '1920x1080',
      '1080x1920',
      '3840x2160',
      '2160x3840'
    ];

    if (
      !validFps.includes(fps) ||
      !validQuality.includes(quality) ||
      !validSizes.includes(size)
    ) {
      await removeFile(req.file.path);
      releaseSlot(req);
      return res.status(400).json({
        error: 'Configuración de conversión no válida.'
      });
    }

    const id = randomUUID();
    const outputPath = path.join(TMP, `${id}.mp4`);

    const job = {
      id,
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
      inputPath: req.file.path,
      outputPath,
      originalName: path.basename(req.file.originalname || 'video').slice(0, 100),
      expiresAt: null,
      error: null,
      downloads: 0
    };

    jobs.set(id, job);

    res.status(202).json({
      id,
      status: 'queued',
      statusUrl: `/api/jobs/${id}`,
      downloadUrl: `/api/jobs/${id}/download`
    });

    job.status = 'processing';

    try {
      await convertVideo(job, { fps, quality, size, audio });

      const stat = await fs.stat(outputPath);
      job.status = 'completed';
      job.progress = 100;
      job.outputSize = stat.size;
      job.expiresAt = Date.now() + RETENTION_MINUTES * 60_000;
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || 'La conversión falló.').slice(0, 800);
      job.expiresAt = Date.now() + 60_000;
      await removeFile(outputPath);
    } finally {
      await removeFile(job.inputPath);
      job.inputPath = null;
      releaseSlot(req);
    }
  }
);

async function convertVideo(job, options) {
  const { fps, quality, size, audio } = options;

  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i', job.inputPath,
    '-map', '0:v:0'
  ];

  if (audio) args.push('-map', '0:a?');

  args.push(
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', quality,
    '-pix_fmt', 'yuv420p'
  );

  if (fps !== 'source') args.push('-r', fps);

  if (size !== 'source') {
    const [width, height] = size.split('x').map(Number);

    args.push(
      '-vf',
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
    );
  }

  if (audio) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }

  args.push(
    '-progress', 'pipe:2',
    '-nostats',
    '-movflags', '+faststart',
    job.outputPath
  );

  await new Promise((resolve, reject) => {
    let stderr = '';
    let durationSeconds = 0;
    let settled = false;
    let timedOut = false;

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, JOB_TIMEOUT_MS);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    }

    proc.stderr.setEncoding('utf8');

    proc.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-12_000);

      const durationMatch = stderr.match(
        /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/
      );

      if (durationMatch) {
        durationSeconds =
          Number(durationMatch[1]) * 3600 +
          Number(durationMatch[2]) * 60 +
          Number(durationMatch[3]);
      }

      const timeMatches = chunk.match(
        /out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g
      );

      if (timeMatches && durationSeconds > 0) {
        const last = timeMatches[timeMatches.length - 1].match(
          /out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/
        );

        if (last) {
          const seconds =
            Number(last[1]) * 3600 +
            Number(last[2]) * 60 +
            Number(last[3]);

          job.progress = Math.min(
            99,
            Math.max(job.progress, Math.floor(seconds / durationSeconds * 100))
          );
        }
      }
    });

    proc.on('error', error => finish(error));

    proc.on('close', code => {
      if (timedOut) {
        finish(new Error('La conversión superó el tiempo máximo permitido.'));
      } else if (code === 0) {
        finish();
      } else {
        finish(new Error(
          stderr.slice(-1000) || `FFmpeg terminó con código ${code}.`
        ));
      }
    });
  });
}

app.get('/api/jobs/:id', (req, res) => {
  if (!safeJobId(req.params.id)) {
    return res.status(400).json({ error: 'ID no válido.' });
  }

  const job = jobs.get(req.params.id);

  if (!job || (job.expiresAt && Date.now() >= job.expiresAt)) {
    return res.status(404).json({
      error: 'Trabajo no encontrado o vencido.'
    });
  }

  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    outputSize: job.outputSize || null,
    error: job.error,
    expiresAt: job.expiresAt,
    remainingMs: job.expiresAt
      ? Math.max(0, job.expiresAt - Date.now())
      : null,
    downloadUrl: job.status === 'completed'
      ? `/api/jobs/${job.id}/download`
      : null
  });
});

app.get('/api/jobs/:id/download', async (req, res) => {
  if (!safeJobId(req.params.id)) {
    return res.status(400).json({ error: 'ID no válido.' });
  }

  const job = jobs.get(req.params.id);

  if (
    !job ||
    job.status !== 'completed' ||
    (job.expiresAt && Date.now() >= job.expiresAt)
  ) {
    return res.status(404).json({
      error: 'El archivo no está disponible o ya venció.'
    });
  }

  try {
    await fs.access(job.outputPath);
  } catch {
    return res.status(404).json({
      error: 'El archivo ya no está disponible.'
    });
  }

  job.downloads++;

  res.download(
    job.outputPath,
    `${path.parse(job.originalName).name}_ROSEK.mp4`,
    error => {
      job.downloads = Math.max(0, job.downloads - 1);

      if (error && !res.headersSent) {
        res.status(500).end('No se pudo enviar el archivo.');
      }
    }
  );
});

app.use((error, req, res, _next) => {
  releaseSlot(req);

  if (req.file?.path) {
    void removeFile(req.file.path);
  }

  const tooLarge =
    error instanceof multer.MulterError &&
    error.code === 'LIMIT_FILE_SIZE';

  const status = tooLarge ? 413 : 400;

  if (!res.headersSent) {
    res.status(status).json({
      error: tooLarge
        ? `El archivo supera el límite de ${MAX_MB} MB.`
        : (error.message || 'Solicitud no válida.')
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ROSEK Cloud Server escuchando en puerto ${PORT}`);
});

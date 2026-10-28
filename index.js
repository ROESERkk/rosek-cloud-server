import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const TMP = '/tmp/rosek';
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const RETENTION_MS = Number(process.env.RETENTION_MINUTES || 10) * 60_000;
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 1));
const origins = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
await fsp.mkdir(TMP, { recursive: true });

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || origins.includes('*') || origins.includes(origin)) return cb(null, true);
    return cb(new Error('Origen no permitido por CORS'));
  }
}));
app.use(express.json({ limit: '32kb' }));

const jobs = new Map();
let active = 0;
const upload = multer({
  dest: TMP,
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowed = new Set(['.mp4','.mov','.mkv','.webm','.m4v','.avi']);
    if (!allowed.has(ext)) return cb(new Error('Formato no admitido. Usá MP4, MOV, MKV, WebM, M4V o AVI.'));
    cb(null, true);
  }
});

function cleanOldJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.expiresAt && now >= j.expiresAt && j.status !== 'processing') {
      jobs.delete(id);
      for (const p of [j.inputPath, j.outputPath]) if (p) fsp.rm(p, { force: true }).catch(()=>{});
    }
  }
}
setInterval(cleanOldJobs, 30_000).unref();

app.get('/health', (_req, res) => res.json({ ok: true, service: 'rosek-cloud-server' }));

app.post('/api/convert', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo de video en el campo "video".' });
  if (active >= MAX_CONCURRENT) {
    await fsp.rm(req.file.path, { force: true });
    return res.status(429).json({ error: 'El servidor está ocupado. Intentá nuevamente en unos minutos.' });
  }
  const fps = String(req.body.fps || 'source');
  const quality = String(req.body.quality || '20');
  const size = String(req.body.size || 'source');
  const audio = String(req.body.audio ?? 'true') !== 'false';
  if (!['source','30','60','120'].includes(fps) ||
      !['16','18','20','23','26'].includes(quality) ||
      !['source','1920x1080','1080x1920','3840x2160','2160x3840'].includes(size)) {
    await fsp.rm(req.file.path, { force: true });
    return res.status(400).json({ error: 'Configuración de conversión no válida.' });
  }
  const id = randomUUID();
  const outputPath = path.join(TMP, `${id}.mp4`);
  const job = {
    id, status: 'queued', progress: 0, createdAt: Date.now(),
    inputPath: req.file.path, outputPath, originalName: path.basename(req.file.originalname || 'video').slice(0,120),
    expiresAt: null, error: null
  };
  jobs.set(id, job);
  res.status(202).json({ id, status: job.status, statusUrl: `/api/jobs/${id}`, downloadUrl: `/api/jobs/${id}/download` });
  active++;
  job.status = 'processing';
  try {
    const args = ['-hide_banner','-y','-i',job.inputPath,'-map','0:v:0'];
    if (audio) args.push('-map','0:a?');
    args.push('-c:v','libx264','-preset','veryfast','-crf',quality,'-pix_fmt','yuv420p');
    if (fps !== 'source') args.push('-r',fps);
    if (size !== 'source') {
      const [w,h] = size.split('x').map(Number);
      args.push('-vf',`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`);
    }
    if (audio) args.push('-c:a','aac','-b:a','192k');
    else args.push('-an');
    args.push('-movflags','+faststart',job.outputPath);
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { stdio: ['ignore','ignore','pipe'] });
      let stderr = '';
      proc.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString()).slice(-6000);
        const m = stderr.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
        if (m) job.progress = Math.min(95, Math.max(job.progress, job.progress + 1));
      });
      proc.on('error', reject);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.slice(-1200) || `FFmpeg terminó con código ${code}`)));
    });
    const stat = await fsp.stat(outputPath);
    job.status = 'completed'; job.progress = 100; job.outputSize = stat.size;
    job.expiresAt = Date.now() + RETENTION_MS;
  } catch (err) {
    job.status = 'failed'; job.error = String(err?.message || 'Falló la conversión').slice(0,1000);
    job.expiresAt = Date.now() + 60_000;
    await fsp.rm(outputPath, { force: true });
  } finally {
    active = Math.max(0, active - 1);
    await fsp.rm(job.inputPath, { force: true });
    job.inputPath = null;
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Trabajo no encontrado o vencido.' });
  res.json({
    id: j.id, status: j.status, progress: j.progress,
    outputSize: j.outputSize || null, error: j.error,
    expiresAt: j.expiresAt, remainingMs: j.expiresAt ? Math.max(0, j.expiresAt - Date.now()) : null,
    downloadUrl: j.status === 'completed' ? `/api/jobs/${j.id}/download` : null
  });
});

app.get('/api/jobs/:id/download', async (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== 'completed' || (j.expiresAt && Date.now() >= j.expiresAt)) {
    return res.status(404).json({ error: 'El archivo no está disponible o ya venció.' });
  }
  res.download(j.outputPath, `${path.parse(j.originalName).name}_ROSEK.mp4`, err => {
    if (err && !res.headersSent) res.status(500).end('No se pudo enviar el archivo.');
  });
});

app.use((err, _req, res, _next) => {
  const tooLarge = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
  res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? `El archivo supera el límite de ${MAX_MB} MB.` : (err.message || 'Solicitud no válida.') });
});

app.listen(PORT, '0.0.0.0', () => console.log(`ROSEK API escuchando en puerto ${PORT}; tmp=${TMP}; RAM=${os.totalmem()}`));

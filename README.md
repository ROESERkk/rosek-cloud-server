# ROSEK Studio Cloud Server (starter)

Backend inicial para conectar ROSEK Studio con un servidor que convierte videos con FFmpeg nativo.

## Qué incluye
- API Express: `POST /api/convert`, `GET /api/jobs/:id`, `GET /api/jobs/:id/download`
- FFmpeg nativo en contenedor Docker.
- Procesamiento en segundo plano y consulta de progreso.
- Límite inicial de subida: 500 MB (configurable).
- Limpieza de archivos temporales 10 minutos después de terminar.
- CORS configurable por variable de entorno.

## Importante
Esta es una **base de desarrollo**, no un servicio ya publicado ni listo para recibir tráfico público sin configuración adicional. El estado de trabajos se guarda en memoria y los archivos en disco local; eso sirve para probar en una única instancia, pero NO es fiable si la plataforma reinicia el contenedor o distribuye solicitudes entre varias instancias. Para producción hay que añadir almacenamiento de objetos (p. ej. S3/R2/GCS) y una cola/estado compartido (p. ej. Redis) o usar una arquitectura equivalente.

La conversión actual de GitHub Pages no se modifica con este paquete. Primero probá el backend por separado; después se conecta la interfaz mediante `ROSEK_API_URL`.

## Ejecutar localmente con Docker
1. Instala Docker Desktop.
2. En esta carpeta ejecuta:
   ```bash
   docker compose up --build
   ```
3. La API quedará en `http://localhost:8080`.
4. Comprobación:
   ```bash
   curl http://localhost:8080/health
   ```

## API
Subir un video:
```bash
curl -X POST http://localhost:8080/api/convert \
  -F "video=@mi-video.mp4" \
  -F "fps=source" \
  -F "quality=20" \
  -F "size=source" \
  -F "audio=true"
```
La respuesta incluye `id` y `statusUrl`. Consultá `GET /api/jobs/ID` hasta `status` sea `completed`. Luego descargá `GET /api/jobs/ID/download`.

Opciones admitidas:
- `fps`: `source`, `30`, `60`, `120`
- `quality`: `16`, `18`, `20`, `23`, `26`
- `size`: `source`, `1920x1080`, `1080x1920`, `3840x2160`, `2160x3840`
- `audio`: `true` o `false`

## Variables
- `PORT` (default `8080`)
- `CORS_ORIGIN` (default `*` solo para pruebas; configurar la URL exacta de GitHub Pages en producción)
- `MAX_UPLOAD_MB` (default `500`)
- `RETENTION_MINUTES` (default `10`)
- `MAX_CONCURRENT_JOBS` (default `1`)

## Seguridad antes de publicar
- Configurar `CORS_ORIGIN` a `https://roeserkk.github.io`.
- Añadir protección contra abuso (rate limits, cuotas por IP/usuario y límites de duración).
- Usar almacenamiento externo y cola compartida antes de escalar.
- Definir presupuesto/alertas del proveedor.
- No añadir secretos al repositorio público.
- No activar interpolación real todavía: cambiar FPS con FFmpeg no crea movimiento intermedio. La interpolación requiere un modelo/filtro especializado y recursos extra.

## Despliegue
`Dockerfile` permite construir una imagen. Antes de desplegar en una nube pública, resolver el almacenamiento/cola compartidos y revisar límites y costes del proveedor. Este starter no se ha desplegado ni probado en tu cuenta.

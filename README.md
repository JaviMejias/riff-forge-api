# Riff Forge API

Riff Forge API es el backend de [Riff Forge](../Riff-Forge), una aplicación web para organizar, estudiar y reproducir canciones, tablaturas, acordes y pistas de karaoke. Esta API gestiona la autenticación, la biblioteca de cada usuario, los archivos multimedia, el catálogo comunitario y la sincronización entre dispositivos.

## Funcionalidades principales

- Registro, inicio de sesión y autenticación mediante JWT.
- Gestión de canciones, karaokes, playlists y acordes personalizados.
- Carga y almacenamiento de tablaturas Guitar Pro y archivos de audio.
- Descarga y procesamiento de audio para karaoke con FFmpeg.
- Catálogo de tablaturas y contenido compartido por la comunidad.
- Sincronización incremental entre dispositivos, con control de versiones, conflictos e idempotencia.
- Persistencia local mediante SQLite y Prisma.

## Tecnologías

- Node.js 24 y TypeScript.
- Express 5.
- Prisma 5 con SQLite.
- JSON Web Tokens y bcrypt para autenticación.
- Multer para carga de archivos.
- FFmpeg y `youtube-dl-exec` para procesamiento de audio.

## Estructura del proyecto

```text
riff-forge-api/
├── data/                   # Base de datos SQLite y catálogo local
├── docs/                   # Documentación adicional de la API
├── prisma/                 # Esquema y migraciones de Prisma
├── src/
│   ├── controllers/        # Controladores HTTP
│   ├── middleware/         # Autenticación y middleware
│   ├── routes/             # Definición de rutas
│   ├── scripts/            # Tareas de catálogo y mantenimiento
│   ├── services/           # Lógica de sincronización y archivos
│   └── utils/              # Prisma y configuración de uploads
├── tests/                  # Pruebas de integración
├── uploads/                # Archivos subidos por los usuarios
└── Dockerfile
```

Los directorios `data/` y `uploads/` se crean cuando son necesarios y deben conservarse entre despliegues.

## Requisitos

- Node.js 24 o superior.
- npm.
- FFmpeg para descargar y procesar audio de karaoke.
- Para replicar el entorno del contenedor y utilizar todas las funciones multimedia y de catálogo: Python 3, `curl`, `unzip` y Deno.
- El repositorio del frontend clonado junto a este repositorio para ejecutar la aplicación completa.

La estructura recomendada es:

```text
directorio-de-trabajo/
├── Riff-Forge/
└── riff-forge-api/
```

## Configuración

Crea un archivo `.env` en la raíz del proyecto:

```dotenv
JWT_SECRET=reemplazar-por-un-secreto-largo-y-seguro
PORT=3001
```

`JWT_SECRET` es obligatorio y la aplicación no inicia si no está definido. `PORT` es opcional y utiliza `3001` de forma predeterminada.

La base de datos predeterminada se almacena en `data/dev.db`. Para utilizar otra ubicación SQLite, también puedes definir:

```dotenv
DATABASE_URL=file:../data/dev.db
```

Las siguientes variables opcionales controlan la limpieza de los datos de sincronización:

```dotenv
SYNC_TOMBSTONE_RETENTION_DAYS=90
PURGE_SYNC_TOMBSTONES=false
```

El período mínimo de retención es de 30 días. No habilites `PURGE_SYNC_TOMBSTONES` sin una política que obligue a los clientes antiguos a realizar una sincronización completa.

## Desarrollo local

Instala las dependencias:

```bash
npm ci
npm run db:migrate
```

Inicia el servidor con recarga automática:

```bash
npm run dev
```

La API quedará disponible en `http://localhost:3001`. Puedes comprobar su estado en:

```text
GET http://localhost:3001/health
```

Para ejecutar también el frontend, abre otra terminal:

```bash
cd ../Riff-Forge
npm install
npm run dev
```

Durante el desarrollo, Vite redirige las solicitudes de la aplicación hacia la API local.

## Comandos disponibles

```bash
npm run dev           # Inicia la API en modo de desarrollo
npm run build         # Genera Prisma y compila TypeScript; no modifica la base
npm start             # Inicia el código compilado; no modifica el esquema
npm run db:migrate    # Aplica las migraciones pendientes
npm run db:status     # Consulta el estado de las migraciones
npm test              # Genera Prisma, compila y ejecuta las pruebas de integración
npm run cleanup:sync  # Simula la limpieza e informa candidatos; no elimina datos
```

Las pruebas compilan en un directorio temporal y usan bases SQLite y uploads aislados. No escriben en `dist/`, `data/` ni `uploads/` del proyecto. La primera implementación de las mejoras de seguridad y los requisitos de migración se describen en [docs/backend-hardening.md](docs/backend-hardening.md).

Antes de ejecutar `npm run cleanup:sync`, genera la compilación con `npm run build`. La limpieza solo elimina datos con `npm run cleanup:sync -- --apply`: requiere copia de seguridad consistente y una ventana de mantenimiento con la API y todos los procesos que escriben detenidos. No programes el borrado automático sin esa política. Conserva los archivos referenciados por el historial de sincronización y los resultados de operaciones aún retenidos. Consulta [docs/cleanup-retention.md](docs/cleanup-retention.md).

## Descargas del catálogo

Las descargas autenticadas comprueban que la ruta guardada sea relativa, permanezca dentro del directorio de datos y corresponda a un archivo regular Guitar Pro del formato indicado. Rechazan rutas externas y enlaces que salen de ese directorio; mantienen rangos y peticiones HEAD. Los fallos durante la transmisión se manejan sin dejar cabeceras de descarga en una respuesta JSON. Consulta [docs/catalog-file-downloads.md](docs/catalog-file-downloads.md).

## Validación de archivos de audio

Las descargas y conversiones de pitch comprueban que los archivos sean regulares y respeten el límite individual de 50 MiB. Los enlaces simbólicos y los resultados vacíos, demasiado pequeños para la validación de pitch o demasiado grandes no se publican; los archivos originales y las cachés existentes rechazadas no se borran automáticamente. Consulta [docs/audio-file-validation.md](docs/audio-file-validation.md). Esta validación no es una cuota total de almacenamiento ni garantiza por sí sola que un archivo sea reproducible.

## Diagnóstico de errores

Las respuestas incluyen `X-Request-ID`, un identificador generado por el servidor y accesible desde el frontend mediante CORS. Si ocurre un error 500 o superior, busca ese identificador en la terminal del backend: el registro JSON muestra la ruta definida, el estado, la duración y una categoría de fallo, sin cuerpos, tokens, parámetros privados ni consultas de base de datos. Las transmisiones interrumpidas también se registran. No se registran las peticiones exitosas ni los rechazos 4xx completados. Consulta [docs/request-diagnostics.md](docs/request-diagnostics.md) para los límites y el procedimiento de diagnóstico.

## Autenticación y rutas

La mayoría de los endpoints requieren un token obtenido mediante registro o inicio de sesión:

```http
Authorization: Bearer <token>
```

Rutas principales:

| Ruta | Descripción |
| --- | --- |
| `/api/auth` | Registro, inicio de sesión, verificación y preferencias |
| `/api/songs` | Biblioteca y archivos de canciones |
| `/api/karaokes` | Karaokes, letras y procesamiento de audio |
| `/api/playlists` | Playlists de canciones |
| `/api/karaoke-playlists` | Playlists de karaoke |
| `/api/chords` | Acordes personalizados |
| `/api/community` | Contenido público de la comunidad |
| `/api/catalog` | Búsqueda y descarga del catálogo |
| `/api/youtube` | Extracción de audio desde YouTube |
| `/api/sync/v2` | Sincronización incremental entre dispositivos |
| `/uploads` | Acceso a archivos almacenados |

La especificación, los límites y el manejo de conflictos de la sincronización se describen en [docs/sync-v2.md](docs/sync-v2.md).

## Docker Compose

El entorno conjunto se inicia desde el repositorio del frontend, cuyo `docker-compose.yml` construye ambos servicios. Crea `Riff-Forge/.env.backend`:

```dotenv
JWT_SECRET=reemplazar-por-un-secreto-largo-y-seguro
```

Para una instalación nueva, ejecuta:

```bash
cd ../Riff-Forge
docker compose build
docker compose run --rm --no-deps backend npm run db:migrate
docker compose up -d
```

La aplicación quedará disponible en `http://localhost:8080` y la API en `http://localhost:3001`. Docker Compose conserva la base de datos y los archivos subidos en volúmenes independientes.

## Compilación de producción

```bash
npm run build
npm run db:migrate
npm start
```

El código compilado se guarda en `dist/`. En el despliegue con Docker, el frontend usa Nginx como servidor web y proxy inverso hacia esta API.

La CLI y la aplicación usan la misma `DATABASE_URL`. Las rutas relativas de SQLite se resuelven respecto de `prisma/`, independientemente del directorio desde donde se ejecute el proceso. Sin esa variable, ambas usan `data/dev.db`.

Antes de migrar una instalación existente, sigue [la guía de migración y recuperación](docs/database-migrations.md). No ejecutes `db push` ni marques migraciones como aplicadas sin comprobar el esquema y sus transformaciones de datos.

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
npm install
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
npm run build         # Actualiza el esquema de la base de datos y compila TypeScript
npm start             # Actualiza el esquema e inicia la compilación de producción
npm test              # Genera Prisma, compila y ejecuta las pruebas de integración
npm run cleanup:sync  # Elimina archivos huérfanos y datos de sincronización expirados
```

Antes de ejecutar `npm run cleanup:sync`, genera la compilación con `npm run build`. En producción conviene programar esta tarea periódicamente.

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

Luego ejecuta:

```bash
cd ../Riff-Forge
docker compose up --build
```

La aplicación quedará disponible en `http://localhost:8080` y la API en `http://localhost:3001`. Docker Compose conserva la base de datos y los archivos subidos en volúmenes independientes.

## Compilación de producción

```bash
npm run build
npm start
```

El código compilado se guarda en `dist/`. En el despliegue con Docker, el frontend usa Nginx como servidor web y proxy inverso hacia esta API.

# Migraciones y recuperación de SQLite

## Comandos y configuración

Este proyecto mantiene Prisma 5.22. No utiliza `prisma.config.ts`, una API que no corresponde a esa versión. Ejecuta la CLI mediante los comandos del proyecto para cargar la misma configuración que el servidor:

```bash
npm run prisma:generate
npm run build
npm run db:status
npm run db:migrate
npm start
```

Compilar y arrancar no aplican cambios de esquema. `db:migrate` aplica los archivos SQL pendientes y registra el historial. `DATABASE_URL=file:../data/dev.db` apunta a `data/dev.db`: las rutas relativas se interpretan desde `prisma/`. Se recomienda una ruta absoluta para producción, por ejemplo `file:/app/data/dev.db`.

## Antes de actualizar una instalación existente

1. Programa una ventana de mantenimiento y detén todas las escrituras, incluidos los trabajos de audio y limpieza.
2. Obtén un respaldo consistente de SQLite con la herramienta de backup de SQLite y respalda también uploads, configuración y la versión desplegada. No copies solo el archivo principal si hay una conexión activa usando WAL.
3. Prueba restaurar el respaldo en una ubicación aislada. Verifica integridad, relaciones, conteos y disponibilidad de los archivos.
4. Ejecuta `npm run db:status` contra la copia restaurada y comprueba su esquema. Si faltan tablas/columnas o hay migraciones fallidas, detén el proceso y diagnostica antes de continuar.
5. Aplica `npm run db:migrate` primero sobre esa copia y verifica canciones, playlists, permisos de archivos y sincronización.
6. Repite el procedimiento de migración en la instalación objetivo durante la ventana de mantenimiento; comprueba la API antes de reabrir escrituras.

Los respaldos contienen datos privados. Guárdalos fuera del repositorio, con permisos restringidos y una política de retención.

## Bases creadas con db push

Una base con tablas existentes y sin historial no debe recibir automáticamente todas las migraciones originales: Prisma rechaza este caso con P3005. Esto evita recrear tablas, pero no sustituye la revisión de integridad o del esquema.

No ejecutes `migrate reset` ni marques migraciones como aplicadas para eliminar el error. Establecer un baseline requiere comparar el esquema real con cada estado histórico y ejecutar las transformaciones que `db push` omitió: fechas iniciales, versiones de archivos, membresías y eventos de sincronización. El baseline es una operación manual posterior a un respaldo verificado.

Referencia: [baselining de Prisma](https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining).

## Reparación de playlists

La migración histórica de sync v2 confundió las columnas de `_PlaylistToSong`: A corresponde a la playlist y B a la canción. Una nueva migración corrige los registros identificables sin editar el historial.

La reparación exige una playlist activa de versión 1, un valor igual al generado por el SQL defectuoso, relaciones antiguas y un evento inicial sin payload. No modifica listas reordenadas, actualizadas, eliminadas o con snapshots posteriores; esos casos requieren inspección manual. Solo recupera canciones activas del mismo usuario y utiliza un orden determinista, ya que la relación antigua no conservaba orden.

Cada reparación se ejecuta en una transacción, incrementa la versión y publica un snapshot inmutable para clientes que ya sincronizaron el estado anterior. Las playlists de karaoke no reciben esta reparación porque sus columnas originales estaban correctamente interpretadas.

## Docker y despliegue

Desde el repositorio del frontend, después del respaldo y las comprobaciones:

```bash
docker compose build backend
docker compose run --rm --no-deps backend npm run db:migrate
docker compose up -d --no-deps backend
docker compose ps backend
```

El workflow se detiene si la migración falla y no sustituye el contenedor en ese caso. No crea un respaldo automático: prepara el respaldo y el estado de migraciones antes de activar este workflow sobre una instalación existente. El paso automatizado presupone que las escrituras ya están controladas durante el despliegue.

Verifica `/health` y al menos un flujo autenticado de lectura y sincronización. `/health` por sí solo no comprueba el estado de SQLite.

Si es necesario recuperar una migración ya aplicada, detén las escrituras y restaura conjuntamente la base, los archivos y la imagen anterior desde el respaldo validado. Reiniciar únicamente la imagen antigua no revierte cambios de datos. No hay rollback SQL automático en este bloque.

## Validación local de este bloque

Las pruebas usan bases temporales: migración desde el esquema inicial con datos, reparación selectiva, evento de sync, historial de Prisma, segunda ejecución sin cambios y rechazo de bases sin baseline. También ejecutan un build de producción aislado y comprueban que no crea una base de datos.

La base real, uploads y dist no se migran ni limpian durante las pruebas.

Posteriormente se aplicaron las dos migraciones pendientes a la base local de desarrollo, tras respaldarla y ensayar la restauración y migración. El resultado y las comprobaciones de la API real están en [local-validation.md](local-validation.md). Esto no modifica el aislamiento de la suite ni implica un despliegue de producción.

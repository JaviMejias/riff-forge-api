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

### Adopción controlada de una instalación legacy sync v2

El comando `npm run db:adopt-legacy` inspecciona en modo solo lectura. Solo admite el esquema exacto equivalente a las dos primeras migraciones, con historial inexistente o vacío, integridad válida y sin objetos/constraints inesperados. Las columnas pueden estar en otro orden por un `db push`. Otros esquemas requieren revisión manual; no se adopta una base nueva ni se marcan las cuatro migraciones como aplicadas.

```bash
npm run build
npm run db:adopt-legacy
```

La inspección devuelve conteos y reparaciones previstas, sin emails, hashes ni contenidos privados. No crea una base inexistente. No está conectada al despliegue automático: el P3005 sigue siendo una condición de parada hasta que se prepare la instalación.

Para aplicar, primero respalda también uploads y la imagen anterior, detén todas las escrituras (API, workers y herramientas externas) y usa una ruta absoluta nueva en un directorio restringido fuera del repositorio:

```bash
npm run db:adopt-legacy -- --apply --maintenance --backup /ruta/privada/nuevo-respaldo.db
```

`--maintenance` es la confirmación del operador de que detuvo las escrituras y cerró las conexiones de API/workers; no las detiene el script. La herramienta:

1. Valida esquema, integridad y relaciones antes de escribir.
2. Crea un respaldo consistente con la API de backup SQLite, permisos 0600 y sin sobrescribir otro archivo.
3. Restaura ese respaldo en una base temporal y ensaya la recuperación completa y las migraciones pendientes. Un fallo del ensayo deja intacta la base objetivo.
4. Comprueba que puede cambiar a journal DELETE, requerido por Prisma 5, antes de cambiar metadatos; conexiones WAL competidoras provocan una parada. Inicializa únicamente fechas en cero y versiones de archivo en cero con archivo presente. Conserva valores existentes y tombstones. Cada entidad modificada incrementa su versión y genera un snapshot nuevo; los snapshots anteriores no cambian. Entidades sin ningún evento reciben un snapshot inicial.
5. Registra mediante Prisma 5.22 únicamente las dos migraciones de esquema comprobadas y aplica normalmente las posteriores, incluida `FileAsset` y la reparación legacy de playlists. Comprueba integridad, conteos de entidades e historial final.

Las membresías de playlists ya existentes son la fuente de verdad: no se sobrescriben desde relaciones antiguas que pueden corresponder a listas vaciadas deliberadamente. Si hay membresías legacy perdidas, revísalas por separado antes de reabrir escrituras. El script no reproduce el backfill defectuoso de la migración histórica ni reemplaza uploads.

Las operaciones de Prisma se ejecutan después de la transacción de metadatos y no forman una sola transacción global. Si falla la aplicación real pese al ensayo (disco, interrupción u otra escritura), mantén mantenimiento y revisa `db:status`; no repitas ciegamente la adopción ni arranques una imagen incompatible. Restaura el respaldo y la imagen/uploads coordinadamente si corresponde. El script conserva el respaldo y comunica el fallo, sin reset ni rollback automático.

Comprueba después canciones, karaokes, playlists y sincronización con una cuenta real. Solo entonces reinicia el backend y habilita el despliegue automático.

## Reparación de playlists

La migración histórica de sync v2 confundió las columnas de `_PlaylistToSong`: A corresponde a la playlist y B a la canción. Una nueva migración corrige los registros identificables sin editar el historial.

La reparación exige una playlist activa de versión 1, un valor igual al generado por el SQL defectuoso, relaciones antiguas y un evento inicial sin payload. No modifica listas reordenadas, actualizadas, eliminadas o con snapshots posteriores; esos casos requieren inspección manual. Solo recupera canciones activas del mismo usuario y utiliza un orden determinista, ya que la relación antigua no conservaba orden.

Cada reparación se ejecuta en una transacción, incrementa la versión y publica un snapshot inmutable para clientes que ya sincronizaron el estado anterior. Las playlists de karaoke no reciben esta reparación porque sus columnas originales estaban correctamente interpretadas.

## Docker y despliegue

Desde el repositorio del frontend, después del respaldo y las comprobaciones:

```bash
docker compose build backend
docker compose run --rm --no-deps -T backend npm run db:migrate < /dev/null
docker compose up -d --no-deps backend
docker compose ps backend
```

El workflow se detiene si la migración falla y no sustituye el contenedor en ese caso. El contenedor de migración usa `-T` y stdin cerrado: en un script SSH recibido por heredoc, Docker Compose puede consumir los comandos posteriores si hereda esa entrada. Dos pruebas de shell verifican el reinicio tras una migración exitosa y su bloqueo ante un fallo.

No crea un respaldo automático: prepara el respaldo y el estado de migraciones antes de activar este workflow sobre una instalación existente. El paso automatizado presupone que las escrituras ya están controladas durante el despliegue.

No reinicies una imagen legacy cuyo script `start` incluya `prisma db push` sobre un esquema migrado: puede revertirlo. Usa una imagen compatible con arranque `node dist/index.js`; si necesitas recuperar una versión anterior, restaura el respaldo coordinadamente y deshabilita el push automático antes de arrancarla.

Verifica `/health` y al menos un flujo autenticado de lectura y sincronización. `/health` por sí solo no comprueba el estado de SQLite.

Si es necesario recuperar una migración ya aplicada, detén las escrituras y restaura conjuntamente la base, los archivos y la imagen anterior desde el respaldo validado. Reiniciar únicamente la imagen antigua no revierte cambios de datos. No hay rollback SQL automático en este bloque.

## Validación local de este bloque

Las pruebas usan bases temporales: migración desde el esquema inicial con datos, reparación selectiva, evento de sync, historial de Prisma, segunda ejecución sin cambios y rechazo de bases sin baseline. También ejecutan un build de producción aislado y comprueban que no crea una base de datos.

La base real, uploads y dist no se migran ni limpian durante las pruebas.

Posteriormente se aplicaron las dos migraciones pendientes a la base local de desarrollo, tras respaldarla y ensayar la restauración y migración. El resultado y las comprobaciones de la API real están en [local-validation.md](local-validation.md). Esto no modifica el aislamiento de la suite ni implica un despliegue de producción.

# Validación de la base y archivos en desarrollo

## Corrección aplicada el 2026-10-04

La ruta privada `/uploads` devolvía 500 porque la base local configurada todavía no tenía la tabla `FileAsset`. Se actualizó únicamente `/home/javier/riff-forge-api/data/dev.db`; no se desplegó nada en producción.

Se aplicaron las migraciones pendientes:

- `20261004000000_add_file_ownership`.
- `20261004010000_repair_legacy_playlists`.

El historial ahora tiene cuatro migraciones completas. `db:status` informa que el esquema está actualizado y `migrate diff` no detecta diferencias respecto de `prisma/schema.prisma`.

## Respaldo y comprobaciones de datos

El respaldo está fuera del repositorio, en `/home/javier/.local/share/riff-forge-backups/before-file-access-Q8ir4g`, con acceso restringido. Contiene:

- `database-before.db`: copia consistente de SQLite anterior al cambio.
- `uploads/`: copia de los archivos originales.
- `backend-code/`: código y configuración, incluida la configuración privada; no compartir ni publicar este respaldo.
- `validation.db`: copia restaurada en la que se ensayaron las migraciones.
- `manifest.json` y `migration-result.json`: integridad, conteos y hashes de verificación, sin valores de tokens.

La copia restaurada pasó integridad y relaciones antes y después de migrar. Se ensayó una segunda ejecución sin cambios y se verificó el resultado antes de aplicar las migraciones a la base original. La base final coincide con la copia ensayada, exceptuando IDs y timestamps propios del historial de ejecución de Prisma.

Las tablas existentes conservaron exactamente sus registros, incluyendo usuarios, canciones, karaokes y eventos de sincronización. Había cero playlists, por lo que la reparación selectiva no alteró ninguna lista. La nueva tabla tiene dos propiedades de archivo recuperadas de referencias antiguas no ambiguas. Los 42 uploads originales mantienen los mismos bytes; no se ejecutó limpieza ni se eliminaron archivos.

## Verificación de la API real

Se comprobó el Guitar Pro que antes fallaba, tanto directamente en `http://localhost:3001` como mediante el proxy Vite de `http://localhost:5173`:

| Solicitud | Resultado |
| --- | --- |
| HEAD autenticado como propietario | 200 y tamaño correcto |
| GET del propietario con rango de ocho bytes | 206 y bytes correctos |
| HEAD sin sesión | 404, archivo privado no expuesto |
| HEAD de otra cuenta | 404, archivo privado no expuesto |

Las respuestas conservan `Cache-Control: private, no-store` y `Vary: Authorization`. Las lecturas autenticadas de canciones y karaokes devuelven únicamente registros de la cuenta solicitante.

En un perfil temporal de Edge, una sesión de prueba de un minuto se verificó contra la API local real. El transporte del frontend descargó el archivo con Bearer y su tamaño y SHA-256 coincidieron con el archivo del servidor. Se bloquearon todas las solicitudes de escritura, no hubo sincronizaciones ni errores de página y el perfil temporal se cerró. Los tokens no se imprimieron ni se guardaron en archivos de reporte.

La suite aislada del backend volvió a pasar sus 77 pruebas. Estas pruebas no usan la base real.

## Pendientes que no se dan por comprobados

- Reproducción de un MP3 remoto con esta API real: no hay actualmente un karaoke activo del servidor con audio remoto vinculado. La prueba previa del reproductor con audio sintético y API simulada sigue siendo válida, pero no sustituye esta comprobación.
- Procesamiento nativo con FFmpeg y yt-dlp; las pruebas automatizadas simulan esos procesos.
- Ejecución del proxy Nginx de Docker y configuración de producción: solo se comprobó el proxy de desarrollo Vite.

La sincronización automática sigue deshabilitada en desarrollo. Guardar una canción o un karaoke en el navegador no lo sube al servidor; la sincronización manual es una acción explícita del usuario.

Para restaurar un respaldo, primero detén las escrituras y sigue el procedimiento de [database-migrations.md](database-migrations.md). No sustituyas una base en uso ni sobrescribas ediciones posteriores con este respaldo.

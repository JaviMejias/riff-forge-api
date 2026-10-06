# Conflictos en escrituras antiguas

Este bloque protege los endpoints anteriores a sync v2. No añade tablas ni modifica el contrato de `POST /api/sync/v2`.

## Canciones y karaokes

Las ediciones de metadatos y los borrados requieren la versión leída del servidor. Envía `baseVersion` en JSON o multipart. Como alternativas, se acepta `version` o `If-Match: "2"`; si envías varias formas deben coincidir.

```http
PUT /api/songs/<id>
Authorization: Bearer <token>
Content-Type: application/json

{"name":"Nombre actualizado","baseVersion":2}
```

La versión se comprueba dentro de la transacción. La actualización también compara ID, propietario, versión y estado activo en SQLite, incrementa la versión y registra un snapshot de sincronización en la misma transacción.

- 428 y `code: version_required`: falta la versión.
- 400 y `code: invalid_version`: versión inválida o precondiciones contradictorias.
- 409 y `code: conflict`: el registro cambió o fue eliminado; `serverEntity` contiene su snapshot actual para el propietario.
- 404: el registro no existe o pertenece a otro usuario. No se devuelve el estado privado de otro usuario.

No repitas automáticamente una edición desactualizada usando la nueva versión: primero revisa o combina los cambios. Una entidad eliminada no se puede restaurar reutilizando su ID. Los POST de creación también rechazan IDs existentes: 409 para el propietario y 404 para otros usuarios.

## Compatibilidad de archivos

El frontend usa sync v2 para metadatos y PUT multipart para transferir el archivo. Todas las actualizaciones, incluidas las que contienen únicamente un binario, requieren una versión. El frontend envía `baseVersion` junto con `file` e `id`.

Un conflicto elimina el upload temporal y no cambia la referencia, la versión del archivo ni los eventos de sincronización. El frontend conserva los bytes locales y marca `fileUploadConflict`; no vuelve a subirlos automáticamente aunque reciba una versión nueva.

Para reintentar conscientemente, revisa el conflicto, sincroniza los metadatos actuales y vuelve a seleccionar el archivo que quieras conservar. Esa selección elimina la marca de conflicto; la siguiente subida continúa protegida por la versión conocida. Los clientes anteriores que no envían versión reciben 428: esta actualización requiere desplegar frontend y backend de forma coordinada.

## Reemplazo completo de colecciones

Se aplica a:

- GET `/api/playlists` y POST `/api/playlists/sync`.
- GET `/api/karaoke-playlists` y POST `/api/karaoke-playlists/sync`.
- GET `/api/chords` y POST `/api/chords/sync`.

El GET conserva su respuesta de array y añade el header `X-Collection-Version`. Guarda el valor completo, incluidas sus comillas, y envíalo en el mismo header al POST. Se exige incluso para una colección vacía.

```http
POST /api/playlists/sync
Authorization: Bearer <token>
X-Collection-Version: "<valor recibido del GET>"
Content-Type: application/json

[{"id":"<id>","name":"Lista actualizada","songCloudIds":[],"version":3}]
```

El token incluye propietario, tipo de colección y versiones de todos sus registros, incluidos los eliminados. Si otro dispositivo añade, modifica o elimina un registro, una copia antigua no puede sobrescribir la colección ni borrar elementos que omitió por desconocerlos.

- 428 y `code: collection_version_required`: falta el token.
- 409 y `code: collection_conflict`: cambió la colección; vuelve a cargarla y combina los cambios antes de guardar.
- Un item con versión desactualizada también se rechaza, aunque el token de colección sea actual.
- Los IDs duplicados, las referencias ajenas o eliminadas y los intentos de reutilizar un ID eliminado se rechazan.
- Si falla cualquier item, se revierte todo el reemplazo, incluidos borrados por omisión y eventos de sincronización.
- El POST exitoso devuelve el nuevo token en `X-Collection-Version`.

El token de concurrencia es independiente de ETag. La respuesta GET puede incluir canciones con metadatos cambiantes; su ETag HTTP continúa calculándose sobre la respuesta completa. CORS expone el token para que los clientes web puedan leerlo.

Los endpoints de colección antiguos siguen siendo reemplazos completos: omitir un registro lo elimina únicamente cuando se presenta un token actual. No deben utilizarse como si fueran upserts parciales. El frontend actual utiliza operaciones explícitas de sync v2 y no estos reemplazos.

## Quitar audio

`POST /api/karaokes/delete-audio` acepta `id`, `cloudUrl` y `baseVersion`. Si varios karaokes del mismo usuario referencian el audio, `id` es obligatorio para evitar modificar uno arbitrariamente. Se devuelve 409 con `code: ambiguous_audio_reference` si falta esa selección.

La operación desconecta el audio solo del karaoke seleccionado y registra su nueva versión. No borra físicamente el archivo ni altera las otras referencias.

## Validación y alcance

Las pruebas HTTP usan SQLite y uploads temporales. Cubren versiones inválidas, ediciones y reemplazos simultáneos, snapshots, aislamiento entre usuarios, rollback, archivos rechazados, caché HTTP, IDs eliminados y compatibilidad con las cargas actuales del frontend.

La validación local se ejecutó con Node 26.7; CI sigue configurado para Node 24. La suite no modifica la base ni uploads reales. Posteriormente se migró la base local tras un respaldo y ensayo verificados, sin alterar los registros existentes ni los uploads; véase [local-validation.md](local-validation.md). No se desplegó en producción.

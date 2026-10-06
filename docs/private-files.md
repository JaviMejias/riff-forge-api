# Acceso a archivos y compatibilidad del cliente

`GET /uploads/<archivo>` y `HEAD` comprueban permisos antes de entregar bytes, rangos o respuestas condicionales. La ruta ya no es un directorio estático público.

- El propietario registrado en `FileAsset` puede descargar el archivo, incluso si todavía no está vinculado o se conserva como historial.
- Sin propietario registrado, las referencias antiguas deben pertenecer a un único usuario. La lectura no modifica la base; una propiedad ambigua se rechaza.
- Otros usuarios y visitantes solo pueden leerlo si una canción o karaoke activo y público del propietario referencia ese archivo. Una referencia pública ajena o un registro eliminado no concede acceso.
- El propietario se autentica mediante `Authorization: Bearer <JWT>`. No se admiten tokens en la URL. Los tokens usan HS256 y deben contener un `userId` no vacío.
- Las respuestas usan `Cache-Control: private, no-store`, `Vary: Authorization` y nombre de descarga. Se rechazan rutas inválidas, directorios, enlaces simbólicos y métodos distintos de GET/HEAD.

El frontend descarga archivos privados con el header de autorización y reproduce una URL blob local. Conserva el acceso offline a los bytes guardados en la base de la cuenta. Las descargas se cancelan al desmontar el reproductor y sus respuestas se descartan si cambia la sesión. Las redirecciones de descarga se rechazan para evitar enviar credenciales a otra ubicación.

Los reemplazos binarios requieren `baseVersion`. Un 409 conserva los bytes locales y bloquea el reintento automático; revisar el conflicto y volver a seleccionar un archivo habilita otra subida protegida por versión.

## Puesta en servicio

Frontend y backend deben actualizarse coordinadamente: los clientes antiguos sin versión recibirán 428, y una URL privada sin header dejará de ser reproducible directamente. Antes de desplegar, aplica las migraciones mediante el procedimiento de [database-migrations.md](database-migrations.md), con copias de seguridad. La infraestructura no debe servir `/uploads` directamente ni almacenar sus respuestas en una caché compartida, porque eludiría estos permisos.

La suite usa archivos, SQLite y servidor temporales. Cubre propietario, visitante, publicación y retirada, referencias ajenas, datos antiguos ambiguos, JWT inválidos, HEAD, rangos y traversal. En un perfil temporal de Edge, con API simulada y audio sintético, se comprobó que el reproductor envía Bearer, decodifica y reproduce la URL blob, se pausa y revoca esa URL al cerrar sesión, y reproduce la copia de IndexedDB sin otra descarga incluso con la sesión offline sin verificar.

Después se respaldó y migró la base local de desarrollo, y se verificó la descarga real autenticada tanto directamente como mediante Vite, incluyendo permisos, rangos y coincidencia de bytes en Edge. No se desplegó en producción ni se ejecutó limpieza. La reproducción de audio remoto real sigue pendiente porque no hay un karaoke activo del servidor con audio remoto vinculado. Véase [local-validation.md](local-validation.md).

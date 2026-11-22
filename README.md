# Registro documental

Servicio para guardar, buscar y descargar documentos. Los archivos viven en [Garage](https://garagehq.deuxfleurs.fr/) (almacenamiento compatible con S3) y los metadatos en SQLite con índices. Una API REST los expone y un panel de administración permite gestionarlos.

- Sin dependencias npm (solo Node.js).
- Búsqueda por nombre, listados paginados y detección de archivos duplicados.
- Límite de tráfico por IP, CORS restringido a un único origen y claves de API separadas para uso normal y administración.

## Requisitos

- Node.js **22.13 o superior** (usa `node:sqlite`)
- Docker y Docker Compose (para Garage)
- `openssl` o Node para generar claves

## 1. Garage

Crea `garage.toml`:

```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1

rpc_bind_addr = "[::]:3901"
rpc_secret = "<openssl rand -hex 32>"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
```

Y `docker-compose.yml` (el archivo debe llamarse exactamente así):

```yaml
services:
  garage:
    image: dxflrs/garage:v2.3.0
    command: ["/garage", "server", "--single-node", "--default-bucket"]
    ports:
      - "127.0.0.1:3900:3900"
    volumes:
      - ./garage.toml:/etc/garage.toml
      - ./meta:/var/lib/garage/meta
      - ./data:/var/lib/garage/data
    environment:
      GARAGE_DEFAULT_ACCESS_KEY: <GK + 24 caracteres hex>
      GARAGE_DEFAULT_SECRET_KEY: <openssl rand -hex 32>
      GARAGE_DEFAULT_BUCKET: documentos
    restart: unless-stopped
```

Genera cada valor por separado (el `rpc_secret` y la secret key deben ser distintos):

```bash
openssl rand -hex 32                 # rpc_secret y secret key
echo "GK$(openssl rand -hex 12)"     # access key
```

Sin openssl: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Levanta y verifica:

```bash
docker compose up -d
docker compose exec garage /garage status
```

El puerto queda ligado a `127.0.0.1` para que Garage no sea accesible desde fuera del servidor.

## 2. API

```bash
cp .env.example .env     # completa los valores
node server.js
```

| Variable | Descripción |
|---|---|
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | Conexión a Garage |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Las mismas del `docker-compose.yml` |
| `API_KEY` | Clave para tu aplicación (subir, listar, descargar) |
| `ADMIN_KEY` | Clave de administrador (además borra y ve estadísticas) |
| `ALLOWED_ORIGIN` | Único origen de navegador permitido por CORS |
| `PORT`, `MAX_MB`, `RATE_LIMIT` | Puerto (3000), tamaño máximo en MB (50) y peticiones por minuto por IP (120) |

Genera `API_KEY` y `ADMIN_KEY` con `openssl rand -hex 32`. Deben ser distintas entre sí.

Panel de administración: `http://localhost:3000/admin`

### Endpoints

Todas las peticiones llevan la cabecera `x-api-key`.

| Método | Ruta | Clave | Descripción |
|---|---|---|---|
| POST | `/api/documents?name=archivo.pdf` | API | Sube un archivo. El cuerpo son los bytes y `Content-Type` es el tipo del archivo |
| GET | `/api/documents?q=&limit=&offset=` | API | Lista y busca por inicio del nombre |
| GET | `/api/documents/:id` | API | Descarga |
| DELETE | `/api/documents/:id` | Admin | Elimina |
| GET | `/api/admin/stats` | Admin | Totales y subidas de las últimas 24 h |

Si se sube un archivo idéntico a uno existente, responde `200` con `"duplicate": true` y el `id` original.

## 3. Conexión con CakePHP

CakePHP incluye `Cake\Http\Client`, así que no necesitas instalar nada. La conexión es de servidor a servidor: tu aplicación CakePHP llama a la API, y la clave nunca llega al navegador. Por eso CORS no interviene en este caso (solo aplica a llamadas hechas desde un navegador).

**Configuración** en `config/app_local.php`:

```php
'Documentos' => [
    'url' => env('DOCS_URL', 'http://localhost:3000'),
    'apiKey' => env('DOCS_API_KEY'),   // el API_KEY, no el ADMIN_KEY
],
```

**Servicio** en `src/Service/DocumentosService.php`:

```php
<?php
declare(strict_types=1);

namespace App\Service;

use Cake\Core\Configure;
use Cake\Http\Client;
use Cake\Http\Client\Response;
use RuntimeException;

class DocumentosService
{
    private Client $http;
    private string $base;
    private string $key;

    public function __construct()
    {
        $cfg = Configure::read('Documentos');
        $this->base = rtrim($cfg['url'], '/');
        $this->key = (string)$cfg['apiKey'];
        $this->http = new Client(['timeout' => 30]);
    }

    private function opts(array $headers = []): array
    {
        return ['headers' => ['x-api-key' => $this->key] + $headers];
    }

    private function check(Response $r, string $msg): Response
    {
        if (!$r->isOk()) {
            throw new RuntimeException($r->getJson()['error'] ?? $msg);
        }

        return $r;
    }

    /** Devuelve ['id' => ..., 'name' => ..., 'size' => ...] */
    public function subir(string $nombre, string $contenido, string $mime): array
    {
        $url = $this->base . '/api/documents?name=' . rawurlencode($nombre);
        $r = $this->http->post($url, $contenido, $this->opts(['Content-Type' => $mime]));

        return $this->check($r, 'No se pudo subir el documento')->getJson();
    }

    public function listar(string $q = '', int $limit = 50, int $offset = 0): array
    {
        $r = $this->http->get($this->base . '/api/documents', compact('q', 'limit', 'offset'), $this->opts());

        return $this->check($r, 'No se pudo listar')->getJson();
    }

    public function descargar(string $id): Response
    {
        $r = $this->http->get($this->base . '/api/documents/' . rawurlencode($id), [], $this->opts());

        return $this->check($r, 'Documento no disponible');
    }
}
```

**Controlador** (por ejemplo `DocumentosController`):

```php
use App\Service\DocumentosService;

public function subir()
{
    $this->request->allowMethod('post');
    $archivo = $this->request->getData('archivo');   // campo <input type="file" name="archivo">

    $doc = (new DocumentosService())->subir(
        $archivo->getClientFilename(),
        $archivo->getStream()->getContents(),
        $archivo->getClientMediaType() ?: 'application/octet-stream'
    );
    // Guarda $doc['id'] en tu tabla para relacionarlo con tus registros.

    return $this->response->withType('json')->withStringBody(json_encode($doc));
}

public function descargar(string $id)
{
    $r = (new DocumentosService())->descargar($id);

    return $this->response
        ->withType($r->getHeaderLine('Content-Type'))
        ->withHeader('Content-Disposition', $r->getHeaderLine('Content-Disposition'))
        ->withStringBody($r->getStringBody());
}
```

El formulario de subida necesita `'type' => 'file'` en `$this->Form->create(...)`.

Notas:
- La descarga carga el archivo completo en memoria en PHP. Es suficiente para documentos habituales; revisa `memory_limit` si manejas archivos grandes.
- Para subir archivos grandes, ajusta también `upload_max_filesize` y `post_max_size` en PHP, y `MAX_MB` en la API.
- Guarda en tu base de datos el `id` que devuelve la API, no solo el nombre del archivo.

## Producción

- Publica la API detrás de un proxy inverso con **HTTPS** (Nginx, Caddy). Las claves viajan en una cabecera.
- Si usas proxy, el límite de tráfico debe leer `x-forwarded-for`; sin ese ajuste verá siempre la IP del proxy.
- Mantén el proceso vivo con `systemd` o `pm2`.
- Programa copias de respaldo de `./data`, `./meta` y `docs.db`. Esta configuración de Garage no tiene redundancia.
- No expongas el puerto de Garage (3900) a internet.

## Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| `no configuration file provided` | El archivo no se llama `docker-compose.yml` o estás en otra carpeta |
| `401 API key inválida` | Cabecera `x-api-key` ausente o clave distinta a la del `.env` |
| `403 Origen no permitido` | La petición viene de un navegador desde un origen distinto a `ALLOWED_ORIGIN` |
| `429` | Superaste `RATE_LIMIT`; espera un minuto |
| `502 No se pudo guardar en Garage` | Garage caído o credenciales S3 distintas a las del compose (revisa `docker compose logs garage`) |

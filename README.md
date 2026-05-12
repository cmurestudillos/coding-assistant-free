# Coding Assistant Free

Asistente de programación de escritorio 100% gratuito y local. Sin APIs de pago, sin conexión a internet requerida. Usa [Ollama](https://ollama.ai) como motor de IA para responder preguntas de código, analizar, optimizar, explicar y generar tests, con historial de conversaciones persistente.

## Características

- **Chat con IA local** — respuestas generadas por modelos de lenguaje corriendo en tu máquina
- **Análisis de código** — detecta automáticamente bloques de código en el mensaje
- **Acciones rápidas** — botones para optimizar, explicar, corregir errores y generar tests
- **Historial persistente** — conversaciones guardadas en SQLite con búsqueda y paginación
- **Selección de modelos** — cambia entre modelos Ollama con descarga automática
- **Manejo de errores** — reintentos automáticos con countdown en timeouts (máx. 3 intentos)

## Requisitos

- [Node.js](https://nodejs.org) 18+
- [pnpm](https://pnpm.io) 11+
- [Ollama](https://ollama.ai) instalado y corriendo

## Instalación

```bash
# Clonar el repositorio
git clone <repo-url>
cd coding-assistant-free

# Instalar dependencias
pnpm install

# Arrancar la aplicación
pnpm start
```

## Configurar Ollama

La app requiere que Ollama esté corriendo antes de usarla:

```bash
# Arrancar Ollama
ollama serve

# Descargar un modelo (en otra terminal)
ollama pull qwen2.5-coder:3b
```

Modelos soportados por defecto:

| Modelo | Descripción | Tamaño |
|--------|-------------|--------|
| `qwen2.5-coder:3b` | Especializado en código, recomendado | ~2 GB |
| `deepseek-coder:1.3b` | Ultra rápido, ideal para CPU lenta | ~1 GB |
| `llama3.2:3b` | Equilibrado, bueno para explicaciones | ~2 GB |

## Uso

1. Arranca Ollama (`ollama serve`)
2. Abre la aplicación (`pnpm start`)
3. Escribe tu pregunta o pega código en el área de texto
4. Usa los botones de acción rápida para tareas comunes:
   - **Optimizar** — mejora rendimiento y legibilidad
   - **Explicar** — explica el código paso a paso
   - **Corregir errores** — detecta bugs y malas prácticas
   - **Generar tests** — crea tests unitarios con Jest/Vitest

Para cambiar el modelo de IA, abre **Configuración** (⚙️) desde el header.

## Stack

- **Electron 38** — framework de escritorio
- **Ollama** — motor de IA local (REST en `localhost:11434`)
- **SQLite3** — persistencia de conversaciones y caché de docs
- **Axios** — cliente HTTP para llamadas a Ollama
- **Cheerio** — parsing HTML para scraping de documentación
- **pnpm 11** — gestor de paquetes

## Estructura del proyecto

```
coding-assistant-free/
├── main.js              # Proceso principal Electron — IPC handlers
├── preload.js           # Bridge seguro (contextBridge → window.electronAPI)
├── renderer.js          # Lógica de UI
├── index.html           # Interfaz HTML
├── styles.css           # Estilos
└── src/
    ├── ai-engine.js     # Integración con Ollama (generate, analyzeCode, optimizeCode…)
    ├── database.js      # SQLite: conversaciones, mensajes, caché de docs
    ├── scraper.js       # Scraping de documentación oficial (MDN, React, etc.)
    ├── docs-sources.js  # Configuración de fuentes de documentación
    └── assets/          # Iconos multiplataforma
```

## Empaquetado

```bash
pnpm package:win    # Windows (.exe)
pnpm package:mac    # macOS (.dmg)
pnpm package:linux  # Linux (AppImage)
```

Los artefactos se generan en `release/`.

## Licencia

MIT — Carlos
